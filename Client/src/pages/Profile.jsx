import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ArrowRight, Edit2, Save, X, Users, User, Trash2, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { getProfile, updateProfile, deleteAccount } from '../services/userService';

const pageVariants = {
  hidden:  { opacity: 0, x: 40 },
  visible: { opacity: 1, x: 0,  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, x: 40, transition: { duration: 0.22, ease: 'easeIn' } },
};

const Profile = () => {
  const navigate = useNavigate();
  const { logout } = useAuth();

  const [profile, setProfile]         = useState(null);
  const [loadErr, setLoadErr]         = useState('');
  const [isEditing, setIsEditing]     = useState(false);
  const [editData, setEditData]       = useState({});
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveError, setSaveError]     = useState('');
  const [saveOk, setSaveOk]           = useState(false);

  // Self-delete
  const [showDelete, setShowDelete]   = useState(false);
  const [deleting, setDeleting]       = useState(false);
  const [deleteErr, setDeleteErr]     = useState('');

  const handleDeleteAccount = async () => {
    setDeleting(true); setDeleteErr('');
    try {
      await deleteAccount();
      await logout();
      navigate('/login');
    } catch (err) {
      setDeleteErr(err?.response?.data?.detail || 'מחיקת החשבון נכשלה.');
      setDeleting(false);
    }
  };

  useEffect(() => {
    getProfile()
      .then((user) => {
        setProfile(user);
        setEditData({
          name:          user.name          ?? '',
          phone:         user.phone         ?? '',
          country:       user.country       ?? '',
          date_of_birth: user.date_of_birth ?? '',
          height_cm:     user.height_cm     ?? '',
          weight_kg:     user.weight_kg     ?? '',
        });
      })
      .catch(() => setLoadErr('לא ניתן לטעון את הפרופיל. נסה שוב.'));
  }, []);

  const handleSave = async () => {
    setSaveError('');
    setSaveOk(false);
    setSaveLoading(true);
    try {
      const payload = { ...editData };
      if (payload.height_cm === '') delete payload.height_cm;
      else payload.height_cm = parseFloat(payload.height_cm);
      if (payload.weight_kg === '') delete payload.weight_kg;
      else payload.weight_kg = parseFloat(payload.weight_kg);
      if (payload.country) payload.country = payload.country.toUpperCase();

      const updated = await updateProfile(payload);
      setProfile(updated);
      setSaveOk(true);
      setIsEditing(false);
      setTimeout(() => setSaveOk(false), 3000);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setSaveError(typeof detail === 'string' ? detail : 'שמירה נכשלה. נסה שוב.');
    } finally {
      setSaveLoading(false);
    }
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setSaveError('');
    setEditData({
      name:          profile?.name          ?? '',
      phone:         profile?.phone         ?? '',
      country:       profile?.country       ?? '',
      date_of_birth: profile?.date_of_birth ?? '',
      height_cm:     profile?.height_cm     ?? '',
      weight_kg:     profile?.weight_kg     ?? '',
    });
  };

  const field = (key, label, inputProps = {}) => (
    <div className="profile-field">
      <span className="field-label">{label}</span>
      {isEditing ? (
        <input
          className="input-field field-input"
          value={editData[key] ?? ''}
          onChange={(e) => setEditData((d) => ({ ...d, [key]: e.target.value }))}
          {...inputProps}
        />
      ) : (
        <span className="field-value">
          {profile?.[key] || <span className="field-empty">—</span>}
        </span>
      )}
    </div>
  );

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
        <span className="inner-page-title">פרופיל אישי</span>
        <div style={{ width: 46 }} />
      </header>

      <div className="inner-page-body">
        {loadErr && <div className="error-banner">{loadErr}</div>}

        {/* Profile info */}
        <div className="glass-section">
          <div className="section-header">
            <div className="section-label-row">
              <User size={15} />
              <span className="section-label">פרטים אישיים</span>
            </div>
            {!isEditing ? (
              <button className="ghost-btn sm" onClick={() => setIsEditing(true)}>
                <Edit2 size={15} />
                עריכה
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="ghost-btn sm" onClick={cancelEdit} disabled={saveLoading}>
                  <X size={15} />
                </button>
                <button className="accent-btn sm" onClick={handleSave} disabled={saveLoading}>
                  <Save size={15} />
                  {saveLoading ? 'שומר...' : 'שמור'}
                </button>
              </div>
            )}
          </div>

          <AnimatePresence>
            {saveError && (
              <motion.div className="error-banner"
                initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}
              >{saveError}</motion.div>
            )}
            {saveOk && (
              <motion.div className="success-banner"
                initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}
              >הפרטים עודכנו בהצלחה!</motion.div>
            )}
          </AnimatePresence>

          {field('name',          'שם מלא',         { type: 'text',   autoComplete: 'name' })}
          {field('phone',         'טלפון',           { type: 'tel',    inputMode: 'tel'     })}
          {field('country',       'מדינה (קוד ISO)', { type: 'text',   maxLength: 2         })}
          {field('date_of_birth', 'תאריך לידה',     { type: 'date'                         })}
          {field('height_cm',     'גובה (ס"מ)',      { type: 'number', inputMode: 'decimal' })}
          {field('weight_kg',     'משקל (ק"ג)',      { type: 'number', inputMode: 'decimal' })}

          <div className="profile-field readonly">
            <span className="field-label">אימייל</span>
            <span className="field-value">{profile?.email || '—'}</span>
          </div>
        </div>

        {/* Emergency contacts shortcut */}
        <button className="nav-row-btn" onClick={() => navigate('/contacts')}>
          <Users size={18} />
          <span>אנשי קשר לחירום</span>
          <ArrowRight size={16} className="nav-row-arrow" />
        </button>

        {/* Danger zone — self delete (available to all; the last super admin is blocked server-side) */}
        {profile && (
          <div className="danger-zone">
            <div className="danger-zone-head">
              <AlertTriangle size={15} />
              <span>אזור מסוכן</span>
            </div>
            <p className="danger-zone-desc">
              מחיקת החשבון היא לצמיתות ותסיר את כל הנתונים שלך (זיהויים, משובים, אנשי קשר, קריאות חירום).
              אי אפשר לשחזר.
            </p>
            <button className="au-delete-btn" onClick={() => setShowDelete(true)}>
              <Trash2 size={16} /> מחק את החשבון שלי
            </button>
          </div>
        )}

        <div style={{ height: 40 }} />
      </div>

      {/* Self-delete confirmation modal (centered) */}
      <AnimatePresence>
        {showDelete && (
          <motion.div className="admin-modal-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => !deleting && setShowDelete(false)}>
            <motion.div className="admin-modal-card" onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }}>
              <div className="admin-modal-icon"><AlertTriangle size={26} /></div>
              <h3 className="admin-modal-title">למחוק את החשבון שלך?</h3>
              <p className="admin-modal-body">
                כל הנתונים שלך יימחקו <strong>לצמיתות</strong> ולא ניתן יהיה לשחזר אותם. תנותק מיד.
              </p>
              {deleteErr && <div className="error-banner" style={{ marginBottom: 12 }}>{deleteErr}</div>}
              <button className="admin-reset-btn confirm" onClick={handleDeleteAccount} disabled={deleting}>
                <Trash2 size={16} /> {deleting ? 'מוחק...' : 'כן, מחק לצמיתות'}
              </button>
              <button className="admin-modal-cancel" onClick={() => setShowDelete(false)} disabled={deleting}>
                ביטול
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default Profile;
