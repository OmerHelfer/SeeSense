/**
 * VisionStream — WebSocket-based real-time frame analysis client.
 *
 * Replaces the legacy REST POST /inference/analyze_frame.
 *
 * Usage:
 *   const stream = new VisionStream({ onResult, onError, onConnected });
 *   stream.connect(jwtToken);
 *   stream.sendFrame(blob);   // raw JPEG Blob
 *   stream.disconnect();
 */

// Derive the WebSocket base URL from the Vite env var.
// http:// → ws://   |   https:// → wss://
const WS_BASE = (import.meta.env.VITE_API_URL ?? '')
  .replace(/\/$/, '')
  .replace(/^https:\/\//, 'wss://')
  .replace(/^http:\/\//, 'ws://');

const RECONNECT_DELAY_MS     = 3000;
const MAX_RECONNECT_ATTEMPTS = 5;

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
  }

  /** Open the WebSocket connection and begin the session. */
  connect(token) {
    this._token             = token;
    this._active            = true;
    this._reconnectAttempts = 0;
    this._open();
  }

  /** Gracefully close the stream — no auto-reconnect will follow. */
  disconnect() {
    this._active = false;
    clearTimeout(this._reconnectTimer);
    if (this._socket) {
      this._socket.close(1000, 'Client disconnect');
      this._socket = null;
    }
  }

  /** True when the underlying WebSocket is in the OPEN state. */
  get isOpen() {
    return this._socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Send a raw JPEG Blob to the server for analysis.
   * Silently dropped if the socket is not OPEN.
   * @param {Blob} blob  JPEG image blob
   */
  sendFrame(blob) {
    if (this.isOpen) {
      this._socket.send(blob);
    }
  }

  // ── Private ─────────────────────────────────────────────────────────

  _open() {
    if (!this._active) return;

    const url    = `${WS_BASE}/stream/ws?token=${encodeURIComponent(this._token)}`;
    const socket = new WebSocket(url);
    socket.binaryType = 'blob'; // we only send binary; server responses are text JSON
    this._socket = socket;

    socket.onopen = () => {
      this._reconnectAttempts = 0;
      // Server sends { type: "connected" } as the first text message
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'connected') {
          this._onConnected(msg);
        } else if (msg.type === 'result') {
          this._onResult(msg);
        } else if (msg.type === 'error') {
          this._onError(new Error(msg.detail ?? 'Server processing error'));
        }
      } catch {
        // Non-JSON frame (unexpected) — ignore silently
      }
    };

    socket.onerror = () => {
      // onerror fires before onclose; the reconnect is handled in onclose
      this._onError(new Error('WebSocket connection error'));
    };

    socket.onclose = (event) => {
      this._socket = null;
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
}

// Module-level reference for logout cleanup
let _activeStream = null;

export const setActiveStream = (stream) => { _activeStream = stream; };
export const disconnectStream = () => {
  _activeStream?.disconnect();
  _activeStream = null;
};