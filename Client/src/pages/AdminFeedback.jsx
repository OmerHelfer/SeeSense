import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  ArrowRight, MessageSquare, Clock, Loader, CheckCircle, AlertTriangle,
  Hand, UserCheck, Send, X, User, Phone, Calendar, MapPin, Shield, Mail,
  ChevronLeft,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { getFeedbackAdmin, takeFeedback, resolveFeedback, assignFeedback, getAdmins, getUserByEmail } from '../services/adminService';
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

const hebrewName = (c) => HEBREW_NAMES[c] || c || '?';

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
  return formatServerDateTime(ts);
}

const DetailRow = ({ icon: Icon, label, value, ltr }) => {
  if (value == null || value === '') return null;
  return (
    <div className="afb-ud-row">
      <Icon size={15} className="afb-ud-row-icon" />
      <span className="afb-ud-row-label">{label}</span>
      <span className="afb-ud-row-value" dir={ltr ? 'ltr' : undefined}>{value}</span>
    </div>
  );
};

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

const FeedbackCard = ({ item, actorLevel, myId, onTake, onResolve, onAssign, onUserClick, busyId }) => {
  const st = STATUS_META[item.handling_status] ?? STATUS_META.pending;
  const snap = item.detection_snapshot;
  const objs = snap?.objects ?? [];
  const names = objs.length > 0 ? objs.map((o) => hebrewName(o.class_name)).join(', ') : null;
  const busy = busyId === item.feedback_id;

  const iAmHandler = item.handling_admin_id && item.handling_admin_id === myId;
  const canResolve = item.handling_status === 'in_progress' && (actorLevel >= 2 || iAmHandler);
  const isPending  = item.handling_status === 'pending';
  const lockedForMe = item.handling_status === 'in_progress' && actorLevel < 2 && !iAmHandler;

  return (
    <div className="afb-card">
      <div className="afb-head">
        <button className="afb-user afb-user-btn" onClick={() => onUserClick(item)}
          title="הצג פרטי משתמש">
          <User size={14} />
          <div>
            <div className="afb-user-name">{item.user_name || 'משתמש'}</div>
            <div className="afb-user-email" dir="ltr">{item.user_email}</div>
          </div>
          <ChevronLeft size={15} className="afb-user-chevron" />
        </button>
        <span className="afb-status" style={{ color: st.color, borderColor: st.color }}>
          <st.Icon size={12} /> {st.label}
        </span>
      </div>

      <div className="afb-meta">
        <span className="afb-type">{FEEDBACK_TYPE_LABELS[item.feedback_type] ?? item.feedback_type}</span>
        <span className="afb-date">{fmtDate(item.created_at)}</span>
      </div>

      {names && (
        <div className="afb-detection">
          <span className="afb-detection-names">{names}</span>
          {snap?.danger && <AlertTriangle size={12} color="#ef4444" />}
          {snap?.distance && <span className="afb-detection-dist">מרחק: {snap.distance}</span>}
        </div>
      )}

      {item.notes && <p className="afb-notes">{item.notes}</p>}

      {item.handling_admin_name && (
        <div className="afb-handler">
          <UserCheck size={13} style={{ color: st.color }} />
          <span>
            {item.handling_status === 'resolved' ? 'טופל ע״י' : 'בטיפול'} <strong>{item.handling_admin_name}</strong>
            {item.assigned_admin_id && ' (הוקצה)'}
          </span>
        </div>
      )}

      {item.handling_status === 'resolved' && item.admin_response && (
        <div className="afb-response">
          <span className="afb-response-label">פירוט הטיפול:</span>
          <p>{item.admin_response}</p>
          {item.resolved_at && <span className="afb-response-time">{fmtDate(item.resolved_at)}</span>}
        </div>
      )}

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
        {lockedForMe && (
          <span className="afb-locked">
            <Shield size={13} /> נלקח ע״י {item.handling_admin_name || 'אדמין'} · רק רמה 2 יכול לשנות
          </span>
        )}
      </div>
    </div>
  );
};

const AdminFeedback = () => {
  const navigate = useNavigate();
  const { user: me } = useAuth();
  const myId = me?.id ?? me?.user_id;

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [filter, setFilter]   = useState('all');
  const [busyId, setBusyId]   = useState(null);

  const [resolveItem, setResolveItem] = useState(null);
  const [responseText, setResponseText] = useState('');

  const [assignItem, setAssignItem]   = useState(null);
  const [admins, setAdmins]           = useState([]);
  const [adminsLoading, setAdminsLoading] = useState(false);

  const [userModal, setUserModal]       = useState(null);
  const [userDetail, setUserDetail]     = useState(null);
  const [userLoading, setUserLoading]   = useState(false);
  const [userError, setUserError]       = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await getFeedbackAdmin();
      setData(res);
    } catch (err) {
      setError(err?.response?.status === 403 ? 'אין הרשאת אדמין' : 'שגיאה בטעינת המשובים');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!assignItem) return;
    setAdminsLoading(true);
    getAdmins().then((d) => setAdmins(d.admins || [])).catch(() => setAdmins([])).finally(() => setAdminsLoading(false));
  }, [assignItem]);

  useEffect(() => {
    if (!userModal?.user_email) return;
    setUserLoading(true); setUserError(''); setUserDetail(null);
    getUserByEmail(userModal.user_email)
      .then((d) => setUserDetail(d.user))
      .catch(() => setUserError('לא ניתן לטעון את פרטי המשתמש'))
      .finally(() => setUserLoading(false));
  }, [userModal]);

  const actorLevel = data?.actor_level ?? 0;
  const stats = data?.stats ?? { pending: 0, in_progress: 0, resolved: 0, total: 0 };

  const shown = useMemo(() => {
    const list = data?.feedback ?? [];
    return filter === 'all' ? list : list.filter((f) => f.handling_status === filter);
  }, [data, filter]);

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
                busyId={busyId} onTake={handleTake} onResolve={setResolveItem} onAssign={setAssignItem}
                onUserClick={setUserModal} />
            ))}
          </div>
        )}
        <div style={{ height: 40 }} />
      </div>

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

      <AnimatePresence>
        {userModal && (
          <motion.div className="admin-modal-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setUserModal(null)}>
            <motion.div className="admin-modal-card admin-list-modal" onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }}>
              <h3 className="admin-modal-title">
                <User size={18} style={{ verticalAlign: '-3px', marginLeft: 6 }} /> פרטי משתמש
              </h3>

              {userLoading && <div className="admin-loading">טוען פרטים...</div>}
              {userError && <div className="admin-error">{userError}</div>}

              {userDetail && (
                <div className="afb-user-detail">
                  <div className="afb-ud-hero">
                    <div className="afb-ud-avatar">
                      <User size={22} />
                      <span className="afb-ud-dot" style={{ background: userDetail.online ? '#22c55e' : '#6b7280' }} />
                    </div>
                    <div>
                      <div className="afb-ud-name">{userDetail.name || 'ללא שם'}</div>
                      <div className="afb-ud-status" style={{ color: userDetail.online ? '#22c55e' : '#94a3b8' }}>
                        {userDetail.online ? 'מחובר כעת' : `נראה לאחרונה: ${fmtDate(userDetail.last_seen) || '—'}`}
                      </div>
                    </div>
                  </div>

                  <DetailRow icon={Mail}     label="אימייל"   value={userDetail.email} ltr />
                  <DetailRow icon={Phone}    label="טלפון"    value={userDetail.phone} ltr />
                  <DetailRow icon={MapPin}   label="מדינה"    value={userDetail.country} />
                  <DetailRow icon={Calendar} label="תאריך לידה" value={userDetail.date_of_birth} />
                  <DetailRow icon={Shield}   label="הרשאה"
                    value={userDetail.admin_level >= 2 ? 'אדמין רמה 2' : userDetail.admin_level >= 1 ? 'אדמין רמה 1' : 'משתמש רגיל'} />
                  <DetailRow icon={Calendar} label="הצטרף"    value={fmtDate(userDetail.created_at)} />

                  {userDetail.data_counts && (
                    <div className="afb-ud-counts">
                      <div className="afb-ud-count"><span>{userDetail.data_counts.detections ?? 0}</span>זיהויים</div>
                      <div className="afb-ud-count"><span>{userDetail.data_counts.feedback ?? 0}</span>משובים</div>
                      <div className="afb-ud-count"><span>{userDetail.data_counts.sos_alerts ?? 0}</span>קריאות SOS</div>
                    </div>
                  )}
                </div>
              )}

              <button className="admin-modal-cancel" onClick={() => setUserModal(null)}>
                <X size={15} style={{ verticalAlign: '-2px' }} /> סגור
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default AdminFeedback;
