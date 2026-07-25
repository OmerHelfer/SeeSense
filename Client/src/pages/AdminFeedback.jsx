import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  ArrowRight, MessageSquare, Clock, Loader, CheckCircle, AlertTriangle,
  Hand, UserCheck, Send, X, User,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { getFeedbackAdmin, takeFeedback, resolveFeedback, assignFeedback, getAdmins } from '../services/adminService';

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

const HEBREW_NAMES = {
  person: 'אדם', car: 'מכונית', bicycle: 'אופניים', motorcycle: 'אופנוע',
  bench: 'ספסל', fire_hydrant: 'ברז כיבוי', traffic_light: 'רמזור',
  stairs: 'מדרגות', pole: 'עמוד', dog: 'כלב', bus: 'אוטובוס', truck: 'משאית',
};
const hebrewName = (c) => HEBREW_NAMES[c] || c || '?';

// Handling-status metadata (colors + Hebrew labels).
const STATUS_META = {
  pending:     { label: 'ממתין',  color: '#94a3b8', Icon: Clock },
  in_progress: { label: 'בטיפול', color: '#f59e0b', Icon: Loader },
  resolved:    { label: 'טופל',   color: '#22c55e', Icon: CheckCircle },
};

const FILTERS = [
  { key: 'all',         label: 'הכל' },
  { key: 'pending',     label: 'ממתין' },
  { key: 'in_progress', label: 'בטיפול' },
  { key: 'resolved',    label: 'טופל' },
];

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
}

// ── Stat card (clickable = sets filter) ──
const StatCard = ({ icon: Icon, label, value, color, active, onClick }) => (
  <button className={`admin-stat-card-btn${active ? ' active' : ''}`} onClick={onClick}
    style={active ? { borderColor: color } : undefined}>
    <div className="admin-stat-icon" style={{ color }}><Icon size={18} /></div>
    <div className="admin-stat-body">
      <span className="admin-stat-value">{value}</span>
      <span className="admin-stat-label">{label}</span>
    </div>
  </button>
);

// ── One feedback card ──
const FeedbackCard = ({ item, actorLevel, myId, onTake, onResolve, onAssign, busyId }) => {
  const st = STATUS_META[item.handling_status] ?? STATUS_META.pending;
  const snap = item.detection_snapshot;
  const objs = snap?.objects ?? [];
  const names = objs.length > 0 ? objs.map((o) => hebrewName(o.class_name)).join(', ') : null;
  const busy = busyId === item.feedback_id;

  const iAmHandler = item.handling_admin_id && item.handling_admin_id === myId;
  const canResolve = item.handling_status === 'in_progress' && (actorLevel >= 2 || iAmHandler);
  const isPending  = item.handling_status === 'pending';

  return (
    <div className="afb-card">
      {/* Header: user + status */}
      <div className="afb-head">
        <div className="afb-user">
          <User size={14} />
          <div>
            <div className="afb-user-name">{item.user_name || 'משתמש'}</div>
            <div className="afb-user-email" dir="ltr">{item.user_email}</div>
          </div>
        </div>
        <span className="afb-status" style={{ color: st.color, borderColor: st.color }}>
          <st.Icon size={12} /> {st.label}
        </span>
      </div>

      {/* Type + date */}
      <div className="afb-meta">
        <span className="afb-type">{FEEDBACK_TYPE_LABELS[item.feedback_type] ?? item.feedback_type}</span>
        <span className="afb-date">{fmtDate(item.created_at)}</span>
      </div>

      {/* Detection snapshot */}
      {names && (
        <div className="afb-detection">
          <span className="afb-detection-names">{names}</span>
          {snap?.danger && <AlertTriangle size={12} color="#ef4444" />}
          {snap?.distance && <span className="afb-detection-dist">מרחק: {snap.distance}</span>}
        </div>
      )}

      {/* User notes */}
      {item.notes && <p className="afb-notes">{item.notes}</p>}

      {/* Handling info (in progress / resolved) */}
      {item.handling_admin_name && (
        <div className="afb-handler">
          <UserCheck size={13} style={{ color: st.color }} />
          <span>
            {item.handling_status === 'resolved' ? 'טופל ע״י' : 'בטיפול'} <strong>{item.handling_admin_name}</strong>
            {item.assigned_admin_id && ' (הוקצה)'}
          </span>
        </div>
      )}

      {/* Admin response (resolved) */}
      {item.handling_status === 'resolved' && item.admin_response && (
        <div className="afb-response">
          <span className="afb-response-label">פירוט הטיפול:</span>
          <p>{item.admin_response}</p>
          {item.resolved_at && <span className="afb-response-time">{fmtDate(item.resolved_at)}</span>}
        </div>
      )}

      {/* Actions */}
      <div className="afb-actions">
        {isPending && (
          <button className="afb-btn take" onClick={() => onTake(item)} disabled={busy}>
            <Hand size={14} /> קח לטיפול
          </button>
        )}
        {canResolve && (
          <button className="afb-btn resolve" onClick={() => onResolve(item)} disabled={busy}>
            <CheckCircle size={14} /> סמן כטופל
          </button>
        )}
        {actorLevel >= 2 && item.handling_status !== 'resolved' && (
          <button className="afb-btn assign" onClick={() => onAssign(item)} disabled={busy}>
            <UserCheck size={14} /> {item.assigned_admin_id ? 'הקצה מחדש' : 'הקצה לאדמין'}
          </button>
        )}
      </div>
    </div>
  );
};

// ══════════════════════════════════════════════════════════
const AdminFeedback = () => {
  const navigate = useNavigate();
  const { user: me } = useAuth();
  const myId = me?.id ?? me?.user_id;

  const [data, setData]       = useState(null);   // { feedback, stats, actor_level }
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [filter, setFilter]   = useState('all');
  const [busyId, setBusyId]   = useState(null);

  // Resolve modal
  const [resolveItem, setResolveItem] = useState(null);
  const [responseText, setResponseText] = useState('');

  // Assign modal (L2)
  const [assignItem, setAssignItem]   = useState(null);
  const [admins, setAdmins]           = useState([]);
  const [adminsLoading, setAdminsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await getFeedbackAdmin();  // full list; filter client-side to keep stats live
      setData(res);
    } catch (err) {
      setError(err?.response?.status === 403 ? 'אין הרשאת אדמין' : 'שגיאה בטעינת המשובים');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Load admins when the assign modal opens.
  useEffect(() => {
    if (!assignItem) return;
    setAdminsLoading(true);
    getAdmins().then((d) => setAdmins(d.admins || [])).catch(() => setAdmins([])).finally(() => setAdminsLoading(false));
  }, [assignItem]);

  const actorLevel = data?.actor_level ?? 0;
  const stats = data?.stats ?? { pending: 0, in_progress: 0, resolved: 0, total: 0 };

  const shown = useMemo(() => {
    const list = data?.feedback ?? [];
    return filter === 'all' ? list : list.filter((f) => f.handling_status === filter);
  }, [data, filter]);

  // Replace one item in place after an action (keeps scroll/filter), refresh stats.
  const patchItem = (updated) => {
    setData((d) => {
      if (!d) return d;
      const feedback = d.feedback.map((f) => (f.feedback_id === updated.feedback_id ? updated : f));
      const stats = { pending: 0, in_progress: 0, resolved: 0, total: feedback.length };
      feedback.forEach((f) => { stats[f.handling_status] = (stats[f.handling_status] || 0) + 1; });
      return { ...d, feedback, stats };
    });
  };

  const handleTake = async (item) => {
    setBusyId(item.feedback_id); setError('');
    try { patchItem(await takeFeedback(item.feedback_id)); }
    catch (err) { setError(err?.response?.data?.detail || 'הפעולה נכשלה'); }
    finally { setBusyId(null); }
  };

  const handleResolveConfirm = async () => {
    if (!responseText.trim()) return;
    setBusyId(resolveItem.feedback_id); setError('');
    try {
      patchItem(await resolveFeedback(resolveItem.feedback_id, responseText.trim()));
      setResolveItem(null); setResponseText('');
    } catch (err) { setError(err?.response?.data?.detail || 'הפעולה נכשלה'); }
    finally { setBusyId(null); }
  };

  const handleAssignTo = async (assigneeId) => {
    setBusyId(assignItem.feedback_id); setError('');
    try {
      patchItem(await assignFeedback(assignItem.feedback_id, assigneeId));
      setAssignItem(null);
    } catch (err) { setError(err?.response?.data?.detail || 'ההקצאה נכשלה'); }
    finally { setBusyId(null); }
  };

  return (
    <motion.div className="inner-page" variants={pageVariants} initial="hidden" animate="visible" exit="exit">
      <header className="inner-page-header">
        <button className="back-btn" onClick={() => navigate('/settings')} aria-label="חזרה">
          <ArrowRight size={22} />
        </button>
        <span className="inner-page-title">ניהול משובים</span>
        <div style={{ width: 46 }} />
      </header>

      <div className="inner-page-body">
        {/* Stat cards double as filters */}
        <div className="admin-stats-grid" style={{ marginBottom: 14 }}>
          <StatCard icon={MessageSquare} label="הכל" value={stats.total} color="#22d3ee"
            active={filter === 'all'} onClick={() => setFilter('all')} />
          <StatCard icon={Clock} label="ממתין" value={stats.pending} color="#94a3b8"
            active={filter === 'pending'} onClick={() => setFilter('pending')} />
          <StatCard icon={Loader} label="בטיפול" value={stats.in_progress} color="#f59e0b"
            active={filter === 'in_progress'} onClick={() => setFilter('in_progress')} />
          <StatCard icon={CheckCircle} label="טופל" value={stats.resolved} color="#22c55e"
            active={filter === 'resolved'} onClick={() => setFilter('resolved')} />
        </div>

        {/* Filter chips (mirror the cards, for clarity) */}
        <div className="admin-range-bar" style={{ marginBottom: 14 }}>
          {FILTERS.map((f) => (
            <button key={f.key} className={`admin-range-chip${filter === f.key ? ' active' : ''}`}
              onClick={() => setFilter(f.key)}>{f.label}</button>
          ))}
        </div>

        {loading && <div className="admin-loading">טוען משובים...</div>}
        {error && <div className="admin-error">{error}</div>}

        {!loading && !error && shown.length === 0 && (
          <div className="empty-state"><span style={{ fontSize: 36 }}>📭</span><p>אין משובים בקטגוריה זו</p></div>
        )}

        {!loading && !error && shown.length > 0 && (
          <div className="afb-list">
            {shown.map((item) => (
              <FeedbackCard key={item.feedback_id} item={item} actorLevel={actorLevel} myId={myId}
                busyId={busyId} onTake={handleTake} onResolve={setResolveItem} onAssign={setAssignItem} />
            ))}
          </div>
        )}
        <div style={{ height: 40 }} />
      </div>

      {/* ── Resolve modal ── */}
      <AnimatePresence>
        {resolveItem && (
          <motion.div className="admin-modal-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => busyId == null && setResolveItem(null)}>
            <motion.div className="admin-modal-card" onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }}>
              <div className="admin-modal-icon" style={{ background: 'rgba(34,197,94,0.12)', color: '#22c55e' }}>
                <CheckCircle size={26} />
              </div>
              <h3 className="admin-modal-title">סימון כטופל</h3>
              <p className="admin-modal-body" style={{ marginBottom: 12 }}>
                פרט מה עשית וכיצד טיפלת במשוב. הפירוט יוצג למשתמש כתשובה.
              </p>
              <textarea className="afb-textarea" rows={4} value={responseText} autoFocus
                placeholder="לדוגמה: בדקתי את הזיהוי, עדכנתי את הרגישות למכוניות, ופתחתי משימה לאימון מחדש."
                onChange={(e) => setResponseText(e.target.value)} />
              <button className="admin-reset-btn confirm" style={{ background: '#22c55e', borderColor: '#22c55e' }}
                onClick={handleResolveConfirm} disabled={busyId != null || !responseText.trim()}>
                <Send size={16} /> {busyId != null ? 'שומר...' : 'שלח וסמן כטופל'}
              </button>
              <button className="admin-modal-cancel" onClick={() => setResolveItem(null)} disabled={busyId != null}>
                ביטול
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Assign modal (L2) ── */}
      <AnimatePresence>
        {assignItem && (
          <motion.div className="admin-modal-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => busyId == null && setAssignItem(null)}>
            <motion.div className="admin-modal-card admin-list-modal" onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }}>
              <h3 className="admin-modal-title"><UserCheck size={18} style={{ verticalAlign: '-3px', marginLeft: 6 }} /> הקצאה לאדמין</h3>
              <p className="admin-modal-body" style={{ marginBottom: 12 }}>בחר אדמין שיטפל במשוב זה.</p>
              {adminsLoading ? (
                <div className="admin-loading">טוען...</div>
              ) : (
                <div className="admin-list">
                  {admins.map((a) => {
                    const color = a.admin_level >= 2 ? '#ef4444' : '#22c55e';
                    return (
                      <button key={a.user_id} className="afb-assign-row" onClick={() => handleAssignTo(a.user_id)}
                        disabled={busyId != null}>
                        <span className="admin-list-dot" style={{ background: a.online ? color : '#6b7280' }} />
                        <div className="admin-list-info">
                          <span className="admin-list-name">{a.name || a.email}</span>
                          <span className="admin-list-meta" style={{ color }}>
                            {a.admin_level >= 2 ? 'אדמין רמה 2' : 'אדמין רמה 1'}{a.online ? ' • מחובר' : ''}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              <button className="admin-modal-cancel" onClick={() => setAssignItem(null)} disabled={busyId != null}>
                <X size={15} style={{ verticalAlign: '-2px' }} /> ביטול
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default AdminFeedback;
