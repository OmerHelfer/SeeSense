/**
 * healthService.js
 * Client-side Health Watchdog — monitors connection quality to the server.
 *
 * Pings GET /health every PING_INTERVAL_MS and measures RTT.
 * Four levels (the DOT changes immediately at each threshold):
 *   - GREEN   (< THRESHOLD_YELLOW)
 *   - YELLOW  (THRESHOLD_YELLOW..ORANGE)
 *   - ORANGE  (THRESHOLD_ORANGE..RED)
 *   - RED     (>= THRESHOLD_RED × RED_CONSECUTIVE)
 *
 * The VOICE is deliberately slower than the dot. Every spoken line here has to
 * earn itself, because this app talks to someone who cannot look at the screen
 * to double-check it:
 *   - a degraded link is announced only after DEGRADED_CONSECUTIVE pings agree,
 *     so a single slow ping says nothing at all;
 *   - each state is announced once, not repeated while it persists;
 *   - recovery is announced only if a problem was actually announced first;
 *   - "back" always names what it came back TO ("החיבור חזר, החיבור חלש מאוד"),
 *     because recovering to a barely-alive link is not good news.
 *
 * Messages queue (speakStatus) rather than cancel each other, so an ordered pair
 * is always heard in order. Danger alerts still interrupt — that is the correct
 * priority.
 */

import apiClient from '../api/client';
import { haptic, speakStatus } from './feedbackService';

// ── Configuration ────────────────────────────────────────
const PING_INTERVAL_MS    = 5000;   // ping every 5 seconds
const PING_TIMEOUT_MS     = 4000;   // give up after 4s
const THRESHOLD_YELLOW    = 100;    // ms — unstable warning
const THRESHOLD_ORANGE    = 150;    // ms — severe warning
const THRESHOLD_RED       = 200;    // ms — disconnect threshold
const RED_CONSECUTIVE     = 3;      // pings above THRESHOLD_RED before disconnect
const RECOVER_CONSECUTIVE = 2;      // pings below THRESHOLD_RED before reconnect
const DEGRADED_CONSECUTIVE = 2;     // pings in a row before SAYING the link degraded

// ── State ────────────────────────────────────────────────
let _intervalId        = null;
let _currentStatus     = 'idle';    // 'idle' | 'green' | 'yellow' | 'orange' | 'red'
let _lastPingRtt       = null;
let _announcedYellow   = false;     // only announce once until it recovers
let _announcedOrange   = false;     // only announce once until it recovers
let _failStreak        = 0;         // consecutive pings at/above THRESHOLD_RED
let _recoverStreak     = 0;         // consecutive pings below THRESHOLD_RED (while in red)
let _degradedStreak    = 0;         // consecutive pings at/above THRESHOLD_YELLOW
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
  _degradedStreak  = 0;

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
  _degradedStreak  = 0;
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
    // Timeout or network error — treat as infinitely slow
    _lastPingRtt = null;
    _handleRtt(Infinity);
  }
}

/** Link quality for an RTT already known to be below THRESHOLD_RED. */
const _statusFor = (rtt) =>
  rtt >= THRESHOLD_ORANGE ? 'orange'
  : rtt >= THRESHOLD_YELLOW ? 'yellow'
  : 'green';

// What the link is doing right now, in Hebrew. Used on its own when a degraded
// link recovers, and appended after "החיבור חזר" when coming back from a loss —
// so "back" is never announced without saying what it came back TO.
const STATE_PHRASE = {
  green:  'החיבור יציב',
  yellow: 'החיבור לא יציב',
  orange: 'החיבור חלש מאוד',
};

function _handleRtt(rtt) {
  const wasRed = _currentStatus === 'red';

  // Count consecutive non-green pings BEFORE any decision below. A single slow
  // ping is normal on a mobile link and must stay silent: without this, one blip
  // announced "החיבור חלש מאוד" and then "החיבור יציב" five seconds later, over
  // and over. The coloured dot still reacts instantly — only the VOICE waits for
  // the link to prove the problem is real, because a voice that cries wolf every
  // ten seconds is one the user learns to ignore.
  if (rtt >= THRESHOLD_YELLOW) _degradedStreak++;
  else _degradedStreak = 0;

  if (rtt >= THRESHOLD_RED) {
    // ── At or above THRESHOLD_RED ──
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
      // Says only what is true. The old text was "החיבור אבד, הסריקה הופסקה", but
      // nothing here stops the scan — Dashboard's onDisconnect only logs, and the
      // WebSocket keeps sending. Telling a blind user their scan stopped while it
      // is still running is the worst possible direction for that error.
      speakStatus('החיבור אבד');
      _onDisconnect?.();
    } else {
      // Not yet 3 — show orange warning
      _setStatus('orange', rtt === Infinity ? null : rtt);
      if (_degradedStreak >= DEGRADED_CONSECUTIVE && !_announcedOrange) {
        _announcedOrange = true;
        haptic('detection');
        speakStatus('החיבור חלש מאוד, מומלץ לעבור למקום עם קליטה טובה יותר');
      }
    }

  } else {
    // ── Below THRESHOLD_RED ──
    _failStreak = 0;

    if (wasRed) {
      // Currently disconnected — count recovery streak
      _recoverStreak++;

      if (_recoverStreak >= RECOVER_CONSECUTIVE) {
        // 2 consecutive good pings → reconnect. "Recovered" is not the same as
        // "healthy": below THRESHOLD_RED still spans stable, unstable and very
        // weak, and the old code announced green regardless. Report what it came
        // back to, so a link that returns barely alive doesn't sound fine.
        _recoverStreak = 0;
        const status = _statusFor(rtt);
        // Treat the degraded state as already announced — the sentence below
        // names it, so the yellow/orange branch must not repeat it a ping later.
        _announcedYellow = status === 'yellow';
        _announcedOrange = status === 'orange';
        _setStatus(status, rtt);
        haptic('aligned');
        speakStatus(`החיבור חזר, ${STATE_PHRASE[status]}`);
        _onReconnect?.();
      }
      // Still recovering — stay red visually
      return;
    }

    // ── Normal operation (not red) ──
    _recoverStreak = 0;

    if (rtt >= THRESHOLD_ORANGE) {
      // At/above THRESHOLD_ORANGE — very weak
      _setStatus('orange', rtt);
      if (_degradedStreak >= DEGRADED_CONSECUTIVE && !_announcedOrange) {
        _announcedOrange = true;
        haptic('detection');
        speakStatus('החיבור חלש מאוד, מומלץ לעבור למקום עם קליטה טובה יותר');
      }
    } else if (rtt >= THRESHOLD_YELLOW) {
      // At/above THRESHOLD_YELLOW — unstable
      _setStatus('yellow', rtt);
      _announcedOrange = false;
      if (_degradedStreak >= DEGRADED_CONSECUTIVE && !_announcedYellow) {
        _announcedYellow = true;
        haptic('detection');
        speakStatus('החיבור לא יציב');
      }
    } else {
      // Below THRESHOLD_YELLOW — green. Announced ONLY as a recovery: the user was told the link
      // had degraded, so they are owed the all-clear. Without the flag check this
      // would say "החיבור יציב" on every good ping forever.
      const wasDegraded = _announcedYellow || _announcedOrange;
      _setStatus('green', rtt);
      _announcedYellow = false;
      _announcedOrange = false;
      if (wasDegraded) {
        haptic('aligned');
        speakStatus('החיבור יציב');
      }
    }
  }
}

function _setStatus(status, rtt) {
  _currentStatus = status;
  _onStatusChange?.(status, rtt);
}