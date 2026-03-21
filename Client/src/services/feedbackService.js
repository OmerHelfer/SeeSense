/* ═══════════════════════════════════════════════════
   feedbackService.js
   Haptic + audio (Web Speech API) feedback helpers.
   ═══════════════════════════════════════════════════ */

// ── Haptic patterns (milliseconds) ──────────────────
const PATTERNS = {
  start:     [60, 30, 60],              // double pulse  → scanning started
  stop:      [80],                      // single pulse  → scanning stopped
  aligned:   [30],                      // tiny tick     → device is now aligned
  detection: [100, 50, 100],            // double alert  → low-level object detected
  danger:    [200, 100, 200, 100, 400], // strong burst  → high-danger object nearby
};

/**
 * Trigger a named vibration pattern (silently ignored if not supported).
 * @param {'start'|'stop'|'aligned'|'detection'|'danger'} name
 */
export const haptic = (name) => {
  const pattern = PATTERNS[name];
  if (pattern && navigator.vibrate) navigator.vibrate(pattern);
};

// ── Audio: Web Speech API ────────────────────────────

/** Hebrew names for detected object classes returned by the backend. */
const HEBREW_NAMES = {
  person:        'אדם',
  car:           'מכונית',
  bicycle:       'אופניים',
  motorcycle:    'אופנוע',
  bench:         'ספסל',
  fire_hydrant:  'ברז כיבוי אש',
  traffic_light: 'רמזור',
  stairs:        'מדרגות',
  pole:          'עמוד',
  dog:           'כלב',
};

// Throttle: don't re-announce the same class within this window
const COOLDOWN_MS    = 3000;
let   lastClassName  = null;
let   lastAnnounceAt = 0;

/**
 * Speak the most prominent detected object in Hebrew.
 * Throttled per class to prevent speech spam.
 *
 * @param {Array<{class_name?: string, label?: string}>} objects
 */
export const announceDetections = (objects) => {
  if (!window.speechSynthesis || !Array.isArray(objects) || objects.length === 0) return;

  // Take the first (highest-confidence) object
  const topObj      = objects[0];
  const className   = topObj?.class_name || topObj?.label;
  if (!className) return;

  const now = Date.now();
  if (className === lastClassName && now - lastAnnounceAt < COOLDOWN_MS) return;

  lastClassName  = className;
  lastAnnounceAt = now;

  const text      = HEBREW_NAMES[className] || className;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang   = 'he-IL';
  utterance.volume = 1;
  utterance.rate   = 1.1;

  window.speechSynthesis.cancel(); // stop any ongoing speech
  window.speechSynthesis.speak(utterance);
};
