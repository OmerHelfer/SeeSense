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
export const HEBREW_NAMES = {
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
  bollard:       'עמוד חסימה',
  crosswalk:     'מעבר חצייה',
  pothole:       'בור בכביש',
  scooter:       'קורקינט',
};

// Throttle: don't re-announce within this window
const COOLDOWN_MS    = 3000;
let   lastClassName  = null;
let   lastAnnounceAt = 0;
let   lastSpeakAt    = 0;

/**
 * Speak an arbitrary text string (e.g. backend's pre-composed alert_message).
 * Throttled by COOLDOWN_MS to prevent speech spam.
 * @param {string} text
 */
export const speakMessage = (text) => {
  if (!window.speechSynthesis || !text) return;
  const now = Date.now();
  if (now - lastSpeakAt < COOLDOWN_MS) return;
  lastSpeakAt = now;
  const utterance  = new SpeechSynthesisUtterance(text);
  utterance.lang   = 'he-IL';
  utterance.volume = 1;
  utterance.rate   = 1.1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
};

/** Hebrew direction suffixes — appended after the object name. */
const DIRECTION_LABELS = {
  left:  'מצד שמאל',
  right: 'מצד ימין',
  center: "ממול"
};

/**
 * Speak the most prominent detected object in Hebrew, including direction.
 * Examples: "סכנה! מכונית מצד ימין", "אדם מצד שמאל", "כלב"
 *
 * @param {Array<{class_name?: string, label?: string, motion?: {direction?: string}}>} objects
 * @param {boolean} isDanger — true for high-risk alerts (prepends "סכנה!")
 */
export const announceDetections = (objects, isDanger = false) => {
  if (!window.speechSynthesis || !Array.isArray(objects) || objects.length === 0) return;

  const topObj    = objects[0];
  const className = topObj?.class_name || topObj?.label;
  if (!className) return;

  const now = Date.now();
  if (className === lastClassName && now - lastAnnounceAt < COOLDOWN_MS) return;

  lastClassName  = className;
  lastAnnounceAt = now;

  const name     = HEBREW_NAMES[className] || className;
  const dirLabel = DIRECTION_LABELS[topObj?.motion?.direction] ?? '';
  const body     = dirLabel ? `${name} ${dirLabel}` : name;
  const text     = isDanger ? `סכנה! ${body}` : body;

  const utterance  = new SpeechSynthesisUtterance(text);
  utterance.lang   = 'he-IL';
  utterance.volume = 1;
  utterance.rate   = 1.1;

  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
};