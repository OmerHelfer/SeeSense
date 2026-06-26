/**
 * healthService.js
 * Client-side Health Watchdog — monitors connection quality to the server.
 *
 * Pings GET /health every PING_INTERVAL_MS and measures RTT.
 * Four levels:
 *   - GREEN   (< 250ms)      → connection healthy, no feedback
 *   - YELLOW  (250-400ms)    → "החיבור לא יציב" (spoken once)
 *   - ORANGE  (400-600ms)    → "החיבור חלש מאוד, מומלץ לעבור למקום עם קליטה טובה יותר" (spoken once)
 *   - RED     (600ms+ × 3 consecutive) → disconnect + "החיבור אבד, הסריקה הופסקה"
 *
 * Recovery: 2 consecutive pings below 300ms → reconnect + "החיבור חזר, הסריקה ממשיכה"
 */

import apiClient from '../api/client';
import { haptic, speakMessage } from './feedbackService';

// ── Configuration ────────────────────────────────────────
const PING_INTERVAL_MS    = 5000;   // ping every 5 seconds
const PING_TIMEOUT_MS     = 4000;   // give up after 4s
const THRESHOLD_YELLOW    = 250;    // ms — unstable warning
const THRESHOLD_ORANGE    = 400;    // ms — severe warning
const THRESHOLD_RED       = 600;    // ms — disconnect threshold
const RED_CONSECUTIVE     = 3;      // pings above 600ms before disconnect
const RECOVER_CONSECUTIVE = 2;      // pings below 600ms before reconnect

// ── State ────────────────────────────────────────────────
let _intervalId        = null;
let _currentStatus     = 'idle';    // 'idle' | 'green' | 'yellow' | 'orange' | 'red'
let _lastPingRtt       = null;
let _announcedYellow   = false;     // only announce once until it recovers
let _announcedOrange   = false;     // only announce once until it recovers
let _failStreak        = 0;         // consecutive pings >= 600ms
let _recoverStreak     = 0;         // consecutive pings < 600ms (while in red)
let _onStatusChange    = null;      // callback: (status, rtt) => void
let _onDisconnect      = null;      // callback: () => void  — called on RED
let _onReconnect       = null;      // callback: () => void  — called when RED clears

/**
 * Start the health watchdog.
 * @param {object} options
 * @param {Function} options.onStatusChange  (status, rtt) => void
 * @param {Function} options.onDisconnect    () => void — called when entering RED
 * @param {Function} options.onReconnect     () => void — called when RED clears
 */
export function startHealthWatch({ onStatusChange, onDisconnect, onReconnect } = {}) {
  stopHealthWatch(); // clear any previous watcher

  _onStatusChange  = onStatusChange ?? null;
  _onDisconnect    = onDisconnect   ?? null;
  _onReconnect     = onReconnect    ?? null;
  _currentStatus   = 'green';
  _announcedYellow = false;
  _announcedOrange = false;
  _failStreak      = 0;
  _recoverStreak   = 0;

  // Ping immediately on start, then every interval
  _ping();
  _intervalId = setInterval(_ping, PING_INTERVAL_MS);
}

/** Stop the health watchdog. */
export function stopHealthWatch() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
  _currentStatus   = 'idle';
  _lastPingRtt     = null;
  _announcedYellow = false;
  _announcedOrange = false;
  _failStreak      = 0;
  _recoverStreak   = 0;
}

/** Current health status: 'idle' | 'green' | 'yellow' | 'orange' | 'red' */
export function getHealthStatus() {
  return _currentStatus;
}

/** Last measured ping RTT in ms (or null). */
export function getLastPingRtt() {
  return _lastPingRtt;
}

// ── Internal ─────────────────────────────────────────────

async function _ping() {
  const t0 = performance.now();

  try {
    await apiClient.get('/health', { timeout: PING_TIMEOUT_MS });
    const rtt = Math.round(performance.now() - t0);
    _lastPingRtt = rtt;

    _handleRtt(rtt);
  } catch {
    // Timeout or network error — treat as 600ms+
    _lastPingRtt = null;
    _handleRtt(Infinity);
  }
}

function _handleRtt(rtt) {
  const wasRed = _currentStatus === 'red';

  if (rtt >= THRESHOLD_RED) {
    // ── Above 300ms ──
    _recoverStreak = 0;
    _failStreak++;

    if (wasRed) {
      // Already disconnected — stay red
      return;
    }

    if (_failStreak >= RED_CONSECUTIVE) {
      // 3 consecutive fails → RED — disconnect
      _setStatus('red', rtt === Infinity ? null : rtt);
      haptic('danger');
      speakMessage('החיבור אבד, הסריקה הופסקה');
      _onDisconnect?.();
    } else {
      // Not yet 3 — show orange warning
      _setStatus('orange', rtt === Infinity ? null : rtt);
      if (!_announcedOrange) {
        _announcedOrange = true;
        haptic('detection');
        speakMessage('החיבור חלש מאוד, מומלץ לעבור למקום עם קליטה טובה יותר');
      }
    }

  } else {
    // ── Below 300ms ──
    _failStreak = 0;

    if (wasRed) {
      // Currently disconnected — count recovery streak
      _recoverStreak++;

      if (_recoverStreak >= RECOVER_CONSECUTIVE) {
        // 2 consecutive good pings → reconnect
        _recoverStreak = 0;
        _announcedYellow = false;
        _announcedOrange = false;
        _setStatus('green', rtt);
        haptic('aligned');
        speakMessage('החיבור חזר, הסריקה ממשיכה');
        _onReconnect?.();
      }
      // Still recovering — stay red visually
      return;
    }

    // ── Normal operation (not red) ──
    _recoverStreak = 0;

    if (rtt >= THRESHOLD_ORANGE) {
      // 400-600ms — orange warning
      _setStatus('orange', rtt);
      if (!_announcedOrange) {
        _announcedOrange = true;
        haptic('detection');
        speakMessage('החיבור חלש מאוד, מומלץ לעבור למקום עם קליטה טובה יותר');
      }
    } else if (rtt >= THRESHOLD_YELLOW) {
      // 250-400ms — yellow warning
      _setStatus('yellow', rtt);
      _announcedOrange = false;
      if (!_announcedYellow) {
        _announcedYellow = true;
        haptic('detection');
        speakMessage('החיבור לא יציב');
      }
    } else {
      // < 250ms — green
      _setStatus('green', rtt);
      _announcedYellow = false;
      _announcedOrange = false;
    }
  }
}

function _setStatus(status, rtt) {
  _currentStatus = status;
  _onStatusChange?.(status, rtt);
}