/**
 * VisionStream — WebSocket-based real-time frame analysis client.
 *
 * Features:
 *   - Binary frame streaming with per-frame RTT measurement
 *   - Periodic RTT reporting back to the server
 *   - Auto-reconnect on unexpected disconnection
 *
 * Usage:
 *   const stream = new VisionStream({ onResult, onError, onConnected });
 *   stream.connect(jwtToken);
 *   stream.sendFrame(blob);   // raw JPEG Blob
 *   stream.disconnect();
 */

import { INPUT_SIZE, MAX_INFLIGHT } from '../config/streamConfig';
import { getClientStageReport } from './clientMetrics';
import { getLastPingRtt } from './healthService';

// Derive the WebSocket base URL from the Vite env var.
// http:// → ws://   |   https:// → wss://
// Unset (single-service deploy, where the server also serves this build) falls
// back to the page's own origin, so nothing about the host is baked into the
// bundle and the same build works over any IP or hostname it's reached by.
const API_URL = import.meta.env.VITE_API_URL ?? '';
const WS_BASE = API_URL
  ? API_URL
      .replace(/\/$/, '')
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://')
  : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

const RECONNECT_DELAY_MS     = 3000;
const MAX_RECONNECT_ATTEMPTS = 5;
const RTT_REPORT_INTERVAL_MS = 5000; // report avg RTT to server every 5s
const MAX_PENDING_RTT        = 120;  // cap the RTT-pairing FIFO so a lost result can't grow it forever
const MAX_INFLIGHT_MS        = 3000; // treat an unanswered frame as lost after this (unblock sending)

// ── Live FPS readout (admin overlay on the camera page) ──
// Only events from the last FPS_WINDOW_MS count, so the number decays instead of
// freezing on its last value when the stream stalls or stops.
const FPS_WINDOW_MS   = 3000;
const MAX_RESULT_TIMES = 120; // 3s of headroom at 40 FPS

// Below this the sample is too short to divide by — the readout stays blank for
// the first fraction of a second rather than printing a wild number.
const FPS_MIN_SPAN_MS = 400;

/**
 * Rate (per second) of the timestamps in `times` that fall inside the window.
 *
 * Measured as events ÷ (now − first event in window), so the right edge of the
 * measurement is the present moment, not the last event. That matters: a stream
 * that freezes mid-session keeps a full window of recent-looking timestamps, and
 * dividing by the span BETWEEN them would keep reporting the old healthy rate
 * through the whole freeze. Anchoring to `now` makes the number fall as the
 * silence grows — which is the one moment this readout has to be trusted.
 *
 * Non-destructive: the caller's array is left alone, because `_frameSendTimes` is
 * also the source for the periodic fps_report to the server and that reading must
 * keep its own (count-bounded) semantics.
 */
const _rateWithin = (times) => {
  const now    = performance.now();
  const cutoff = now - FPS_WINDOW_MS;
  let i = 0;
  while (i < times.length && times[i] < cutoff) i++;
  const n = times.length - i;
  if (n < 1) return null;
  const span = now - times[i];
  if (span < FPS_MIN_SPAN_MS) return null;
  return Math.round((n / span) * 1000 * 10) / 10;
};

export class VisionStream {
  /**
   * @param {{ onResult: Function, onError: Function, onConnected: Function }} callbacks
   */
  constructor({ onResult, onError, onConnected } = {}) {
    this._onResult    = onResult    ?? (() => {});
    this._onError     = onError     ?? (() => {});
    this._onConnected = onConnected ?? (() => {});

    this._socket            = null;
    this._token             = null;
    this._active            = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer    = null;

    // ── Bounded-depth backpressure ──
    // Up to MAX_INFLIGHT frames may be in flight (sent, awaiting a result) at
    // once — see `canSend`. Depth 1 caps throughput at 1/RTT even when the server
    // is idle; a small depth fills the network pipe so throughput ≈ depth/RTT,
    // while each frame's latency stays ~one RTT. It's bounded, so the queue can't
    // run away like fire-and-forget. _sendTimes is a FIFO of send timestamps used
    // to pair results for RTT (results arrive in send order).
    this._sendTimes         = [];     // FIFO of performance.now() for sent-but-unanswered frames

    // ── RTT measurement ──
    this._rttBuffer         = [];     // recent RTT measurements (for averaging)
    this._rttReportTimer    = null;   // interval for periodic reporting
    this._lastRtt           = null;   // most recent single RTT value
    this._rttStats          = { avg: 0, min: 0, max: 0 }; // rolling stats

    // ── Client FPS tracking ──
    this._frameSendTimes    = [];     // timestamps of last 30 sends
    this._resultTimes       = [];     // timestamps of recent results (server output rate)

    // ── Lost frames ──
    // A frame that was sent and never answered. Over TCP this should be ~0: data
    // is not silently dropped, so the only real causes are a socket that broke
    // with frames still in flight, or a server that stalled past MAX_INFLIGHT_MS.
    // That rarity is the point — any non-zero value here is genuine news.
    // Cumulative for the session; what goes to the server is the delta.
    this._lostCount         = 0;
    this._lostReported      = 0;
  }

  /** Frames sent that never received a reply, for this session. */
  get lostCount() {
    return this._lostCount;
  }

  /** Open the WebSocket connection and begin the session. */
  connect(token) {
    this._token             = token;
    this._active            = true;
    this._reconnectAttempts = 0;
    this._rttBuffer         = [];
    this._resultTimes       = [];
    this._open();
  }

  /** Gracefully close the stream — no auto-reconnect will follow. */
  disconnect() {
    this._active = false;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._rttReportTimer);
    if (this._socket) {
      this._socket.close(1000, 'Client disconnect');
      this._socket = null;
    }
  }

  /** True when the underlying WebSocket is in the OPEN state. */
  get isOpen() {
    return this._socket?.readyState === WebSocket.OPEN;
  }

  /** Most recent RTT measurement in ms (or null if none yet). */
  get lastRtt() {
    return this._lastRtt;
  }

  /** Rolling RTT stats: { avg, min, max } in ms. */
  get rttStats() {
    return { ...this._rttStats };
  }

  /**
   * Frames per second this client is SENDING right now (null until measurable).
   * Capped by the capture tick and by MAX_INFLIGHT backpressure.
   */
  get clientFps() {
    return _rateWithin(this._frameSendTimes);
  }

  /**
   * Frames per second the SERVER is actually returning right now (null until
   * measurable). Measured from result arrivals here rather than asked of the
   * server: in steady state a bounded-depth pipeline returns exactly as many
   * frames as it finishes, so this is the server's real throughput for THIS
   * session — and it costs nothing, whereas polling the admin status endpoint
   * would add load to the very thing it claims to measure.
   */
  get serverFps() {
    return _rateWithin(this._resultTimes);
  }

  /**
   * Bounded-depth backpressure gate: may we send another frame right now?
   * True while fewer than MAX_INFLIGHT frames are awaiting a result, so at most
   * MAX_INFLIGHT are ever in flight and the queue stays bounded. In-flight entries
   * older than MAX_INFLIGHT_MS (a lost result) are pruned so drops can't wedge it.
   */
  get canSend() {
    const now = performance.now();
    // Anything still unanswered after MAX_INFLIGHT_MS is never coming back — this
    // prune is the exact moment a frame becomes provably lost, so it is also
    // where the loss is counted.
    while (this._sendTimes.length && now - this._sendTimes[0] > MAX_INFLIGHT_MS) {
      this._sendTimes.shift();
      this._lostCount += 1;
    }
    return this._sendTimes.length < Math.max(1, MAX_INFLIGHT);
  }

  /**
   * Send a raw JPEG Blob to the server for analysis.
   * Records send timestamp for RTT measurement.
   * @param {Blob} blob  JPEG image blob
   */
  sendFrame(blob) {
    if (this.isOpen) {
      const now = performance.now();
      // Enqueue send time for RTT pairing; cap the FIFO so a missing result
      // (no response for a frame) can't make it grow without bound.
      this._sendTimes.push(now);
      if (this._sendTimes.length > MAX_PENDING_RTT) this._sendTimes.shift();
      // Track recent send timestamps for FPS calculation
      this._frameSendTimes.push(now);
      if (this._frameSendTimes.length > 30) this._frameSendTimes.shift();
      this._socket.send(blob);
    }
  }

  // ── Private ─────────────────────────────────────────────────────────

  _open() {
    if (!this._active) return;

    // input_size is a request; the server clamps it and reports the size it
    // actually used in the 'connected' message (see onConnected).
    const url    = `${WS_BASE}/stream/ws?token=${encodeURIComponent(this._token)}&input_size=${INPUT_SIZE}`;
    const socket = new WebSocket(url);
    socket.binaryType = 'blob'; // we only send binary; server responses are text JSON
    this._socket = socket;

    socket.onopen = () => {
      this._reconnectAttempts = 0;
      this._startRttReporting();
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'connected') {
          this._onConnected(msg);
        } else if (msg.type === 'result') {
          this._recordRtt();
          this._onResult(msg);
        } else if (msg.type === 'error') {
          this._recordRtt();   // frame is done (rejected) — pair + clear its FIFO entry
          this._onError(new Error(msg.detail ?? 'Server processing error'));
        }
      } catch {
        // Non-JSON frame (unexpected) — ignore silently
      }
    };

    socket.onerror = () => {
      this._onError(new Error('WebSocket connection error'));
    };

    socket.onclose = (event) => {
      this._socket = null;
      clearInterval(this._rttReportTimer);

      // Frames still in flight when the socket dies will never be answered.
      // Counted only on an UNEXPECTED close: on a clean stop the user chose to
      // end the session, and charging ~MAX_INFLIGHT losses every time they press
      // stop would keep this counter permanently non-zero and destroy its whole
      // value, which is that zero is the normal reading.
      if (event.code !== 1000) this._lostCount += this._sendTimes.length;
      this._sendTimes = [];

      // 4001 = missing token, 4003 = invalid/expired token (see api/stream.py).
      // Reconnecting would just replay the same dead token forever, so end the
      // session instead — the app then redirects to /login.
      if (event.code === 4001 || event.code === 4003) {
        this._active = false;
        import('./sessionExpiry').then(({ notifySessionExpired }) => notifySessionExpired());
        return;
      }

      // Only reconnect on unexpected closure (code !== 1000)
      if (this._active && event.code !== 1000) {
        this._scheduleReconnect();
      }
    };
  }

  _scheduleReconnect() {
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this._onError(new Error('WebSocket: max reconnect attempts reached'));
      this._active = false;
      return;
    }
    this._reconnectAttempts++;
    this._reconnectTimer = setTimeout(() => this._open(), RECONNECT_DELAY_MS);
  }

  /** Pair an incoming result with the oldest unanswered frame and record its RTT. */
  _recordRtt() {
    const now = performance.now();
    // Every answered frame — success or rejection — is one the server finished,
    // so both count towards its output rate.
    this._resultTimes.push(now);
    if (this._resultTimes.length > MAX_RESULT_TIMES) this._resultTimes.shift();

    const sent = this._sendTimes.shift();
    if (sent === undefined) return;
    const rtt = now - sent;
    this._lastRtt = Math.round(rtt * 10) / 10;
    this._rttBuffer.push(this._lastRtt);
    if (this._rttBuffer.length > 50) this._rttBuffer.shift();
    this._updateRttStats();
  }

  /** Compute rolling avg/min/max from the RTT buffer. */
  _updateRttStats() {
    if (this._rttBuffer.length === 0) return;
    const sum = this._rttBuffer.reduce((a, b) => a + b, 0);
    this._rttStats = {
      avg: Math.round(sum / this._rttBuffer.length),
      min: Math.round(Math.min(...this._rttBuffer)),
      max: Math.round(Math.max(...this._rttBuffer)),
    };
  }

  /** Send average RTT and capture FPS to server every 5 seconds. */
  _startRttReporting() {
    clearInterval(this._rttReportTimer);
    this._rttReportTimer = setInterval(() => {
      if (!this.isOpen) return;

      // Send RTT average, plus the health watchdog's tiny-payload ping RTT.
      // The two together are what let the server split the frame round trip into
      // an outbound leg (which carries the JPEG) and a return leg (a small JSON):
      // a ping with nothing to transmit is essentially propagation only.
      if (this._rttBuffer.length > 0) {
        const avg = this._rttBuffer.reduce((a, b) => a + b, 0) / this._rttBuffer.length;
        const base = getLastPingRtt();
        try {
          this._socket.send(JSON.stringify({
            type: 'rtt_report',
            rtt_ms: Math.round(avg * 10) / 10,
            ...(base != null ? { base_rtt_ms: base } : {}),
          }));
        } catch { /* socket closed mid-send */ }
      }

      // Send actual capture FPS — based on last 30 send timestamps
      if (this._frameSendTimes.length >= 2) {
        const span = this._frameSendTimes[this._frameSendTimes.length - 1]
                   - this._frameSendTimes[0];
        if (span > 0) {
          const fps = ((this._frameSendTimes.length - 1) / span) * 1000;
          try {
            this._socket.send(JSON.stringify({
              type: 'fps_report',
              fps: Math.round(fps * 100) / 100
            }));
          } catch { /* socket closed */ }
        }
      }

      // Frames sent that never came back. A DELTA since the last report, not a
      // running total: the server simply adds it, so it needs no per-connection
      // state and a reconnect can't double-count or go backwards.
      if (this._lostCount > this._lostReported) {
        const lost = this._lostCount - this._lostReported;
        try {
          this._socket.send(JSON.stringify({ type: 'lost_report', lost }));
          this._lostReported = this._lostCount;
        } catch { /* socket closed — retry on the next tick */ }
      }

      // Send client-side stage breakdown (capture/encode/render/feedback) so the
      // admin dashboard can show where the client's own per-frame time goes. One
      // small message every 5s — no hot-path cost.
      const stages = getClientStageReport();
      if (Object.keys(stages).length > 0) {
        try {
          this._socket.send(JSON.stringify({ type: 'client_stage_report', stages }));
        } catch { /* socket closed */ }
      }
    }, RTT_REPORT_INTERVAL_MS);
  }
}

// Module-level reference for logout cleanup
let _activeStream = null;

export const setActiveStream = (stream) => { _activeStream = stream; };
export const disconnectStream = () => {
  _activeStream?.disconnect();
  _activeStream = null;
};

/** Get current RTT stats from the active stream (if any). */
export const getActiveStreamRtt = () => _activeStream?.rttStats ?? null;