import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ArrowRight, Save, RotateCcw, Target, Bell, User, Clock, Activity, Flag, MessageSquare } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  getSettings,
  updateSettings,
  resetSettings,
  getAvailableClasses,
} from '../services/settingsService';

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
const HudSlider = ({ label, emoji, value, onChange }) => (
  <div className="slider-row">
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

  // ── Load settings + class list in parallel ──
  useEffect(() => {
    if (!userId) return;
    Promise.all([getSettings(userId), getAvailableClasses()])
      .then(([s, classes]) => {
        setSettings(s);
        setAvailableClasses(classes);
      })
      .catch(() => setError('לא ניתן לטעון הגדרות. בדוק חיבור ונסה שוב.'))
      .finally(() => setLoading(false));
  }, [userId]);

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
        detection_sensitivity: settings.detection_sensitivity,
        high_risk_classes:     settings.high_risk_classes,
      });
      setSettings(updated);
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
    } catch {
      setError('איפוס נכשל. נסה שוב.');
    } finally {
      setResetting(false);
    }
  };

  const set = (key) => (val) =>
    setSettings((prev) => ({ ...prev, [key]: val }));

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

        {/* Profile shortcut */}
        <button className="nav-row-btn" onClick={() => navigate('/profile')}>
          <User size={18} />
          <span>פרופיל אישי</span>
          <ArrowRight size={16} className="nav-row-arrow" />
        </button>

        {/* History shortcut */}
        <button className="nav-row-btn" onClick={() => navigate('/history')}>
          <Clock size={18} />
          <span>היסטוריית זיהויים</span>
          <ArrowRight size={16} className="nav-row-arrow" />
        </button>

        {/* General feedback */}
        <button className="nav-row-btn" onClick={() => navigate('/feedback/general')}>
          <MessageSquare size={18} />
          <span>שלח משוב כללי</span>
          <ArrowRight size={16} className="nav-row-arrow" />
        </button>

        {/* Pending feedback */}
        <button className="nav-row-btn" onClick={() => navigate('/feedback/pending')}>
          <Flag size={18} />
          <span>משובים ממתינים</span>
          <ArrowRight size={16} className="nav-row-arrow" />
        </button>

        {/* Feedback banners */}
        <AnimatePresence>
          {error && (
            <motion.div className="error-banner"
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}
            >{error}</motion.div>
          )}
          {saveOk && (
            <motion.div className="success-banner"
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}
            >ההגדרות נשמרו בהצלחה!</motion.div>
          )}
        </AnimatePresence>

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
                בחר כיצד SeeSense יתריע בזמן זיהוי עצם בסיכון גבוה.
              </p>
              <SegControl
                options={alertOptions}
                value={settings.alert_type}
                onChange={set('alert_type')}
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
                onChange={set('volume_intensity')}
              />
              <div className="slider-divider" />
              <HudSlider
                emoji="📳"
                label="עוצמת רטט"
                value={settings.vibration_intensity}
                onChange={set('vibration_intensity')}
              />
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

            {/* ── Admin: System Status (visible only for admins) ── */}
            {user?.is_admin && (
              <button
                className="admin-status-btn"
                onClick={() => navigate('/admin/status')}
              >
                <Activity size={16} />
                ביצועי מערכת
              </button>
            )}
          </>
        )}

        <div style={{ height: 40 }} />
      </div>
    </motion.div>
  );
};

export default Settings;
