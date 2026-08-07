
const FB_KEY        = 'seesense_feedback';
const DEFAULT_VOLUME = 0.8;

const DEFAULT_FB = {
  volume_intensity:    0.8,
  vibration_intensity: 0.8,
  alert_type:          'both',
  voice_gender:        'default',
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
  try { localStorage.setItem(FB_KEY, JSON.stringify(_fb)); } catch {  }
};

const _notify = () => _subs.forEach((fn) => { try { fn({ ..._fb }); } catch {  } });

export const getFeedbackSettings = () => ({ ..._fb });

export const subscribeFeedback = (fn) => {
  _subs.add(fn);
  return () => _subs.delete(fn);
};

export const setFeedbackSettings = (patch) => {
  _fb = { ..._fb, ...patch };
  _persistLocal();
  _notify();
  return { ..._fb };
};

export const seedFeedbackSettings = (dbSettings = {}) => {
  const patch = {};
  for (const k of Object.keys(DEFAULT_FB)) {
    if (dbSettings?.[k] !== undefined) patch[k] = dbSettings[k];
  }
  return setFeedbackSettings(patch);
};

const _audioEnabled  = () => _fb.alert_type !== 'haptic' && _fb.volume_intensity > 0;
const _hapticEnabled = () => _fb.alert_type !== 'audio'  && _fb.vibration_intensity > 0;

export const isMuted = () => !_audioEnabled();

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

const PATTERNS = {
  start:     [60, 30, 60],
  stop:      [80],
  aligned:   [30],
  detection: [100, 50, 100],
  danger:    [200, 100, 200, 100, 400],
};

export const isVibrationSupported = () =>
  typeof navigator !== 'undefined' && 'vibrate' in navigator;

const HAPTIC_COOLDOWN_MS = 2000;
const ALERT_PATTERNS     = new Set(['danger', 'detection']);
let   lastHapticAt       = 0;

export const haptic = (name) => {
  if (!_hapticEnabled() || !navigator.vibrate) return;
  const base = PATTERNS[name];
  if (!base) return;

  if (ALERT_PATTERNS.has(name)) {
    const now = Date.now();
    if (now - lastHapticAt < HAPTIC_COOLDOWN_MS) return;
    lastHapticAt = now;
  }

  const scale = _fb.vibration_intensity;
  const pattern = base.map((ms, i) =>
    i % 2 === 0 ? Math.max(1, Math.round(ms * scale)) : ms
  );
  navigator.vibrate(pattern);
};


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
  scooter:       'קורקינט',
  curb:          'אבן שפה',
  trash_can:     'פח אשפה',
  manhole:       'מכסה ביוב',
  construction:  'אתר בנייה',
};

let _voices = [];
const _refreshVoices = () => { _voices = window.speechSynthesis?.getVoices?.() ?? []; };

if (typeof window !== 'undefined' && window.speechSynthesis) {
  _refreshVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', _refreshVoices);
}

const _hebrewVoices = () =>
  _voices.filter((v) => (v.lang || '').toLowerCase().startsWith('he'));

export const getVoiceInfo = () => {
  const he = _hebrewVoices();
  return { hebrewVoiceCount: he.length, canChooseGender: he.length > 1 };
};

const FEMALE_HINTS = ['carmit', 'female', 'woman', 'נקבה', 'אישה'];
const MALE_HINTS   = ['asaf', 'male', 'man', 'זכר', 'גבר'];

const _pickVoice = () => {
  const he = _hebrewVoices();
  if (he.length === 0) return null;

  const g = _fb.voice_gender;
  if (g === 'default') return he[0];

  const want = g === 'female' ? FEMALE_HINTS : MALE_HINTS;
  const anti = g === 'female' ? MALE_HINTS   : FEMALE_HINTS;

  const match = he.find((v) => want.some((h) => (v.name || '').toLowerCase().includes(h)));
  if (match) return match;

  const notOpposite = he.find((v) => !anti.some((h) => (v.name || '').toLowerCase().includes(h)));
  return notOpposite || he[0];
};

const COOLDOWN_MS    = 3000;
let   lastClassName  = null;
let   lastAnnounceAt = 0;
let   lastSpeakAt    = 0;

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

export const speakMessage = (text, { priority = false } = {}) => {
  if (!_audioEnabled() || !window.speechSynthesis || !text) return;
  const now = Date.now();
  if (!priority && now - lastSpeakAt < COOLDOWN_MS) return;
  lastSpeakAt = now;
  _speak(text);
};

export const speakStatus = (text) => {
  if (!_audioEnabled() || !window.speechSynthesis || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang   = 'he-IL';
  u.volume = _fb.volume_intensity;
  u.rate   = 1.1;
  const voice = _pickVoice();
  if (voice) u.voice = voice;
  window.speechSynthesis.speak(u);
};

export const previewVoice = (text = 'שלום') => {
  if (!_audioEnabled() || !window.speechSynthesis) return;
  _speak(text);
};

const TTS_SOUND = '\u05e9\u05b6\u05c1\u05de\u05b7\u05e2';
const TTS_OFF   = '\u05db\u05b8\u05bc\u05d1\u05d5\u05bc\u05d9';
const TTS_ON    = '\u05d3\u05b8\u05bc\u05dc\u05d5\u05bc\u05e7';

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

const DIRECTION_LABELS = {
  left:  'מצד שמאל',
  right: 'מצד ימין',
  center: 'לפניך',
};

export const dangerPhrase = (objects) => {
  const top       = Array.isArray(objects) ? objects[0] : null;
  const className = top?.class_name || top?.label;
  if (!className) return 'סכנה קרובה';

  const name     = HEBREW_NAMES[className] || className;
  const dirLabel = DIRECTION_LABELS[top?.position] ?? '';
  return `סכנה קרובה, ${dirLabel ? `${name} ${dirLabel}` : name}`;
};

export const staticPhrase = (className, position) => {
  const name = HEBREW_NAMES[className] || className;
  const dir  = DIRECTION_LABELS[position] ?? DIRECTION_LABELS.center;
  return `${name} ${dir}, אין תנועה`;
};

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
  const dirLabel = DIRECTION_LABELS[topObj?.position] ?? '';
  const body     = dirLabel ? `${name} ${dirLabel}` : name;
  const text     = isDanger ? `סכנה! ${body}` : body;

  _speak(text);
};
