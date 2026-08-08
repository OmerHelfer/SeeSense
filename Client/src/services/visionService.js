
import { getInputSize, getMaxInflight, applyStreamConfig } from '../config/streamConfig';
import { getClientStageReport } from './clientMetrics';
import { getLastPingRtt } from './healthService';

const API_URL = import.meta.env.VITE_API_URL ?? '';
const WS_BASE = API_URL
  ? API_URL
      .replace(/\/$/, '')
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://')
  : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

const RECONNECT_DELAY_MS     = 3000;
const MAX_RECONNECT_ATTEMPTS = 5;
const RTT_REPORT_INTERVAL_MS = 5000;
const MAX_PENDING_RTT        = 120;
const MAX_INFLIGHT_MS        = 3000;

const FPS_WINDOW_MS   = 3000;
const MAX_RESULT_TIMES = 120;

const FPS_MIN_SPAN_MS = 400;

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
  constructor({ onResult, onError, onConnected } = {}) {
    this._onResult    = onResult    ?? (() => {});
    this._onError     = onError     ?? (() => {});
    this._onConnected = onConnected ?? (() => {});

    this._socket            = null;
    this._token             = null;
    this._active            = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer    = null;

    this._sendTimes         = [];

    this._captureTimes      = [];

    this._rttBuffer         = [];
    this._rttReportTimer    = null;
    this._lastRtt           = null;
    this._rttStats          = { avg: 0, min: 0, max: 0 };


    this._e2eBuffer         = [];
    this._pendingE2EStart   = null;
    this._e2eStats          = { avg: 0, min: 0, max: 0 };

    this._frameSendTimes    = [];
    this._resultTimes       = [];

    this._lostCount         = 0;
    this._lostReported      = 0;
  }

  get lostCount() {
    return this._lostCount;
  }

  connect(token) {
    this._token             = token;
    this._active            = true;
    this._reconnectAttempts = 0;
    this._rttBuffer         = [];
    this._e2eBuffer         = [];
    this._pendingE2EStart   = null;
    this._resultTimes       = [];
    this._open();
  }

  disconnect() {
    this._active = false;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._rttReportTimer);
    if (this._socket) {
      this._socket.close(1000, 'Client disconnect');
      this._socket = null;
    }
  }

  get isOpen() {
    return this._socket?.readyState === WebSocket.OPEN;
  }

  get lastRtt() {
    return this._lastRtt;
  }

  get rttStats() {
    return { ...this._rttStats };
  }

  get e2eStats() {
    return { ...this._e2eStats };
  }

  get clientFps() {
    return _rateWithin(this._frameSendTimes);
  }

  get serverFps() {
    return _rateWithin(this._resultTimes);
  }

  get canSend() {
    const now = performance.now();
    while (this._sendTimes.length && now - this._sendTimes[0] > MAX_INFLIGHT_MS) {
      this._sendTimes.shift();
      this._captureTimes.shift();
      this._lostCount += 1;
    }
    return this._sendTimes.length < Math.max(1, getMaxInflight());
  }

  sendFrame(blob, captureT0 = null) {
    if (this.isOpen) {
      const now = performance.now();
      this._sendTimes.push(now);

      this._captureTimes.push(captureT0 ?? now);
      if (this._sendTimes.length > MAX_PENDING_RTT) {
        this._sendTimes.shift();
        this._captureTimes.shift();
      }
      this._frameSendTimes.push(now);
      if (this._frameSendTimes.length > 30) this._frameSendTimes.shift();
      this._socket.send(blob);
    }
  }


  _open() {
    if (!this._active) return;


    const url    = `${WS_BASE}/stream/ws?token=${encodeURIComponent(this._token)}&input_size=${getInputSize()}`;
    const socket = new WebSocket(url);
    socket.binaryType = 'blob';
    this._socket = socket;

    socket.onopen = () => {
      this._reconnectAttempts = 0;
      this._startRttReporting();
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'connected') {
          applyStreamConfig(msg);
          this._onConnected(msg);
        } else if (msg.type === 'result') {
          this._recordRtt();
          this._onResult(msg);
        } else if (msg.type === 'error') {
          this._recordRtt();
          this._onError(new Error(msg.detail ?? 'Server processing error'));
        }
      } catch {
      }
    };

    socket.onerror = () => {
      this._onError(new Error('WebSocket connection error'));
    };

    socket.onclose = (event) => {
      this._socket = null;
      clearInterval(this._rttReportTimer);

      if (event.code !== 1000) this._lostCount += this._sendTimes.length;
      this._sendTimes = [];
      this._captureTimes = [];
      this._pendingE2EStart = null;

      if (event.code === 4001 || event.code === 4003) {
        this._active = false;
        import('./sessionExpiry').then(({ notifySessionExpired }) => notifySessionExpired());
        return;
      }

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

  _recordRtt() {
    const now = performance.now();
    this._resultTimes.push(now);
    if (this._resultTimes.length > MAX_RESULT_TIMES) this._resultTimes.shift();

    const captured = this._captureTimes.shift();
    this._pendingE2EStart = captured ?? null;

    const sent = this._sendTimes.shift();
    if (sent === undefined) return;
    const rtt = now - sent;
    this._lastRtt = Math.round(rtt * 10) / 10;
    this._rttBuffer.push(this._lastRtt);
    if (this._rttBuffer.length > 50) this._rttBuffer.shift();
    this._updateRttStats();
  }

  
  completeE2E() {
    const started = this._pendingE2EStart;
    this._pendingE2EStart = null;
    if (started == null) return;

    const e2e = performance.now() - started;
    if (!(e2e >= 0) || e2e > 60000) return;

    this._e2eBuffer.push(Math.round(e2e * 10) / 10);
    if (this._e2eBuffer.length > 50) this._e2eBuffer.shift();

    const sum = this._e2eBuffer.reduce((a, b) => a + b, 0);
    this._e2eStats = {
      avg: Math.round(sum / this._e2eBuffer.length),
      min: Math.round(Math.min(...this._e2eBuffer)),
      max: Math.round(Math.max(...this._e2eBuffer)),
    };
  }

  _updateRttStats() {
    if (this._rttBuffer.length === 0) return;
    const sum = this._rttBuffer.reduce((a, b) => a + b, 0);
    this._rttStats = {
      avg: Math.round(sum / this._rttBuffer.length),
      min: Math.round(Math.min(...this._rttBuffer)),
      max: Math.round(Math.max(...this._rttBuffer)),
    };
  }

  _startRttReporting() {
    clearInterval(this._rttReportTimer);
    this._rttReportTimer = setInterval(() => {
      if (!this.isOpen) return;

      if (this._rttBuffer.length > 0) {
        const avg = this._rttBuffer.reduce((a, b) => a + b, 0) / this._rttBuffer.length;
        const base = getLastPingRtt();
        try {
          this._socket.send(JSON.stringify({
            type: 'rtt_report',
            rtt_ms: Math.round(avg * 10) / 10,
            ...(base != null ? { base_rtt_ms: base } : {}),
          }));
        } catch {  }
      }

      if (this._e2eBuffer.length > 0) {
        const sum = this._e2eBuffer.reduce((a, b) => a + b, 0);
        try {
          this._socket.send(JSON.stringify({
            type: 'e2e_report',
            e2e_ms:     Math.round((sum / this._e2eBuffer.length) * 10) / 10,
            e2e_min_ms: Math.round(Math.min(...this._e2eBuffer) * 10) / 10,
            e2e_max_ms: Math.round(Math.max(...this._e2eBuffer) * 10) / 10,
          }));
        } catch {  }
      }

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
          } catch {  }
        }
      }

      if (this._lostCount > this._lostReported) {
        const lost = this._lostCount - this._lostReported;
        try {
          this._socket.send(JSON.stringify({ type: 'lost_report', lost }));
          this._lostReported = this._lostCount;
        } catch {  }
      }

      const stages = getClientStageReport();
      if (Object.keys(stages).length > 0) {
        try {
          this._socket.send(JSON.stringify({ type: 'client_stage_report', stages }));
        } catch {  }
      }
    }, RTT_REPORT_INTERVAL_MS);
  }
}

let _activeStream = null;

export const setActiveStream = (stream) => { _activeStream = stream; };
export const disconnectStream = () => {
  _activeStream?.disconnect();
  _activeStream = null;
};

export const getActiveStreamRtt = () => _activeStream?.rttStats ?? null;
export const getActiveStreamE2E = () => _activeStream?.e2eStats ?? null;