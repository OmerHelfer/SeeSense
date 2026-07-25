import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ArrowRight, Save, RotateCcw, Target, Bell, User, Users, Clock, Activity, Flag, MessageSquare, CheckCircle, ChevronDown, AlertTriangle, Sliders } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  getSettings,
  updateSettings,
  resetSettings,
  getAvailableClasses,
} from '../services/settingsService';
import {
  setFeedbackSettings,
  seedFeedbackSettings,
  subscribeFeedback,
  getFeedbackSettings,
  getVoiceInfo,
  isVibrationSupported,
  previewVoice,
} from '../services/feedbackService';

// ── Hebrew labels + emoji for each detectable class ──────
const CLASS_META = {
  person:        { label: 'אדם',        emoji: '🧑' },
  car:           { label: 'מכונית',     emoji: '🚗' },
  bicycle:       { label: 'אופניים',    emoji: '🚲' },
  motorcycle:    { label: 'אופנוע',     emoji: '🏍️' },
  bench:         { label: 'ספסל',       emoji: '🪑' },
  fire_hydrant:  { label: 'ברז כיבוי',  emoji: '🚒' },
  traffic_light: { label: 'רמזור',      emoji: '🚦' },
  stairs:        { label: 'מדרגות',     emoji: '🪜' },
  pole:          { label: 'עמוד',       emoji: '🏛️' },
  dog:           { label: 'כלב',        emoji: '🐕' },
};

const pageVariants = {
  hidden:  { opacity: 0, x: 40 },
  visible: { opacity: 1, x: 0,  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, x: 40, transition: { duration: 0.22, ease: 'easeIn' } },
};

// ── Segmented control ──────────────────────────────────────
const SegControl = ({ options, value, onChange }) => (
  <div className="seg-control">
    {options.map((opt) => (
      <button
        key={opt.value}
        type="button"
        className={`seg-btn${value === opt.value ? ' active' : ''}`}
        onClick={() => onChange(opt.value)}
      >
        {opt.label}
      </button>
    ))}
  </div>
);

// ── Range slider with neon fill track ─────────────────────
const HudSlider = ({ label, emoji, value, onChange, disabled = false }) => (
  <div className={`slider-row${disabled ? ' disabled' : ''}`}>
    <div className="slider-header">
      <span className="slider-label">
        <span className="slider-emoji">{emoji}</span> {label}
      </span>
      <span className="slider-value">{Math.round(value * 100)}%</span>
    </div>
    <input
      type="range"
      min="0"
      max="1"
      step="0.05"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="hud-slider"
      style={{ '--fill': `${value * 100}%` }}
    />
  </div>
);

// ── Settings page ──────────────────────────────────────────
const Settings = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = user?.id ?? user?.user_id;

  const [settings, setSettings]             = useState(null);
  const [availableClasses, setAvailableClasses] = useState([]);
  const [loading, setLoading]               = useState(true);
  const [saving, setSaving]                 = useState(false);
  const [resetting, setResetting]           = useState(false);
  const [saveOk, setSaveOk]                 = useState(false);
  const [error, setError]                   = useState('');

  // ── Collapsible state ──
  const [scanOpen, setScanOpen] = useState(false);

  // ── Voice availability (async — voices load after page mount) ──
  const [voiceInfo, setVoiceInfo] = useState(getVoiceInfo());
  const vibrationSupported = isVibrationSupported();

  // ── Load settings + class list in parallel ──
  useEffect(() => {
    if (!userId) return;
    Promise.all([getSettings(userId), getAvailableClasses()])
      .then(([s, classes]) => {
        setSettings(s);
        seedFeedbackSettings(s);   // feed the shared runtime store
        setAvailableClasses(classes);
      })
      .catch(() => setError('לא ניתן לטעון הגדרות. בדוק חיבור ונסה שוב.'))
      .finally(() => setLoading(false));
  }, [userId]);

  // ── Keep the store-managed fields in sync with the shared store
  //    (e.g. the floating mute button toggling volume while this page is open). ──
  useEffect(() => subscribeFeedback((fb) => {
    setSettings((prev) => {
      if (!prev) return prev;
      if (prev.volume_intensity === fb.volume_intensity &&
          prev.vibration_intensity === fb.vibration_intensity &&
          prev.alert_type === fb.alert_type &&
          prev.voice_gender === fb.voice_gender) return prev; // no change → no re-render
      return {
        ...prev,
        volume_intensity:    fb.volume_intensity,
        vibration_intensity: fb.vibration_intensity,
        alert_type:          fb.alert_type,
        voice_gender:        fb.voice_gender,
      };
    });
  }), []);

  // ── Refresh voice availability once voices load ──
  useEffect(() => {
    const update = () => setVoiceInfo(getVoiceInfo());
    update();
    window.speechSynthesis?.addEventListener?.('voiceschanged', update);
    const t = setTimeout(update, 600);
    return () => {
      window.speechSynthesis?.removeEventListener?.('voiceschanged', update);
      clearTimeout(t);
    };
  }, []);

  // ── Toggle a class on/off in high_risk_classes ──
  const toggleClass = (cls) => {
    setSettings((prev) => {
      const current = prev.high_risk_classes ?? [];
      const next = current.includes(cls)
        ? current.filter((c) => c !== cls)
        : [...current, cls];
      return { ...prev, high_risk_classes: next };
    });
  };

  // ── Save ──
  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaveOk(false);
    try {
      const updated = await updateSettings(userId, {
        alert_type:            settings.alert_type,
        volume_intensity:      settings.volume_intensity,
        vibration_intensity:   settings.vibration_intensity,
        voice_gender:          settings.voice_gender,
        detection_sensitivity: settings.detection_sensitivity,
        high_risk_classes:     settings.high_risk_classes,
      });
      setSettings(updated);
      seedFeedbackSettings(updated);
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2500);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'שמירה נכשלה. נסה שוב.');
    } finally {
      setSaving(false);
    }
  };

  // ── Reset to defaults ──
  const handleReset = async () => {
    setResetting(true);
    setError('');
    try {
      const defaults = await resetSettings(userId);
      setSettings(defaults);
      seedFeedbackSettings(defaults);
    } catch {
      setError('איפוס נכשל. נסה שוב.');
    } finally {
      setResetting(false);
    }
  };

  const set = (key) => (val) =>
    setSettings((prev) => ({ ...prev, [key]: val }));

  // Store-managed fields: write through the shared store (the subscriber above
  // mirrors the change back into local `settings`), so the floating mute button
  // and the live runtime reflect it immediately.
  const setFb = (key) => (val) => setFeedbackSettings({ [key]: val });

  // Changing the alert channel forces the disabled channel to 0, and restores
  // any zeroed channel to a sensible default when re-enabling both.
  const handleAlertType = (next) => {
    const fb = getFeedbackSettings();
    const patch = { alert_type: next };
    if (next === 'audio')  patch.vibration_intensity = 0;
    if (next === 'haptic') patch.volume_intensity = 0;
    if (next === 'both') {
      if ((fb.volume_intensity ?? 0) === 0)    patch.volume_intensity = 0.8;
      if ((fb.vibration_intensity ?? 0) === 0) patch.vibration_intensity = 0.8;
    }
    setFeedbackSettings(patch);
  };

  const handleVoiceGender = (val) => {
    setFeedbackSettings({ voice_gender: val });
    previewVoice(); // let the user hear the selected voice immediately
  };

  const alertType   = settings?.alert_type ?? 'both';
  const audioOff    = alertType === 'haptic';   // volume slider disabled
  const hapticOff   = alertType === 'audio';    // vibration slider disabled

  const sensOptions = [
    { value: 'low',    label: 'נמוכה'   },
    { value: 'medium', label: 'בינונית' },
    { value: 'high',   label: 'גבוהה'   },
  ];

  const alertOptions = [
    { value: 'audio',  label: '🔊 שמע'  },
    { value: 'haptic', label: '📳 רטט'  },
    { value: 'both',   label: 'שניהם'   },
  ];

  const voiceOptions = [
    { value: 'female',  label: '👩 אישה'  },
    { value: 'male',    label: '👨 גבר'   },
    { value: 'default', label: 'ברירת מחדל' },
  ];

  return (
    <motion.div
      className="inner-page"
      variants={pageVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      {/* ── Header ── */}
      <header className="inner-page-header">
        <button className="back-btn" onClick={() => navigate('/')} aria-label="חזרה">
          <ArrowRight size={22} />
        </button>
        <span className="inner-page-title">הגדרות</span>
        <div style={{ width: 46 }} />
      </header>

      <div className="inner-page-body">

        {/* Error banner */}
        <AnimatePresence>
          {error && (
            <motion.div className="error-banner"
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}
            >{error}</motion.div>
          )}
        </AnimatePresence>

        {/* Success toast — centered on screen */}
        <AnimatePresence>
          {saveOk && (
            <motion.div className="save-toast-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
            >
              <motion.div className="save-toast"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: 0.25 }}
              >
                <span className="save-toast-icon">✓</span>
                <span>השינויים נשמרו בהצלחה</span>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ═══ כללי ═══ */}
        <p className="settings-category-header">כללי</p>

        <button className="nav-row-btn" onClick={() => navigate('/profile')}>
          <User size={18} />
          <span>פרופיל אישי</span>
          <ArrowRight size={16} className="nav-row-arrow" />
        </button>

        <button className="nav-row-btn" onClick={() => navigate('/sos-history')}>
          <AlertTriangle size={18} />
          <span>קריאות חירום</span>
          <ArrowRight size={16} className="nav-row-arrow" />
        </button>

        <button className="nav-row-btn" onClick={() => navigate('/history')}>
          <Clock size={18} />
          <span>היסטוריית זיהויים</span>
          <ArrowRight size={16} className="nav-row-arrow" />
        </button>

        {/* ── Scan settings: collapsible accordion ── */}
        <button
          className="nav-row-btn collapsible-toggle"
          onClick={() => setScanOpen((o) => !o)}
        >
          <Sliders size={18} />
          <span>הגדרות סריקה</span>
          <ChevronDown
            size={16}
            className="nav-row-arrow"
            style={{
              transform: scanOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.25s ease',
            }}
          />
        </button>

        <AnimatePresence initial={false}>
          {scanOpen && (
            <motion.div
              className="collapsible-body"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              style={{ overflow: 'hidden' }}
            >
              {loading ? (
                <div className="settings-loading">
                  <div className="settings-loading-dot" />
                  <span>טוען הגדרות...</span>
                </div>
              ) : settings && (
                <>
                  {/* ── Detection Sensitivity ── */}
                  <div className="glass-section">
                    <div className="section-label-row" style={{ marginBottom: 6 }}>
                      <Target size={15} />
                      <span className="section-label">רגישות זיהוי</span>
                    </div>
                    <p className="settings-desc">
                      גבוהה — מזהה עצמים גם ממרחק. נמוכה — מתריע רק על עצמים קרובים מאוד.
                    </p>
                    <SegControl
                      options={sensOptions}
                      value={settings.detection_sensitivity}
                      onChange={set('detection_sensitivity')}
                    />
                  </div>

                  {/* ── Alert Type ── */}
                  <div className="glass-section">
                    <div className="section-label-row" style={{ marginBottom: 6 }}>
                      <Bell size={15} />
                      <span className="section-label">סוג התראה</span>
                    </div>
                    <p className="settings-desc">
                      בחר כיצד SeeSense יתריע בזמן זיהוי עצם: קול, רטט או שניהם.
                    </p>
                    <SegControl
                      options={alertOptions}
                      value={settings.alert_type}
                      onChange={handleAlertType}
                    />
                  </div>

                  {/* ── Volume + Vibration ── */}
                  <div className="glass-section">
                    <div className="section-label-row" style={{ marginBottom: 18 }}>
                      <span className="section-label">עוצמת התראות</span>
                    </div>
                    <HudSlider
                      emoji="🔊"
                      label="עוצמת שמע"
                      value={settings.volume_intensity}
                      onChange={setFb('volume_intensity')}
                      disabled={audioOff}
                    />
                    <div className="slider-divider" />
                    <HudSlider
                      emoji="📳"
                      label="עוצמת רטט"
                      value={settings.vibration_intensity}
                      onChange={setFb('vibration_intensity')}
                      disabled={hapticOff}
                    />
                    {!vibrationSupported && !hapticOff && (
                      <p className="settings-note">
                        ⚠ הרטט אינו נתמך בדפדפן במכשיר זה (למשל iPhone). הרטט יעבוד באנדרואיד/אפליקציה.
                      </p>
                    )}
                  </div>

                  {/* ── Voice (TTS) ── */}
                  <div className="glass-section">
                    <div className="section-label-row" style={{ marginBottom: 6 }}>
                      <Bell size={15} />
                      <span className="section-label">קול ההתראה</span>
                    </div>
                    <p className="settings-desc">
                      בחר קול לדיבור ההתראות. הבחירה תושמע מיד לתצוגה מקדימה.
                    </p>
                    <SegControl
                      options={voiceOptions}
                      value={settings.voice_gender ?? 'default'}
                      onChange={handleVoiceGender}
                    />
                    {!voiceInfo.canChooseGender && (
                      <p className="settings-note">
                        במכשיר זה זוהה קול עברי אחד בלבד — ייתכן שבחירת המגדר לא תשמע שונה.
                      </p>
                    )}
                  </div>

                  {/* ── High-Risk Object Filter ── */}
                  <div className="glass-section">
                    <div className="section-label-row" style={{ marginBottom: 6 }}>
                      <span className="section-label">עצמים בסיכון גבוה</span>
                    </div>
                    <p className="settings-desc">
                      עצמים מסומנים יפעילו התראת חירום (רטט + קול). לא מסומנים — יזוהו אך לא יסומנו כסכנה.
                    </p>

                    <div className="class-grid">
                      {availableClasses.map((cls) => {
                        const meta   = CLASS_META[cls] ?? { label: cls, emoji: '●' };
                        const active = (settings.high_risk_classes ?? []).includes(cls);
                        return (
                          <button
                            key={cls}
                            type="button"
                            className={`class-chip${active ? ' active' : ''}`}
                            onClick={() => toggleClass(cls)}
                          >
                            <span className="class-emoji">{meta.emoji}</span>
                            <span>{meta.label}</span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Select all / none shortcuts */}
                    <div className="chip-shortcuts">
                      <button
                        type="button"
                        className="chip-shortcut-btn"
                        onClick={() => setSettings((s) => ({ ...s, high_risk_classes: [...availableClasses] }))}
                      >
                        בחר הכל
                      </button>
                      <button
                        type="button"
                        className="chip-shortcut-btn"
                        onClick={() => setSettings((s) => ({ ...s, high_risk_classes: [] }))}
                      >
                        נקה הכל
                      </button>
                    </div>
                  </div>

                  {/* ── Actions ── */}
                  <motion.button
                    className="auth-btn"
                    onClick={handleSave}
                    disabled={saving || resetting}
                    whileTap={{ scale: 0.97 }}
                  >
                    <Save size={20} />
                    {saving ? 'שומר...' : 'שמור שינויים'}
                  </motion.button>

                  <button
                    className="reset-btn"
                    onClick={handleReset}
                    disabled={saving || resetting}
                  >
                    <RotateCcw size={16} />
                    {resetting ? 'מאפס...' : 'שחזר ברירות מחדל'}
                  </button>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ═══ משוב ═══ */}
        <p className="settings-category-header">משוב</p>

        <button className="nav-row-btn" onClick={() => navigate('/feedback/general')}>
          <MessageSquare size={18} />
          <span>שלח משוב כללי</span>
          <ArrowRight size={16} className="nav-row-arrow" />
        </button>

        <button className="nav-row-btn" onClick={() => navigate('/feedback/pending')}>
          <Flag size={18} />
          <span>משובים ממתינים</span>
          <ArrowRight size={16} className="nav-row-arrow" />
        </button>

        <button className="nav-row-btn" onClick={() => navigate('/feedback/sent')}>
          <CheckCircle size={18} />
          <span>משובים שנשלחו</span>
          <ArrowRight size={16} className="nav-row-arrow" />
        </button>

        {/* ═══ ניהול (Admin only) ═══ */}
        {user?.is_admin && (
          <>
            <p className="settings-category-header">ניהול</p>
            <button
              className="nav-row-btn"
              onClick={() => navigate('/admin/users')}
            >
              <Users size={16} />
              <span>ניהול משתמשים</span>
              <ArrowRight size={16} className="nav-row-arrow" />
            </button>
            <button
              className="nav-row-btn"
              onClick={() => navigate('/admin/status')}
            >
              <Activity size={16} />
              <span>ביצועי מערכת</span>
              <ArrowRight size={16} className="nav-row-arrow" />
            </button>
          </>
        )}

        <div style={{ height: 40 }} />
      </div>
    </motion.div>
  );
};

export default Settings;