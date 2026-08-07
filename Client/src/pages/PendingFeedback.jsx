import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Flag, ChevronLeft, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { getPendingFeedback, submitFeedback } from '../services/userService';
import { HEBREW_NAMES } from '../services/feedbackService';
import { formatServerDateTime } from '../utils/serverDate';

const pageVariants = {
  hidden:  { opacity: 0, x: 40 },
  visible: { opacity: 1, x: 0,  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, x: 40, transition: { duration: 0.22, ease: 'easeIn' } },
};

const FEEDBACK_TYPE_LABELS = {
  wrong_detection: 'זיהוי שגוי',
  missed_obstacle: 'פספוס מכשול',
  general:         'כללי',
};

const FEEDBACK_TYPES = [
  { key: 'wrong_detection', label: 'זיהוי שגוי'  },
  { key: 'missed_obstacle', label: 'פספוס מכשול' },
  { key: 'general',         label: 'כללי'         },
];

function formatDate(ts) {
  return formatServerDateTime(ts);
}

function hebrewName(cls) { return HEBREW_NAMES[cls] || cls || '?'; }

const DetectionCard = ({ snapshot }) => {
  if (!snapshot) return null;
  const objs = snapshot.objects ?? [];
  const names = objs.length > 0
    ? objs.map((o) => hebrewName(o.class_name)).join(', ')
    : `${snapshot.objects_detected ?? 0} עצמים`;

  return (
    <div className="glass-section" style={{ marginBottom: 16 }}>
      <p style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-body)', marginBottom: 8 }}>
        מה זוהה בפריים:
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', fontFamily: 'var(--font-body)' }}>
          {names}
        </span>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {snapshot.danger && (
            <span style={{
              background: 'rgba(255,59,48,0.12)', color: 'var(--danger)', borderRadius: 999,
              padding: '2px 8px', fontSize: 11, fontFamily: 'var(--font-body)',
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <AlertTriangle size={10} /> סכנה
            </span>
          )}
          <span style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-body)' }}>
            מרחק: {snapshot.distance}
          </span>
          {snapshot.timestamp && (
            <span style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-body)' }}>
              {formatDate(snapshot.timestamp)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

const FeedbackForm = ({ item, onBack, onSubmitted }) => {
  const [fbType,  setFbType]  = useState(item.feedback_type || 'wrong_detection');
  const [notes,   setNotes]   = useState('');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const handleSubmit = async () => {
    setError('');
    setLoading(true);
    try {
      await submitFeedback(item.feedback_id ?? item._id, {
        notes: notes.trim() || undefined,
        feedback_type: fbType !== item.feedback_type ? fbType : undefined,
      });
      onSubmitted(item.feedback_id ?? item._id);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'שליחה נכשלה. נסה שוב.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      key="form"
      initial={{ opacity: 0, x: 30 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 30 }}
      transition={{ duration: 0.22 }}
    >
      <button
        className="back-btn"
        onClick={onBack}
        style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <ChevronLeft size={18} />
        <span style={{ fontSize: 14, color: 'var(--text-2)' }}>חזרה לרשימה</span>
      </button>

      <DetectionCard snapshot={item.detection_snapshot} />

      <div className="glass-section" style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-body)', marginBottom: 10 }}>
          סוג משוב:
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {FEEDBACK_TYPES.map((ft) => (
            <button
              key={ft.key}
              onClick={() => setFbType(ft.key)}
              style={{
                padding: '6px 14px', borderRadius: 999, fontSize: 13,
                fontFamily: 'var(--font-body)', cursor: 'pointer', transition: 'all 0.15s',
                border: fbType === ft.key ? '1.5px solid var(--cyan)' : '1.5px solid var(--glass-border)',
                background: fbType === ft.key ? 'rgba(0,240,255,0.10)' : 'var(--glass-bg)',
                color: fbType === ft.key ? 'var(--cyan)' : 'var(--text-2)',
              }}
            >
              {ft.label}
            </button>
          ))}
        </div>
      </div>

      <div className="glass-section">
        <p className="section-label" style={{ marginBottom: 10 }}>הוסף הערה (אופציונלי)</p>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="תאר מה היה שגוי או מה פוספס..."
          rows={4}
          disabled={loading}
          style={{
            width: '100%', background: 'var(--glass-bg)', border: '1px solid var(--glass-border)',
            borderRadius: 'var(--r-sm)', color: 'var(--text)', fontFamily: 'var(--font-body)',
            fontSize: 14, padding: '12px 14px', resize: 'vertical', outline: 'none',
            direction: 'rtl', lineHeight: 1.6,
          }}
        />
      </div>

      <AnimatePresence>
        {error && (
          <motion.div className="error-banner"
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}
            style={{ marginTop: 8 }}
          >{error}</motion.div>
        )}
      </AnimatePresence>

      <motion.button
        className="auth-btn"
        onClick={handleSubmit}
        disabled={loading}
        whileTap={{ scale: 0.97 }}
        style={{ marginTop: 12 }}
      >
        <Flag size={18} />
        {loading ? 'שולח...' : 'שלח משוב'}
      </motion.button>
    </motion.div>
  );
};

const PendingFeedback = () => {
  const navigate = useNavigate();
  const [items,     setItems]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selected,  setSelected]  = useState(null);

  const loadFeedback = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      const feedbacks = await getPendingFeedback();
      setItems(feedbacks);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setLoadError(typeof detail === 'string' ? detail : 'לא ניתן לטעון משובים ממתינים.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadFeedback(); }, [loadFeedback]);

  const handleSubmitted = (feedback_id) => {
    setItems((prev) => prev.filter((f) => (f.feedback_id ?? f._id) !== feedback_id));
    setSelected(null);
  };

  return (
    <motion.div className="inner-page" variants={pageVariants} initial="hidden" animate="visible" exit="exit">
      <header className="inner-page-header">
        <button className="back-btn" onClick={() => navigate('/settings')} aria-label="חזרה">
          <ArrowRight size={22} />
        </button>
        <span className="inner-page-title">משובים ממתינים</span>
        <div style={{ width: 46 }} />
      </header>

      <div className="inner-page-body">
        <AnimatePresence mode="wait">
          {selected ? (
            <FeedbackForm key="form" item={selected} onBack={() => setSelected(null)} onSubmitted={handleSubmitted} />
          ) : (
            <motion.div key="list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>

              {loading && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
                  <div className="settings-loading">
                    <div className="settings-loading-dot" />
                    <span>טוען משובים...</span>
                  </div>
                </div>
              )}

              {!loading && loadError && <div className="error-banner">{loadError}</div>}

              {!loading && !loadError && items.length === 0 && (
                <div className="empty-state">
                  <span style={{ fontSize: 36 }}>✅</span>
                  <p>אין משובים ממתינים</p>
                </div>
              )}

              {!loading && !loadError && items.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <p style={{ fontSize: 13, color: 'var(--text-3)', fontFamily: 'var(--font-body)', marginBottom: 4 }}>
                    {items.length} משובים ממתינים — לחץ כדי לערוך ולשלוח
                  </p>
                  <AnimatePresence initial={false}>
                    {items.map((item) => {
                      const snap = item.detection_snapshot;
                      const objs = snap?.objects ?? [];
                      const names = objs.length > 0 ? objs.map((o) => hebrewName(o.class_name)).join(', ') : null;

                      return (
                        <motion.div
                          key={item.feedback_id ?? item._id}
                          layout
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, x: 40 }}
                          transition={{ duration: 0.2 }}
                          onClick={() => setSelected(item)}
                          style={{
                            background: 'var(--glass-bg)', border: '1px solid var(--glass-border)',
                            borderRadius: 'var(--r-md)', padding: '14px 16px', cursor: 'pointer',
                            direction: 'rtl', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          }}
                        >
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', fontFamily: 'var(--font-body)' }}>
                              {FEEDBACK_TYPE_LABELS[item.feedback_type] ?? item.feedback_type}
                            </span>
                            {names && (
                              <span style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font-body)' }}>
                                {names} — {snap.distance}
                              </span>
                            )}
                            <span style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-body)' }}>
                              {formatDate(item.created_at)}
                            </span>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{
                              background: 'rgba(234,255,0,0.1)', border: '1px solid var(--yellow)',
                              color: 'var(--yellow)', borderRadius: 999, padding: '2px 10px',
                              fontSize: 11, fontFamily: 'var(--font-body)',
                            }}>
                              ממתין
                            </span>
                            <ChevronLeft size={16} style={{ color: 'var(--text-3)' }} />
                          </div>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        <div style={{ height: 40 }} />
      </div>
    </motion.div>
  );
};

export default PendingFeedback;