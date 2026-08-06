/* ═══════════════════════════════════════════════════
   feedbackService.js
   Haptic + audio (Web Speech API) feedback helpers.

   Single runtime source-of-truth for the user's feedback
   preferences (volume / vibration / alert channel / voice).
   The DB is the durable store; this module mirrors it in
   localStorage so the values are available instantly and
   are actually APPLIED when producing sound / vibration.
   ═══════════════════════════════════════════════════ */

// ── Runtime feedback settings store ──────────────────
const FB_KEY        = 'seesense_feedback';
const DEFAULT_VOLUME = 0.8;

// Keys mirrored from the server settings document.
const DEFAULT_FB = {
  volume_intensity:    0.8,
  vibration_intensity: 0.8,
  alert_type:          'both',    // 'audio' | 'haptic' | 'both'
  voice_gender:        'default', // 'female' | 'male' | 'default'
};

const _loadFb = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(FB_KEY));
    return { ...DEFAULT_FB, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...DEFAULT_FB };
  }
};

let _fb = _loadFb();
const _subs = new Set();

const _persistLocal = () => {
  try { localStorage.setItem(FB_KEY, JSON.stringify(_fb)); } catch { /* quota */ }
};

const _notify = () => _subs.forEach((fn) => { try { fn({ ..._fb }); } catch { /* ignore */ } });

/** Current runtime feedback settings (a copy). */
export const getFeedbackSettings = () => ({ ..._fb });

/** Subscribe to store changes. Returns an unsubscribe function. */
export const subscribeFeedback = (fn) => {
  _subs.add(fn);
  return () => _subs.delete(fn);
};

/**
 * Merge a patch into the runtime store (localStorage + notify subscribers).
 * Does NOT persist to the DB — the caller (with a userId) is responsible for that.
 */
export const setFeedbackSettings = (patch) => {
  _fb = { ..._fb, ...patch };
  _persistLocal();
  _notify();
  return { ..._fb };
};

/** Seed the store from a DB settings object (e.g. after login / getSettings). */
export const seedFeedbackSettings = (dbSettings = {}) => {
  const patch = {};
  for (const k of Object.keys(DEFAULT_FB)) {
    if (dbSettings?.[k] !== undefined) patch[k] = dbSettings[k];
  }
  return setFeedbackSettings(patch);
};

// ── Channel gates ────────────────────────────────────
const _audioEnabled  = () => _fb.alert_type !== 'haptic' && _fb.volume_intensity > 0;
const _hapticEnabled = () => _fb.alert_type !== 'audio'  && _fb.vibration_intensity > 0;

// ── Mute (derived from volume) ───────────────────────
// "Muted" ⇔ the audio channel produces no sound.
export const isMuted = () => !_audioEnabled();

/**
 * Set the mute state via the volume channel.
 *  - mute   → volume 0
 *  - unmute → volume back to default; if audio was disabled by a
 *             haptic-only alert_type, switch to 'both' so it's audible.
 * Runtime only — persist to the DB from the calling component.
 */
export const setMuted = (value) => {
  if (value) {
    setFeedbackSettings({ volume_intensity: 0 });
    window.speechSynthesis?.cancel();
  } else {
    const patch = { volume_intensity: DEFAULT_VOLUME };
    if (_fb.alert_type === 'haptic') patch.alert_type = 'both';
    setFeedbackSettings(patch);
  }
  return isMuted();
};

export const toggleMuted = () => setMuted(!isMuted());

// ── Haptic patterns (milliseconds) ──────────────────
const PATTERNS = {
  start:     [60, 30, 60],              // double pulse  → scanning started
  stop:      [80],                      // single pulse  → scanning stopped
  aligned:   [30],                      // tiny tick     → device is now aligned
  detection: [100, 50, 100],            // double alert  → low-level object detected
  danger:    [200, 100, 200, 100, 400], // strong burst  → high-danger object nearby
};

/** True when the browser exposes the Vibration API (false on iOS Safari/Chrome). */
export const isVibrationSupported = () =>
  typeof navigator !== 'undefined' && 'vibrate' in navigator;

// Rate limit for ALERT patterns only. Voice is throttled by COOLDOWN_MS below,
// but vibration had no backstop of its own — it fired on every `alert_is_new`,
// so any server-side dedup false positive buzzed the phone continuously. UI ticks
// (start/stop/aligned) are direct responses to a user action and stay immediate.
const HAPTIC_COOLDOWN_MS = 2000;
const ALERT_PATTERNS     = new Set(['danger', 'detection']);
let   lastHapticAt       = 0;

/**
 * Trigger a named vibration pattern.
 * Gated by alert_type + vibration_intensity. The Web Vibration API can't change
 * amplitude, only duration — so intensity scales the vibrating-pulse durations.
 * Alert patterns are additionally rate-limited (HAPTIC_COOLDOWN_MS).
 * Silently ignored where unsupported (e.g. iOS).
 * @param {'start'|'stop'|'aligned'|'detection'|'danger'} name
 */
export const haptic = (name) => {
  if (!_hapticEnabled() || !navigator.vibrate) return;
  const base = PATTERNS[name];
  if (!base) return;

  if (ALERT_PATTERNS.has(name)) {
    const now = Date.now();
    if (now - lastHapticAt < HAPTIC_COOLDOWN_MS) return;
    lastHapticAt = now;
  }

  const scale = _fb.vibration_intensity; // 0..1
  // Even indices = vibrate durations (scaled); odd indices = pauses (kept).
  const pattern = base.map((ms, i) =>
    i % 2 === 0 ? Math.max(1, Math.round(ms * scale)) : ms
  );
  navigator.vibrate(pattern);
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

// ── Voice selection ──────────────────────────────────
// The list of TTS voices loads asynchronously in most browsers, so we cache it
// and refresh on the `voiceschanged` event.
let _voices = [];
const _refreshVoices = () => { _voices = window.speechSynthesis?.getVoices?.() ?? []; };

if (typeof window !== 'undefined' && window.speechSynthesis) {
  _refreshVoices();
  // addEventListener is more robust than assigning onvoiceschanged
  window.speechSynthesis.addEventListener?.('voiceschanged', _refreshVoices);
}

const _hebrewVoices = () =>
  _voices.filter((v) => (v.lang || '').toLowerCase().startsWith('he'));

/** Info for the settings UI — how many Hebrew voices this device exposes. */
export const getVoiceInfo = () => {
  const he = _hebrewVoices();
  return { hebrewVoiceCount: he.length, canChooseGender: he.length > 1 };
};

const FEMALE_HINTS = ['carmit', 'female', 'woman', 'נקבה', 'אישה'];
const MALE_HINTS   = ['asaf', 'male', 'man', 'זכר', 'גבר'];

/** Best-effort pick of a Hebrew voice matching the requested gender. */
const _pickVoice = () => {
  const he = _hebrewVoices();
  if (he.length === 0) return null;

  const g = _fb.voice_gender;
  if (g === 'default') return he[0];

  const want = g === 'female' ? FEMALE_HINTS : MALE_HINTS;
  const anti = g === 'female' ? MALE_HINTS   : FEMALE_HINTS;

  // 1. A voice whose name matches the wanted gender.
  const match = he.find((v) => want.some((h) => (v.name || '').toLowerCase().includes(h)));
  if (match) return match;

  // 2. Otherwise avoid the opposite gender if we can.
  const notOpposite = he.find((v) => !anti.some((h) => (v.name || '').toLowerCase().includes(h)));
  return notOpposite || he[0];
};

// Throttle: don't re-announce within this window
const COOLDOWN_MS    = 3000;
let   lastClassName  = null;
let   lastAnnounceAt = 0;
let   lastSpeakAt    = 0;

/** Build + speak an utterance at the current volume / voice. */
const _speak = (text) => {
  const utterance  = new SpeechSynthesisUtterance(text);
  utterance.lang   = 'he-IL';
  utterance.volume = _fb.volume_intensity;
  utterance.rate   = 1.1;
  const voice = _pickVoice();
  if (voice) utterance.voice = voice;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
};

/**
 * Speak an arbitrary text string (e.g. backend's pre-composed alert_message).
 * Gated by the audio channel and throttled by COOLDOWN_MS.
 * @param {string} text
 */
export const speakMessage = (text, { priority = false } = {}) => {
  if (!_audioEnabled() || !window.speechSynthesis || !text) return;
  const now = Date.now();
  // `priority` is for messages the CALLER already rate-limits and whose meaning
  // is a state change the user must not miss. Without it the 3s cooldown ate
  // exactly the two that matter most: the danger warning repeats every 2s, so it
  // re-armed the cooldown before it expired, and the "נתיב פנוי" that followed
  // within 3s of the last warning was dropped silently — the user heard the
  // danger start and never heard it end, which is the report that led here.
  if (!priority && now - lastSpeakAt < COOLDOWN_MS) return;
  lastSpeakAt = now;
  _speak(text);
};

/**
 * Speak a connection-lifecycle message WITHOUT cutting off what is already being
 * said — it queues behind it instead.
 *
 * These messages come in ordered pairs that only make sense together
 * ("מתחבר" → "התחבר בהצלחה", "החיבור אבד" → "החיבור חזר, ..."), and both existing
 * mechanisms destroyed exactly that: the 3s cooldown in speakMessage DROPPED the
 * second one (connecting takes ~300ms, well inside the window), and the cancel()
 * inside _speak would have cut the first one off mid-word.
 *
 * The Web Speech API already queues utterances, so the fix is simply not to clear
 * the queue. Alerts still go through _speak and still cancel — a danger warning
 * outranking a status update is the correct priority, not a bug.
 */
export const speakStatus = (text) => {
  if (!_audioEnabled() || !window.speechSynthesis || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang   = 'he-IL';
  u.volume = _fb.volume_intensity;
  u.rate   = 1.1;
  const voice = _pickVoice();
  if (voice) u.voice = voice;
  window.speechSynthesis.speak(u);   // deliberately no cancel()
};

/**
 * Speak a short sample so the user can hear the selected voice/volume.
 * Bypasses the cooldown but still respects the audio channel gate.
 */
export const previewVoice = (text = 'שלום') => {
  if (!_audioEnabled() || !window.speechSynthesis) return;
  _speak(text);
};

/* ── Mute announcement, vowelled ──────────────────────
   Hebrew is normally written without vowels, so the engine has to GUESS how to
   read a word: unvowelled שמע can be read shema / shama / sema, and it was
   picking a sin instead of a shin and coming out as "sam". Writing the words
   with niqqud removes the guess — שֶׁמַע can only be read "she-MA", with the same
   "sh" as in Sharon. This matters more than it looks: for a blind user the
   spoken word IS the interface.

   Written as \u escapes on purpose. The vowel marks are combining characters —
   invisible as separate glyphs in most editors — so pasting or retyping this
   line would silently strip them and quietly bring the mispronunciation back.
   The escapes are in Unicode canonical (NFC) order. */
const TTS_SOUND = '\u05e9\u05b6\u05c1\u05de\u05b7\u05e2';  // שֶׁמַע  — she-MA (sound)
const TTS_OFF   = '\u05db\u05b8\u05bc\u05d1\u05d5\u05bc\u05d9';  // כָּבוּי  — ka-VUI (off)
const TTS_ON    = '\u05d3\u05b8\u05bc\u05dc\u05d5\u05bc\u05e7';  // דָּלוּק  — da-LUK (on)

/**
 * Speak the sound on/off state when the user toggles mute.
 * Bypasses the audio gate + cooldown so it is still heard when muting.
 */
export const announceMute = (mutedNow) => {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(`${TTS_SOUND} ${mutedNow ? TTS_OFF : TTS_ON}`);
  u.lang   = 'he-IL';
  u.volume = 1;
  u.rate   = 1.1;
  const voice = _pickVoice();
  if (voice) u.voice = voice;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
};

/** Hebrew direction suffixes — appended after the object name. */
const DIRECTION_LABELS = {
  left:  'מצד שמאל',
  right: 'מצד ימין',
  center: 'לפניך',
};

/**
 * Compose the close-danger warning so it names WHAT the danger is.
 * A bare "סכנה קרובה" tells the user something is wrong but not what or where —
 * the one moment that information is worth the most. Position (not
 * motion.direction) for the same reason announceDetections uses it below.
 *
 *   "סכנה קרובה, מכונית לפניך"  — class and position both known
 *   "סכנה קרובה, מכונית"         — class known, position unknown
 *   "סכנה קרובה"                 — nothing identified at all
 */
export const dangerPhrase = (objects) => {
  const top       = Array.isArray(objects) ? objects[0] : null;
  const className = top?.class_name || top?.label;
  if (!className) return 'סכנה קרובה';

  const name     = HEBREW_NAMES[className] || className;
  const dirLabel = DIRECTION_LABELS[top?.position] ?? '';
  return `סכנה קרובה, ${dirLabel ? `${name} ${dirLabel}` : name}`;
};

/**
 * Speak the most prominent detected object in Hebrew, including direction.
 * Examples: "סכנה! מכונית מצד ימין", "אדם מצד שמאל", "כלב"
 *
 * @param {Array<{class_name?: string, label?: string, motion?: {direction?: string}}>} objects
 * @param {boolean} isDanger — true for high-risk alerts (prepends "סכנה!")
 */
export const announceDetections = (objects, isDanger = false) => {
  if (!_audioEnabled() || !window.speechSynthesis) return;
  if (!Array.isArray(objects) || objects.length === 0) return;

  const topObj    = objects[0];
  const className = topObj?.class_name || topObj?.label;
  if (!className) return;

  const now = Date.now();
  if (className === lastClassName && now - lastAnnounceAt < COOLDOWN_MS) return;

  lastClassName  = className;
  lastAnnounceAt = now;

  const name     = HEBREW_NAMES[className] || className;
  // `position` = WHERE the object is in the frame (left / center / right).
  // `motion.direction` = which way it is MOVING, which is a different question:
  // a car directly ahead drifting slightly rightwards has direction "right" while
  // sitting straight in front of you. Announcing that as "מצד ימין" sent the user
  // looking the wrong way, so the spoken location must come from `position`.
  const dirLabel = DIRECTION_LABELS[topObj?.position] ?? '';
  const body     = dirLabel ? `${name} ${dirLabel}` : name;
  const text     = isDanger ? `סכנה! ${body}` : body;

  _speak(text);
};
