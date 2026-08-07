
import apiClient from '../api/client';
import { haptic, speakStatus } from './feedbackService';

const PING_INTERVAL_MS    = 5000;
const PING_TIMEOUT_MS     = 4000;
const THRESHOLD_YELLOW    = 150;
const THRESHOLD_ORANGE    = 200;
const THRESHOLD_RED       = 250;
const RED_CONSECUTIVE     = 3;
const RECOVER_CONSECUTIVE = 2;
const DEGRADED_CONSECUTIVE = 2;

let _intervalId        = null;
let _currentStatus     = 'idle';
let _lastPingRtt       = null;
let _announcedYellow   = false;
let _announcedOrange   = false;
let _failStreak        = 0;
let _recoverStreak     = 0;
let _degradedStreak    = 0;
let _onStatusChange    = null;
let _onDisconnect      = null;
let _onReconnect       = null;

export function startHealthWatch({ onStatusChange, onDisconnect, onReconnect } = {}) {
  stopHealthWatch();

  _onStatusChange  = onStatusChange ?? null;
  _onDisconnect    = onDisconnect   ?? null;
  _onReconnect     = onReconnect    ?? null;
  _currentStatus   = 'green';
  _announcedYellow = false;
  _announcedOrange = false;
  _failStreak      = 0;
  _recoverStreak   = 0;
  _degradedStreak  = 0;

  _ping();
  _intervalId = setInterval(_ping, PING_INTERVAL_MS);
}

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

export function getHealthStatus() {
  return _currentStatus;
}

export function getLastPingRtt() {
  return _lastPingRtt;
}


async function _ping() {
  const t0 = performance.now();

  try {
    await apiClient.get('/health', { timeout: PING_TIMEOUT_MS });
    const rtt = Math.round(performance.now() - t0);
    _lastPingRtt = rtt;

    _handleRtt(rtt);
  } catch {
    _lastPingRtt = null;
    _handleRtt(Infinity);
  }
}

const _statusFor = (rtt) =>
  rtt >= THRESHOLD_ORANGE ? 'orange'
  : rtt >= THRESHOLD_YELLOW ? 'yellow'
  : 'green';

const STATE_PHRASE = {
  green:  'החיבור יציב',
  yellow: 'החיבור לא יציב',
  orange: 'החיבור חלש מאוד',
};

function _handleRtt(rtt) {
  const wasRed = _currentStatus === 'red';

  if (rtt >= THRESHOLD_YELLOW) _degradedStreak++;
  else _degradedStreak = 0;

  if (rtt >= THRESHOLD_RED) {
    _recoverStreak = 0;
    _failStreak++;

    if (wasRed) {
      return;
    }

    if (_failStreak >= RED_CONSECUTIVE) {
      _setStatus('red', rtt === Infinity ? null : rtt);
      haptic('danger');
      speakStatus('החיבור אבד');
      _onDisconnect?.();
    } else {
      _setStatus('orange', rtt === Infinity ? null : rtt);
      if (_degradedStreak >= DEGRADED_CONSECUTIVE && !_announcedOrange) {
        _announcedOrange = true;
        haptic('detection');
        speakStatus('החיבור חלש מאוד, מומלץ לעבור למקום עם קליטה טובה יותר');
      }
    }

  } else {
    _failStreak = 0;

    if (wasRed) {
      _recoverStreak++;

      if (_recoverStreak >= RECOVER_CONSECUTIVE) {
        _recoverStreak = 0;
        const status = _statusFor(rtt);
        _announcedYellow = status === 'yellow';
        _announcedOrange = status === 'orange';
        _setStatus(status, rtt);
        haptic('aligned');
        speakStatus(`החיבור חזר, ${STATE_PHRASE[status]}`);
        _onReconnect?.();
      }
      return;
    }

    _recoverStreak = 0;

    if (rtt >= THRESHOLD_ORANGE) {
      _setStatus('orange', rtt);
      if (_degradedStreak >= DEGRADED_CONSECUTIVE && !_announcedOrange) {
        _announcedOrange = true;
        haptic('detection');
        speakStatus('החיבור חלש מאוד, מומלץ לעבור למקום עם קליטה טובה יותר');
      }
    } else if (rtt >= THRESHOLD_YELLOW) {
      _setStatus('yellow', rtt);
      _announcedOrange = false;
      if (_degradedStreak >= DEGRADED_CONSECUTIVE && !_announcedYellow) {
        _announcedYellow = true;
        haptic('detection');
        speakStatus('החיבור לא יציב');
      }
    } else {
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