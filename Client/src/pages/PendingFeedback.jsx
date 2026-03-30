import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Flag, ChevronLeft } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { getPendingFeedback, submitFeedback } from '../services/userService';

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

function formatDate(ts) {
  const d = new Date(ts);
  return `${d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
}

// ── Selected item view — shows notes form ─────────────
const FeedbackForm = ({ item, onBack, onSubmitted }) => {
  const [notes,   setNotes]   = useState('');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const handleSubmit = async () => {
    if (!notes.trim()) { setError('יש להוסיף הערה לפני השליחה.'); return; }
    setError('');
    setLoading(true);
    try {
      await submitFeedback(item.feedback_id ?? item._id, { notes: notes.trim() });
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
      {/* Back to list */}
      <button
        className="back-btn"
        onClick={onBack}
        style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <ChevronLeft size={18} />
        <span style={{ fontSize: 14, color: 'var(--text-2)' }}>חזרה לרשימה</span>
      </button>

      {/* Item summary */}
      <div className="glass-section" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: 13, color: 'var(--text-2)', fontFamily: 'var(--font-body)' }}>
            {formatDate(item.created_at)}
          </span>
          <span style={{
            background: 'rgba(0,240,255,0.1)',
            border: '1px solid var(--cyan-dim)',
            color: 'var(--cyan)',
            borderRadius: 999,
            padding: '2px 10px',
            fontSize: 12,
            fontFamily: 'var(--font-body)',
          }}>
            {FEEDBACK_TYPE_LABELS[item.feedback_type] ?? item.feedback_type}
          </span>
        </div>
        {item.record_id && (
          <p style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-body)', margin: 0 }}>
            מזהה רשומה: {item.record_id}
          </p>
        )}
      </div>

      {/* Notes textarea */}
      <div className="glass-section">
        <p className="section-label" style={{ marginBottom: 10 }}>הוסף הערה</p>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="תאר מה היה שגוי או מה פוספס..."
          rows={4}
          disabled={loading}
          style={{
            width: '100%',
            background: 'var(--glass-bg)',
            border: '1px solid var(--glass-border)',
            borderRadius: 'var(--r-sm)',
            color: 'var(--text)',
            fontFamily: 'var(--font-body)',
            fontSize: 14,
            padding: '12px 14px',
            resize: 'vertical',
            outline: 'none',
            direction: 'rtl',
            lineHeight: 1.6,
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

// ── Main page ─────────────────────────────────────────
const PendingFeedback = () => {
  const navigate = useNavigate();

  const [items,     setItems]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selected,  setSelected]  = useState(null); // feedback item being edited

  const loadFeedback = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const feedbacks = await getPendingFeedback();
      setItems(feedbacks);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setLoadError(typeof detail === 'string' ? detail : 'לא ניתן לטעון משובים ממתינים.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadFeedback(); }, [loadFeedback]);

  const handleSubmitted = (feedback_id) => {
    // Remove from list and return to list view
    setItems((prev) => prev.filter((f) => (f.feedback_id ?? f._id) !== feedback_id));
    setSelected(null);
  };

  return (
    <motion.div
      className="inner-page"
      variants={pageVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <header className="inner-page-header">
        <button className="back-btn" onClick={() => navigate('/settings')} aria-label="חזרה">
          <ArrowRight size={22} />
        </button>
        <span className="inner-page-title">משובים ממתינים</span>
        <div style={{ width: 46 }} />
      </header>

      <div className="inner-page-body">

        <AnimatePresence mode="wait">
          {/* ── Form view ── */}
          {selected ? (
            <FeedbackForm
              key="form"
              item={selected}
              onBack={() => setSelected(null)}
              onSubmitted={handleSubmitted}
            />
          ) : (
            <motion.div
              key="list"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              {/* ── Loading ── */}
              {loading && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
                  <div className="settings-loading">
                    <div className="settings-loading-dot" />
                    <div className="settings-loading-dot" />
                    <div className="settings-loading-dot" />
                  </div>
                </div>
              )}

              {/* ── Error ── */}
              {!loading && loadError && (
                <div className="error-banner">{loadError}</div>
              )}

              {/* ── Empty ── */}
              {!loading && !loadError && items.length === 0 && (
                <div className="empty-state">
                  <span style={{ fontSize: 36 }}>✅</span>
                  <p>אין משובים ממתינים</p>
                </div>
              )}

              {/* ── Feedback list ── */}
              {!loading && !loadError && items.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <p style={{ fontSize: 13, color: 'var(--text-3)', fontFamily: 'var(--font-body)', marginBottom: 4 }}>
                    {items.length} משוב{items.length !== 1 ? 'ים' : ''} ממתין{items.length !== 1 ? 'ים' : ''} — לחץ כדי להוסיף הערה
                  </p>
                  <AnimatePresence initial={false}>
                    {items.map((item) => (
                      <motion.div
                        key={item.feedback_id ?? item._id}
                        layout
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, x: 40 }}
                        transition={{ duration: 0.2 }}
                        onClick={() => setSelected(item)}
                        style={{
                          background: 'var(--glass-bg)',
                          border: '1px solid var(--glass-border)',
                          borderRadius: 'var(--r-md)',
                          padding: '14px 16px',
                          cursor: 'pointer',
                          direction: 'rtl',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span style={{
                            fontSize: 14,
                            fontWeight: 600,
                            color: 'var(--text)',
                            fontFamily: 'var(--font-body)',
                          }}>
                            {FEEDBACK_TYPE_LABELS[item.feedback_type] ?? item.feedback_type}
                          </span>
                          <span style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-body)' }}>
                            {formatDate(item.created_at)}
                          </span>
                        </div>

                        {/* Pending badge + chevron */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{
                            background: 'rgba(234,255,0,0.1)',
                            border: '1px solid var(--yellow)',
                            color: 'var(--yellow)',
                            borderRadius: 999,
                            padding: '2px 10px',
                            fontSize: 11,
                            fontFamily: 'var(--font-body)',
                          }}>
                            ממתין
                          </span>
                          <ChevronLeft size={16} style={{ color: 'var(--text-3)' }} />
                        </div>
                      </motion.div>
                    ))}
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
