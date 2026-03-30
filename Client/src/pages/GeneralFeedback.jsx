import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Send } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { generalFeedback } from '../services/userService';

const pageVariants = {
  hidden:  { opacity: 0, x: 40 },
  visible: { opacity: 1, x: 0,  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, x: 40, transition: { duration: 0.22, ease: 'easeIn' } },
};

const FEEDBACK_TYPES = [
  { key: 'wrong_detection', label: 'זיהוי שגוי'   },
  { key: 'missed_obstacle', label: 'פספוס מכשול'  },
  { key: 'general',         label: 'כללי'          },
];

const GeneralFeedback = () => {
  const navigate = useNavigate();

  const [fbType,   setFbType]   = useState('general');
  const [notes,    setNotes]    = useState('');
  const [loading,  setLoading]  = useState(false);
  const [sent,     setSent]     = useState(false);
  const [error,    setError]    = useState('');

  const handleSubmit = async () => {
    setError('');
    setLoading(true);
    try {
      await generalFeedback({ feedback_type: fbType, notes: notes.trim() || undefined });
      setSent(true);
      setTimeout(() => navigate('/settings'), 2000);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'שליחה נכשלה. נסה שוב.');
    } finally {
      setLoading(false);
    }
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
        <span className="inner-page-title">משוב כללי</span>
        <div style={{ width: 46 }} />
      </header>

      <div className="inner-page-body">

        <AnimatePresence>
          {error && (
            <motion.div className="error-banner"
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}
            >{error}</motion.div>
          )}
          {sent && (
            <motion.div className="success-banner"
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}
            >תודה! המשוב נשלח בהצלחה.</motion.div>
          )}
        </AnimatePresence>

        {/* Feedback type */}
        <div className="glass-section">
          <p className="section-label" style={{ marginBottom: 12 }}>סוג משוב</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {FEEDBACK_TYPES.map((ft) => (
              <button
                key={ft.key}
                type="button"
                className={`seg-btn${fbType === ft.key ? ' active' : ''}`}
                onClick={() => setFbType(ft.key)}
                style={{ flex: '1 1 auto' }}
              >
                {ft.label}
              </button>
            ))}
          </div>
        </div>

        {/* Notes */}
        <div className="glass-section">
          <p className="section-label" style={{ marginBottom: 10 }}>תיאור</p>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="תאר את הבעיה או ההצעה שלך... (אופציונלי)"
            rows={5}
            disabled={loading || sent}
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

        <motion.button
          className="auth-btn"
          onClick={handleSubmit}
          disabled={loading || sent}
          whileTap={{ scale: 0.97 }}
          style={{ marginTop: 4 }}
        >
          <Send size={18} />
          {loading ? 'שולח...' : sent ? 'נשלח ✓' : 'שלח משוב'}
        </motion.button>

        <div style={{ height: 40 }} />
      </div>
    </motion.div>
  );
};

export default GeneralFeedback;
