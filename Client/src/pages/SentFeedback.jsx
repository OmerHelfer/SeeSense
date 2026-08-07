import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCircle, Trash2, Edit3, ChevronLeft, AlertTriangle, Save, Lock, MessageSquare, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { getSubmittedFeedback, deleteFeedback, updateFeedback, markResponsesSeen } from '../services/userService';
import { formatServerDateTime } from '../utils/serverDate';
import { HEBREW_NAMES } from '../services/feedbackService';

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

const HANDLING_META = {
  pending:     { label: 'ממתין לטיפול', color: '#94a3b8' },
  in_progress: { label: 'בטיפול',       color: '#f59e0b' },
  resolved:    { label: 'טופל',          color: '#22c55e' },
};

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
      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', fontFamily: 'var(--font-body)' }}>
        {names}
      </span>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
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
  );
};

const EditForm = ({ item, onBack, onSaved }) => {
  const [fbType,  setFbType]  = useState(item.feedback_type || 'wrong_detection');
  const [notes,   setNotes]   = useState(item.notes || '');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const handleSave = async () => {
    setError('');
    setLoading(true);
    try {
      const result = await updateFeedback(item.feedback_id ?? item._id, {
        feedback_type: fbType,
        notes: notes.trim() || undefined,
      });
      onSaved(item.feedback_id ?? item._id, result.feedback || { ...item, feedback_type: fbType, notes: notes.trim() });
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'שמירה נכשלה. נסה שוב.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div key="edit" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 30 }} transition={{ duration: 0.22 }}>
      <button className="back-btn" onClick={onBack} style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
        <ChevronLeft size={18} />
        <span style={{ fontSize: 14, color: 'var(--text-2)' }}>חזרה לרשימה</span>
      </button>

      <DetectionCard snapshot={item.detection_snapshot} />

      <div className="glass-section" style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-body)', marginBottom: 10 }}>סוג משוב:</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {FEEDBACK_TYPES.map((ft) => (
            <button key={ft.key} onClick={() => setFbType(ft.key)} style={{
              padding: '6px 14px', borderRadius: 999, fontSize: 13,
              fontFamily: 'var(--font-body)', cursor: 'pointer', transition: 'all 0.15s',
              border: fbType === ft.key ? '1.5px solid var(--cyan)' : '1.5px solid var(--glass-border)',
              background: fbType === ft.key ? 'rgba(0,240,255,0.10)' : 'var(--glass-bg)',
              color: fbType === ft.key ? 'var(--cyan)' : 'var(--text-2)',
            }}>
              {ft.label}
            </button>
          ))}
        </div>
      </div>

      <div className="glass-section">
        <p className="section-label" style={{ marginBottom: 10 }}>הערה</p>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="תאר מה היה שגוי או מה פוספס..." rows={4} disabled={loading}
          style={{
            width: '100%', background: 'var(--glass-bg)', border: '1px solid var(--glass-border)',
            borderRadius: 'var(--r-sm)', color: 'var(--text)', fontFamily: 'var(--font-body)',
            fontSize: 14, padding: '12px 14px', resize: 'vertical', outline: 'none',
            direction: 'rtl', lineHeight: 1.6,
          }}
        />
      </div>

      {error && <div className="error-banner" style={{ marginTop: 8 }}>{error}</div>}

      <motion.button className="auth-btn" onClick={handleSave} disabled={loading} whileTap={{ scale: 0.97 }} style={{ marginTop: 12 }}>
        <Save size={18} />
        {loading ? 'שומר...' : 'שמור שינויים'}
      </motion.button>
    </motion.div>
  );
};

const SentFeedback = () => {
  const navigate = useNavigate();
  const [items,     setItems]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editing,   setEditing]   = useState(null);
  const [responseView, setResponseView] = useState(null);

  const loadFeedback = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      const feedbacks = await getSubmittedFeedback();
      setItems(feedbacks);
      if (feedbacks.some((f) => f.handling_status === 'resolved' && f.response_seen === false)) {
        markResponsesSeen().catch(() => {});
      }
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setLoadError(typeof detail === 'string' ? detail : 'לא ניתן לטעון משובים.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadFeedback(); }, [loadFeedback]);

  const handleDelete = async (feedbackId) => {
    try {
      await deleteFeedback(feedbackId);
      setItems((prev) => prev.filter((f) => (f.feedback_id ?? f._id) !== feedbackId));
    } catch {  }
  };

  const handleSaved = (feedbackId, updated) => {
    setItems((prev) => prev.map((f) => (f.feedback_id ?? f._id) === feedbackId ? { ...f, ...updated } : f));
    setEditing(null);
  };

  return (
    <motion.div className="inner-page" variants={pageVariants} initial="hidden" animate="visible" exit="exit">
      <header className="inner-page-header">
        <button className="back-btn" onClick={() => navigate('/settings')} aria-label="חזרה">
          <ArrowRight size={22} />
        </button>
        <span className="inner-page-title">משובים שנשלחו</span>
        <div style={{ width: 46 }} />
      </header>

      <div className="inner-page-body">
        <AnimatePresence mode="wait">
          {editing ? (
            <EditForm key="edit" item={editing} onBack={() => setEditing(null)} onSaved={handleSaved} />
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
                  <span style={{ fontSize: 36 }}>📭</span>
                  <p>אין משובים שנשלחו</p>
                </div>
              )}

              {!loading && !loadError && items.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <p style={{ fontSize: 13, color: 'var(--text-3)', fontFamily: 'var(--font-body)', marginBottom: 4 }}>
                    {items.length} משובים נשלחו
                  </p>

                  <AnimatePresence initial={false}>
                    {items.map((item) => {
                      const id = item.feedback_id ?? item._id;
                      const snap = item.detection_snapshot;
                      const objs = snap?.objects ?? [];
                      const names = objs.length > 0 ? objs.map((o) => hebrewName(o.class_name)).join(', ') : null;
                      const locked   = item.handling_status === 'in_progress' || item.handling_status === 'resolved';
                      const hasReply = item.handling_status === 'resolved' && item.admin_response;
                      const isNew    = hasReply && item.response_seen === false;

                      return (
                        <motion.div key={id} layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, x: 40 }} transition={{ duration: 0.2 }}
                          style={{
                            background: 'var(--glass-bg)', border: '1px solid var(--glass-border)',
                            borderRadius: 'var(--r-md)', padding: '14px 16px', direction: 'rtl',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                              <span style={{
                                background: 'rgba(34,197,94,0.1)', border: '1px solid var(--safe)',
                                color: 'var(--safe)', borderRadius: 999, padding: '2px 10px',
                                fontSize: 12, fontFamily: 'var(--font-body)', display: 'flex', alignItems: 'center', gap: 4,
                              }}>
                                <CheckCircle size={11} />
                                {FEEDBACK_TYPE_LABELS[item.feedback_type] ?? item.feedback_type}
                              </span>
                              {(() => {
                                const hs = HANDLING_META[item.handling_status] ?? HANDLING_META.pending;
                                return (
                                  <span style={{
                                    border: `1px solid ${hs.color}`, color: hs.color, borderRadius: 999,
                                    padding: '2px 10px', fontSize: 12, fontFamily: 'var(--font-body)',
                                  }}>
                                    {hs.label}
                                  </span>
                                );
                              })()}
                              {isNew && (
                                <span className="sf-new-pill">
                                  <span className="sf-new-dot" /> תשובה חדשה
                                </span>
                              )}
                            </div>
                            <span style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-body)' }}>
                              {formatDate(item.created_at)}
                            </span>
                          </div>

                          {names && (
                            <div style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                              <span style={{ fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>
                                {names}
                              </span>
                              {snap?.danger && <AlertTriangle size={12} color="var(--danger)" />}
                              <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-body)' }}>
                                {snap?.distance}
                              </span>
                            </div>
                          )}

                          {item.notes && (
                            <p style={{ fontSize: 13, color: 'var(--text-2)', fontFamily: 'var(--font-body)', margin: '0 0 8px 0', lineHeight: 1.5 }}>
                              {item.notes}
                            </p>
                          )}

                          {hasReply && (
                            <button className="sf-response" onClick={() => setResponseView(item)}>
                              <span className="sf-response-label">
                                <MessageSquare size={12} /> תשובת הצוות
                                {item.handling_admin_name && <> · <bdi>{item.handling_admin_name}</bdi></>}
                              </span>
                              <p className="sf-response-preview">{item.admin_response}</p>
                              <span className="sf-response-more">הצג הודעה מלאה ›</span>
                            </button>
                          )}

                          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                            {locked ? (
                              <span style={{
                                display: 'flex', alignItems: 'center', gap: 4, padding: '4px 0',
                                color: 'var(--text-3)', fontSize: 12, fontFamily: 'var(--font-body)',
                              }}>
                                <Lock size={12} /> ננעל לעריכה (בטיפול)
                              </span>
                            ) : (
                              <button onClick={() => setEditing(item)} style={{
                                display: 'flex', alignItems: 'center', gap: 4, padding: '4px 0',
                                border: 'none', background: 'none', color: 'var(--cyan)',
                                fontSize: 12, fontFamily: 'var(--font-body)', cursor: 'pointer',
                              }}>
                                <Edit3 size={12} /> ערוך
                              </button>
                            )}
                            <button onClick={() => handleDelete(id)} style={{
                              display: 'flex', alignItems: 'center', gap: 4, padding: '4px 0',
                              border: 'none', background: 'none', color: 'var(--text-3)',
                              fontSize: 12, fontFamily: 'var(--font-body)', cursor: 'pointer',
                            }}>
                              <Trash2 size={12} /> מחק
                            </button>
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

      <AnimatePresence>
        {responseView && (
          <motion.div className="admin-modal-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setResponseView(null)}>
            <motion.div className="admin-modal-card" onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }}>
              <div className="admin-modal-icon" style={{ background: 'rgba(34,197,94,0.12)', color: '#22c55e' }}>
                <MessageSquare size={26} />
              </div>
              <h3 className="admin-modal-title">תשובת הצוות</h3>
              {responseView.handling_admin_name && (
                <p className="admin-modal-body" style={{ marginBottom: 8, color: 'var(--safe)' }}>
                  <bdi>{responseView.handling_admin_name}</bdi>
                  {responseView.resolved_at && (
                    <> · <bdi>{formatDate(responseView.resolved_at)}</bdi></>
                  )}
                </p>
              )}
              <p className="sf-response-full">{responseView.admin_response}</p>
              <button className="admin-modal-cancel" onClick={() => setResponseView(null)}>
                <X size={15} style={{ verticalAlign: '-2px' }} /> סגור
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default SentFeedback;