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

// Derive the WebSocket base URL from the Vite env var.
// http:// → ws://   |   https:// → wss://
const WS_BASE = (import.meta.env.VITE_API_URL ?? '')
  .replace(/\/$/, '')
  .replace(/^https:\/\//, 'wss://')
  .replace(/^http:\/\//, 'ws://');

const RECONNECT_DELAY_MS     = 3000;
const MAX_RECONNECT_ATTEMPTS = 5;
const RTT_REPORT_INTERVAL_MS = 5000; // report avg RTT to server every 5s
const MAX_PENDING_RTT        = 120;  // cap the RTT-pairing FIFO so a lost result can't grow it forever
const MAX_INFLIGHT_MS        = 3000; // treat an unanswered frame as lost after this (unblock sending)

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
  }

  /** Open the WebSocket connection and begin the session. */
  connect(token) {
    this._token             = token;
    this._active            = true;
    this._reconnectAttempts = 0;
    this._rttBuffer         = [];
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
   * Bounded-depth backpressure gate: may we send another frame right now?
   * True while fewer than MAX_INFLIGHT frames are awaiting a result, so at most
   * MAX_INFLIGHT are ever in flight and the queue stays bounded. In-flight entries
   * older than MAX_INFLIGHT_MS (a lost result) are pruned so drops can't wedge it.
   */
  get canSend() {
    const now = performance.now();
    while (this._sendTimes.length && now - this._sendTimes[0] > MAX_INFLIGHT_MS) {
      this._sendTimes.shift();
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
    const sent = this._sendTimes.shift();
    if (sent === undefined) return;
    const rtt = performance.now() - sent;
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

      // Send RTT average
      if (this._rttBuffer.length > 0) {
        const avg = this._rttBuffer.reduce((a, b) => a + b, 0) / this._rttBuffer.length;
        try {
          this._socket.send(JSON.stringify({
            type: 'rtt_report',
            rtt_ms: Math.round(avg * 10) / 10
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