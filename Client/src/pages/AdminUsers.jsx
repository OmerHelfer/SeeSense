import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  ArrowRight, Search, Users, Wifi, WifiOff, Shield, ShieldCheck,
  KeyRound, Edit2, Save, X, Trash2, AlertTriangle, CheckCircle,
  ChevronLeft, Phone, Mail, LifeBuoy,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  getOverview, getAdmins, getUserByEmail, setUserPassword, updateUser, setUserLevel, deleteUserByEmail,
} from '../services/adminService';
import { relTime, parseServerDate } from '../utils/serverDate';

const pageVariants = {
  hidden:  { opacity: 0, x: 40 },
  visible: { opacity: 1, x: 0,  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, x: 40, transition: { duration: 0.22, ease: 'easeIn' } },
};

const LEVEL_META = {
  0: { label: 'משתמש',        color: '#94a3b8', Icon: Users },
  1: { label: 'אדמין רמה 1',  color: '#22d3ee', Icon: Shield },
  2: { label: 'אדמין רמה 2',  color: '#a78bfa', Icon: ShieldCheck },
};

const StatCard = ({ icon: Icon, label, value, color }) => (
  <div className="admin-stat-card">
    <div className="admin-stat-icon" style={{ color }}><Icon size={18} /></div>
    <div className="admin-stat-body">
      <span className="admin-stat-value">{value}</span>
      <span className="admin-stat-label">{label}</span>
    </div>
  </div>
);

const InfoRow = ({ label, value }) => (
  <div className="au-info-row">
    <span className="au-info-label">{label}</span>
    <span className="au-info-value">{value || '—'}</span>
  </div>
);

const AdminUsers = () => {
  const navigate = useNavigate();
  const { user: me } = useAuth();

  const [overview, setOverview] = useState(null);
  const [actorLevel, setActorLevel] = useState(0);

  const [email, setEmail]     = useState('');
  const [target, setTarget]   = useState(null);   // the looked-up user
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  // Actions state
  const [pwValue, setPwValue] = useState('');
  const [actionMsg, setActionMsg] = useState('');   // success toast text
  const [busy, setBusy]       = useState(false);
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState({});
  const [confirm, setConfirm] = useState(null);     // { type: 'delete'|'level', level? }

  // Online-admins modal
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [admins, setAdmins] = useState([]);
  const [adminsLoading, setAdminsLoading] = useState(false);

  const loadOverview = useCallback(async () => {
    try {
      const ov = await getOverview();
      setOverview(ov);
      setActorLevel(ov.actor_level ?? 0);
    } catch { /* ignore — page still usable for lookup */ }
  }, []);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  // Load the admin list whenever the modal opens (fresh presence each time).
  useEffect(() => {
    if (!showAdminModal) return;
    setAdminsLoading(true);
    getAdmins()
      .then((d) => setAdmins(d.admins || []))
      .catch(() => setAdmins([]))
      .finally(() => setAdminsLoading(false));
  }, [showAdminModal]);

  // Sort: online admins first (highest level on top), then offline admins
  // (grayed, most-recently-seen first).
  const sortedAdmins = useMemo(() => {
    const ts = (a) => (a.last_seen ? new Date(a.last_seen).getTime() : 0);
    const online = admins
      .filter((a) => a.online)
      .sort((a, b) => b.admin_level - a.admin_level || (a.name || '').localeCompare(b.name || ''));
    const offline = admins
      .filter((a) => !a.online)
      .sort((a, b) => ts(b) - ts(a));
    return [...online, ...offline];
  }, [admins]);

  const flash = (msg) => { setActionMsg(msg); setTimeout(() => setActionMsg(''), 2500); };

  // Core lookup — shared by the email search box and by clicking an admin in the
  // modal (both just resolve an email to the full admin-view of that user).
  const lookupUser = useCallback(async (emailToSearch) => {
    const q = (emailToSearch ?? '').trim();
    if (!q) return;
    setLoading(true); setError(''); setTarget(null); setEditing(false); setPwValue('');
    try {
      const { user } = await getUserByEmail(q);
      setTarget(user);
      setEditData({
        name: user.name ?? '', phone: user.phone ?? '', country: user.country ?? '',
        date_of_birth: user.date_of_birth ?? '', height_cm: user.height_cm ?? '', weight_kg: user.weight_kg ?? '',
      });
    } catch (err) {
      setError(err?.response?.status === 404 ? 'לא נמצא משתמש עם אימייל זה' : 'שגיאה בחיפוש');
    } finally {
      setLoading(false);
    }
  }, []);

  const doSearch = (e) => { e?.preventDefault(); lookupUser(email); };

  // Clicking an admin in the modal opens their full detail, exactly as an email
  // search would: close the modal, fill the search box, and load the profile.
  const openAdminDetail = (a) => {
    setShowAdminModal(false);
    setEmail(a.email);
    lookupUser(a.email);
  };

  const refreshTarget = async () => {
    try { const { user } = await getUserByEmail(target.email); setTarget(user); } catch { /* noop */ }
    loadOverview();
  };

  // Permission: level-1 admins can only manage regular (level 0) users.
  const canManage = target && (actorLevel >= 2 || target.admin_level === 0);
  const isSuper   = actorLevel >= 2;
  const isSelf    = target && (target.user_id === (me?.id ?? me?.user_id));

  const handleSetPassword = async () => {
    if (pwValue.length < 6) { setError('סיסמה חייבת להיות לפחות 6 תווים'); return; }
    setBusy(true); setError('');
    try { await setUserPassword(target.email, pwValue); setPwValue(''); flash('הסיסמה עודכנה'); }
    catch (err) { setError(err?.response?.data?.detail || 'עדכון הסיסמה נכשל'); }
    finally { setBusy(false); }
  };

  const handleSaveEdit = async () => {
    setBusy(true); setError('');
    try {
      const payload = {};
      for (const k of ['name', 'phone', 'country', 'date_of_birth']) {
        if (editData[k] !== '' && editData[k] != null) payload[k] = editData[k];
      }
      if (editData.height_cm !== '') payload.height_cm = parseFloat(editData.height_cm);
      if (editData.weight_kg !== '') payload.weight_kg = parseFloat(editData.weight_kg);
      if (payload.country) payload.country = payload.country.toUpperCase();
      await updateUser(target.email, payload);
      setEditing(false); flash('הפרטים עודכנו'); await refreshTarget();
    } catch (err) { setError(err?.response?.data?.detail || 'עדכון נכשל'); }
    finally { setBusy(false); }
  };

  const handleSetLevel = async (level) => {
    setBusy(true); setError('');
    try { await setUserLevel(target.email, level); setConfirm(null); flash('ההרשאה עודכנה'); await refreshTarget(); }
    catch (err) { setError(err?.response?.data?.detail || 'שינוי ההרשאה נכשל'); setConfirm(null); }
    finally { setBusy(false); }
  };

  const handleDelete = async () => {
    setBusy(true); setError('');
    try { await deleteUserByEmail(target.email); setConfirm(null); setTarget(null); setEmail(''); flash('המשתמש נמחק'); loadOverview(); }
    catch (err) { setError(err?.response?.data?.detail || 'מחיקה נכשלה'); setConfirm(null); }
    finally { setBusy(false); }
  };

  const lvl = target ? (LEVEL_META[target.admin_level] ?? LEVEL_META[0]) : null;

  return (
    <motion.div className="inner-page" variants={pageVariants} initial="hidden" animate="visible" exit="exit">
      <header className="inner-page-header">
        <button className="back-btn" onClick={() => navigate('/settings')} aria-label="חזרה">
          <ArrowRight size={22} />
        </button>
        <span className="inner-page-title">ניהול משתמשים</span>
        <div style={{ width: 46 }} />
      </header>

      <div className="inner-page-body">
        {/* Stats */}
        {overview && (
          <div className="admin-stats-grid" style={{ marginBottom: 16 }}>
            <StatCard icon={Users}   label="סה״כ משתמשים" value={overview.total}   color="#22d3ee" />
            <StatCard icon={Wifi}    label="מחוברים"       value={overview.online}  color="#22c55e" />
            <StatCard icon={WifiOff} label="מנותקים"       value={overview.offline} color="#94a3b8" />
            <button
              className="admin-stat-card-btn"
              onClick={() => setShowAdminModal(true)}
              title="הצג אדמינים מחוברים"
            >
              <div className="admin-stat-icon" style={{ color: '#f59e0b' }}><ShieldCheck size={18} /></div>
              <div className="admin-stat-body">
                <span className="admin-stat-value">{overview.admins_online ?? 0}</span>
                <span className="admin-stat-label">אדמינים מחוברים</span>
              </div>
            </button>
          </div>
        )}

        {/* Search */}
        <form className="au-search" onSubmit={doSearch}>
          <input
            type="email"
            placeholder="...הזן אימייל של משתמש"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            dir="ltr"
          />
          <button type="submit" disabled={loading}><Search size={18} /></button>
        </form>

        {loading && <div className="admin-loading">מחפש...</div>}
        {error && !confirm && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}

        {/* Success toast */}
        <AnimatePresence>
          {actionMsg && (
            <motion.div className="au-toast"
              initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
              <CheckCircle size={15} /> {actionMsg}
            </motion.div>
          )}
        </AnimatePresence>

        {/* User detail */}
        {target && (
          <div className="au-card">
            {/* Header: name + presence + level */}
            <div className="au-card-head">
              <div>
                <div className="au-name">{target.name}</div>
                <div className="au-email" dir="ltr">{target.email}</div>
              </div>
              <div className="au-badges">
                <span className={`au-presence ${target.online ? 'online' : 'offline'}`}>
                  <span className="au-dot" />
                  {target.online ? 'מחובר' : `מנותק • ${relTime(target.last_seen)}`}
                </span>
                <span className="au-level" style={{ color: lvl.color, borderColor: lvl.color }}>
                  <lvl.Icon size={13} /> {lvl.label}
                </span>
              </div>
            </div>

            {/* Data counts */}
            <div className="au-counts">
              {[
                ['זיהויים', target.data_counts?.detections],
                ['משובים', target.data_counts?.feedback],
                ['סשנים', target.data_counts?.sessions],
                ['אנשי קשר', target.data_counts?.emergency_contacts],
                ['קריאות SOS', target.data_counts?.sos_alerts],
              ].map(([label, val]) => (
                <div key={label} className="au-count">
                  <span className="au-count-val">{val ?? 0}</span>
                  <span className="au-count-label">{label}</span>
                </div>
              ))}
            </div>

            {/* Info / edit */}
            <div className="au-section">
              <div className="au-section-head">
                <span>פרטים</span>
                {canManage && !editing && (
                  <button className="ghost-btn sm" onClick={() => setEditing(true)}><Edit2 size={14} /> עריכה</button>
                )}
                {editing && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="ghost-btn sm" onClick={() => setEditing(false)} disabled={busy}><X size={14} /></button>
                    <button className="accent-btn sm" onClick={handleSaveEdit} disabled={busy}><Save size={14} /> שמור</button>
                  </div>
                )}
              </div>
              {editing ? (
                <div className="au-edit-grid">
                  {[['name', 'שם'], ['phone', 'טלפון'], ['country', 'מדינה (ISO)'], ['date_of_birth', 'תאריך לידה'], ['height_cm', 'גובה'], ['weight_kg', 'משקל']].map(([k, label]) => (
                    <label key={k} className="au-edit-field">
                      <span>{label}</span>
                      <input
                        value={editData[k] ?? ''}
                        onChange={(e) => setEditData((d) => ({ ...d, [k]: e.target.value }))}
                        type={k === 'date_of_birth' ? 'date' : (k.endsWith('_cm') || k.endsWith('_kg')) ? 'number' : 'text'}
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <>
                  <InfoRow label="טלפון" value={target.phone} />
                  <InfoRow label="מדינה" value={target.country} />
                  <InfoRow label="תאריך לידה" value={target.date_of_birth} />
                  <InfoRow label="גובה" value={target.height_cm && `${target.height_cm} ס״מ`} />
                  <InfoRow label="משקל" value={target.weight_kg && `${target.weight_kg} ק״ג`} />
                  <InfoRow label="נרשם בתאריך" value={target.created_at ? parseServerDate(target.created_at).toLocaleDateString('he-IL') : '—'} />
                </>
              )}
            </div>

            {/* Emergency contacts (full list — full detail, same as searching by email) */}
            <div className="au-section">
              <div className="au-section-head">
                <span><LifeBuoy size={14} /> אנשי קשר לחירום ({target.emergency_contacts?.length ?? 0})</span>
              </div>
              {(!target.emergency_contacts || target.emergency_contacts.length === 0) ? (
                <p className="au-hint">אין אנשי קשר לחירום.</p>
              ) : (
                <div className="au-contacts">
                  {target.emergency_contacts.map((c, i) => {
                    const verified = c.status === 'verified';
                    return (
                      <div key={i} className="au-contact">
                        <div className="au-contact-main">
                          <span className="au-contact-name">{c.name}</span>
                          <span className="au-contact-status" style={{ color: verified ? '#22c55e' : '#f59e0b' }}>
                            {verified ? 'מאומת' : 'ממתין לאימות'}
                          </span>
                        </div>
                        <div className="au-contact-sub">
                          {c.phone && <span dir="ltr"><Phone size={11} /> {c.phone}</span>}
                          {c.email && <span dir="ltr"><Mail size={11} /> {c.email}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Change password */}
            {canManage && (
              <div className="au-section">
                <div className="au-section-head"><span><KeyRound size={14} /> שינוי סיסמה</span></div>
                <div className="au-pw-row">
                  <input type="text" placeholder="סיסמה חדשה (6+ תווים)" value={pwValue} onChange={(e) => setPwValue(e.target.value)} dir="ltr" />
                  <button className="accent-btn sm" onClick={handleSetPassword} disabled={busy || pwValue.length < 6}>עדכן</button>
                </div>
              </div>
            )}

            {/* Admin level (super admin only) */}
            {isSuper && (
              <div className="au-section">
                <div className="au-section-head"><span><ShieldCheck size={14} /> הרשאות אדמין</span></div>
                <div className="au-level-chips">
                  {[0, 1, 2].map((l) => (
                    <button
                      key={l}
                      className={`au-level-chip${target.admin_level === l ? ' active' : ''}`}
                      disabled={busy || (isSelf && l < 2) || target.admin_level === l}
                      onClick={() => setConfirm({ type: 'level', level: l })}
                    >
                      {LEVEL_META[l].label}
                    </button>
                  ))}
                </div>
                {isSelf && <p className="au-hint">אי אפשר להוריד לעצמך את הרשאת רמה 2.</p>}
              </div>
            )}

            {/* Delete (super admin only, not self) */}
            {isSuper && !isSelf && (
              <button className="au-delete-btn" onClick={() => setConfirm({ type: 'delete' })}>
                <Trash2 size={16} /> מחק משתמש לצמיתות
              </button>
            )}

            {!canManage && (
              <p className="au-hint" style={{ marginTop: 12 }}>
                אתה אדמין רמה 1 — אפשר לצפות בלבד במשתמשים בעלי הרשאות. פעולות ניהול על אדמינים דורשות רמה 2.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Confirmation modal (centered) */}
      <AnimatePresence>
        {confirm && (
          <motion.div className="admin-modal-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => !busy && setConfirm(null)}>
            <motion.div className="admin-modal-card" onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }}>
              <div className="admin-modal-icon"><AlertTriangle size={26} /></div>
              {confirm.type === 'delete' ? (
                <>
                  <h3 className="admin-modal-title">למחוק את {target?.name}?</h3>
                  <p className="admin-modal-body">
                    פעולה זו תמחק <strong>לצמיתות</strong> את המשתמש ואת כל הנתונים שלו (זיהויים, משובים, סשנים,
                    אנשי קשר, קריאות חירום). <strong>אי אפשר לבטל.</strong>
                  </p>
                  <button className="admin-reset-btn confirm" onClick={handleDelete} disabled={busy}>
                    <Trash2 size={16} /> {busy ? 'מוחק...' : 'כן, מחק לצמיתות'}
                  </button>
                </>
              ) : (
                <>
                  <h3 className="admin-modal-title">לשנות הרשאה ל{LEVEL_META[confirm.level].label}?</h3>
                  <p className="admin-modal-body">
                    ההרשאה של <strong>{target?.name}</strong> תשתנה ל<strong>{LEVEL_META[confirm.level].label}</strong>.
                  </p>
                  <button className="admin-reset-btn confirm" style={{ background: '#a78bfa', borderColor: '#a78bfa' }}
                    onClick={() => handleSetLevel(confirm.level)} disabled={busy}>
                    <ShieldCheck size={16} /> {busy ? 'מעדכן...' : 'אשר'}
                  </button>
                </>
              )}
              <button className="admin-modal-cancel" onClick={() => setConfirm(null)} disabled={busy}>ביטול</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Online-admins modal (centered) */}
      <AnimatePresence>
        {showAdminModal && (
          <motion.div className="admin-modal-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setShowAdminModal(false)}>
            <motion.div className="admin-modal-card admin-list-modal" onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }}>
              <h3 className="admin-modal-title">
                <ShieldCheck size={18} style={{ verticalAlign: '-3px', marginLeft: 6 }} />
                אדמינים
              </h3>
              <p className="admin-modal-body" style={{ marginBottom: 14 }}>
                {overview?.admins_online ?? 0} מחוברים מתוך {admins.length}
              </p>

              {adminsLoading ? (
                <div className="admin-loading">טוען...</div>
              ) : sortedAdmins.length === 0 ? (
                <p className="admin-modal-body">אין אדמינים.</p>
              ) : (
                <div className="admin-list">
                  {sortedAdmins.map((a) => {
                    const color = a.online
                      ? (a.admin_level >= 2 ? '#ef4444' : '#22c55e')
                      : '#6b7280';
                    const levelLabel = a.admin_level >= 2 ? 'אדמין רמה 2' : 'אדמין רמה 1';
                    return (
                      <button key={a.user_id} className={`admin-list-row clickable${a.online ? '' : ' offline'}`}
                        onClick={() => openAdminDetail(a)} title="הצג פרטים מלאים">
                        <span className="admin-list-dot" style={{ background: color }} />
                        <div className="admin-list-info">
                          <span className="admin-list-name" style={{ color: a.online ? '#fff' : '#9ca3af' }}>
                            {a.name || a.email}
                          </span>
                          <span className="admin-list-meta" style={{ color }}>
                            {levelLabel}{a.online ? ' • מחובר' : ` • נראה ${relTime(a.last_seen)}`}
                          </span>
                        </div>
                        <ChevronLeft size={16} className="admin-list-chevron" />
                      </button>
                    );
                  })}
                </div>
              )}

              <button className="admin-modal-cancel" onClick={() => setShowAdminModal(false)}>סגור</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default AdminUsers;
