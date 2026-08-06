import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Plus, Trash2, CheckCircle, Clock, RefreshCw, Shield } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  getContacts,
  addContact,
  verifyContact,
  resendCode,
  removeContact,
} from '../services/userService';

const pageVariants = {
  hidden:  { opacity: 0, x: 40 },
  visible: { opacity: 1, x: 0,  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, x: 40, transition: { duration: 0.22, ease: 'easeIn' } },
};

// ── Steps: 'list' | 'add' | 'verify' ──────────────────
// 'add'    — show add-contact form
// 'verify' — code entry for a just-added (or pending) contact

const EmergencyContacts = () => {
  const navigate = useNavigate();

  const [contacts, setContacts]   = useState([]);
  const [loadErr, setLoadErr]     = useState('');
  const [mode, setMode]           = useState('list'); // 'list' | 'add' | 'verify'

  // ── Add form ──
  const [newName, setNewName]   = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError]     = useState('');

  // ── Verify form ──
  const [verifyEmail, setVerifyEmail] = useState(''); // the contact being verified
  const [code, setCode]               = useState('');
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifyError, setVerifyError]     = useState('');
  const [resendLoading, setResendLoading] = useState(false);
  const [resendOk, setResendOk]           = useState(false);

  // ── Remove ──
  const [removingEmail, setRemovingEmail] = useState(null);

  // ── Load contacts ──
  const loadContacts = async () => {
    setLoadErr('');
    try {
      const list = await getContacts();
      setContacts(list);
    } catch {
      setLoadErr('לא ניתן לטעון אנשי קשר. נסה שוב.');
    }
  };

  useEffect(() => { loadContacts(); }, []);

  // ── Add contact ──
  const handleAdd = async (e) => {
    e.preventDefault();
    setAddError('');
    setAddLoading(true);
    try {
      await addContact({ name: newName, email: newEmail, phone: newPhone });
      // Transition to verification step
      setVerifyEmail(newEmail);
      setCode('');
      setVerifyError('');
      setResendOk(false);
      setMode('verify');
      setNewName(''); setNewEmail(''); setNewPhone('');
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setAddError(typeof detail === 'string' ? detail : 'הוספה נכשלה. ודא שלא עברת את מגבלת 5 אנשי קשר.');
    } finally {
      setAddLoading(false);
    }
  };

  // ── Verify contact ──
  const handleVerify = async (e) => {
    e.preventDefault();
    setVerifyError('');
    setVerifyLoading(true);
    try {
      await verifyContact({ email: verifyEmail, code });
      await loadContacts();
      setMode('list');
      setCode('');
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setVerifyError(typeof detail === 'string' ? detail : 'קוד שגוי. נסה שוב (נותרו עד 3 ניסיונות).');
    } finally {
      setVerifyLoading(false);
    }
  };

  // ── Resend code ──
  const handleResend = async () => {
    setResendOk(false);
    setResendLoading(true);
    try {
      await resendCode({ email: verifyEmail });
      setResendOk(true);
    } catch {
      setVerifyError('שליחה חוזרת נכשלה. נסה שוב.');
    } finally {
      setResendLoading(false);
    }
  };

  // ── Start verify for an existing pending contact ──
  const startVerify = (email) => {
    setVerifyEmail(email);
    setCode('');
    setVerifyError('');
    setResendOk(false);
    setMode('verify');
  };

  // ── Remove contact ──
  const handleRemove = async (email) => {
    setRemovingEmail(email);
    try {
      await removeContact({ email });
      setContacts((prev) => prev.filter((c) => c.email !== email));
    } catch {
      // silently reload
      await loadContacts();
    } finally {
      setRemovingEmail(null);
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
      {/* ── Header ── */}
      <header className="inner-page-header">
        <button
          className="back-btn"
          onClick={() => mode === 'list' ? navigate('/settings') : setMode('list')}
          aria-label="חזרה"
        >
          <ArrowRight size={22} />
        </button>
        <span className="inner-page-title">
          {mode === 'list' ? 'אנשי קשר לחירום' : mode === 'add' ? 'הוספת איש קשר' : 'אימות איש קשר'}
        </span>
        <div style={{ width: 46 }} />
      </header>

      <div className="inner-page-body">

        {/* ══════════════════ LIST MODE ══════════════════ */}
        <AnimatePresence mode="wait">
          {mode === 'list' && (
            <motion.div
              key="list"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              {loadErr && <div className="error-banner">{loadErr}</div>}

              {/* Info banner */}
              <div className="glass-section info-section">
                <div className="section-label-row">
                  <Shield size={15} />
                  <span className="section-label">אנשי קשר לחירום</span>
                </div>
                <p className="info-text">
                  אנשי קשר מאומתים יקבלו התראת מיקום GPS בעת לחיצה על כפתור החירום.
                  ניתן להוסיף עד 5 אנשי קשר.
                </p>
              </div>

              {/* Contact list */}
              {contacts.length === 0 && !loadErr && (
                <div className="empty-state">
                  <Shield size={38} strokeWidth={1.5} />
                  <p>אין אנשי קשר עדיין</p>
                  <span>הוסף איש קשר שיקבל התראות חירום</span>
                </div>
              )}

              <div className="contact-list">
                <AnimatePresence>
                  {contacts.map((c) => (
                    <motion.div
                      key={c.email}
                      className="contact-card"
                      layout
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0  }}
                      exit={{    opacity: 0, x: 40  }}
                      transition={{ duration: 0.22 }}
                    >
                      <div className="contact-main">
                        <p className="contact-name">{c.name}</p>
                        <p className="contact-meta">{c.email}</p>
                        <p className="contact-meta">{c.phone}</p>
                      </div>
                      <div className="contact-side">
                        {c.status === 'verified' ? (
                          <span className="status-badge verified">
                            <CheckCircle size={12} /> מאומת
                          </span>
                        ) : (
                          <button
                            className="status-badge pending clickable"
                            onClick={() => startVerify(c.email)}
                          >
                            <Clock size={12} /> אמת עכשיו
                          </button>
                        )}
                        <button
                          className="icon-btn-sm danger"
                          onClick={() => handleRemove(c.email)}
                          disabled={removingEmail === c.email}
                          aria-label="הסר"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>

              {/* Add button */}
              {contacts.length < 5 && (
                <button
                  className="add-contact-btn"
                  onClick={() => { setAddError(''); setMode('add'); }}
                >
                  <Plus size={20} />
                  הוסף איש קשר
                </button>
              )}
            </motion.div>
          )}

          {/* ══════════════════ ADD MODE ══════════════════ */}
          {mode === 'add' && (
            <motion.div
              key="add"
              initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }} transition={{ duration: 0.22 }}
            >
              <div className="glass-section">
                <AnimatePresence>
                  {addError && (
                    <motion.div className="error-banner"
                      initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}
                    >{addError}</motion.div>
                  )}
                </AnimatePresence>

                <form onSubmit={handleAdd} noValidate>
                  <div className="input-group">
                    <label className="input-label" htmlFor="c-name">שם מלא</label>
                    <input
                      id="c-name"
                      type="text"
                      autoComplete="name"
                      className="input-field"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="ישראל ישראלי"
                      required
                    />
                  </div>

                  <div className="input-group">
                    <label className="input-label" htmlFor="c-email">אימייל</label>
                    <input
                      id="c-email"
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      className="input-field"
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      placeholder="contact@example.com"
                      required
                    />
                  </div>

                  <div className="input-group">
                    <label className="input-label" htmlFor="c-phone">טלפון</label>
                    <input
                      id="c-phone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      className="input-field"
                      value={newPhone}
                      onChange={(e) => setNewPhone(e.target.value)}
                      placeholder="+972501234567"
                      required
                    />
                  </div>

                  <p className="hint-text">
                    קוד אימות יישלח לאימייל של איש הקשר. הקוד בתוקף ל-30 דקות.
                  </p>

                  <motion.button
                    type="submit"
                    className="auth-btn"
                    style={{ marginTop: 8 }}
                    disabled={addLoading || !newName || !newEmail || !newPhone}
                    whileTap={{ scale: 0.97 }}
                  >
                    <Plus size={20} />
                    {addLoading ? 'מוסיף...' : 'הוסף ושלח קוד אימות'}
                  </motion.button>
                </form>
              </div>
            </motion.div>
          )}

          {/* ══════════════════ VERIFY MODE ══════════════════ */}
          {mode === 'verify' && (
            <motion.div
              key="verify"
              initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }} transition={{ duration: 0.22 }}
            >
              <div className="glass-section">
                <p className="info-text" style={{ marginBottom: 16 }}>
                  הזן את קוד האימות שנשלח לאימייל:
                </p>
                <p className="verify-email-display">{verifyEmail}</p>

                <AnimatePresence>
                  {verifyError && (
                    <motion.div className="error-banner"
                      initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}
                    >{verifyError}</motion.div>
                  )}
                  {resendOk && (
                    <motion.div className="success-banner"
                      initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}
                    >הקוד נשלח שוב!</motion.div>
                  )}
                </AnimatePresence>

                <form onSubmit={handleVerify} noValidate>
                  <div className="input-group" style={{ marginTop: 12 }}>
                    <label className="input-label" htmlFor="verify-code">קוד אימות (6 ספרות)</label>
                    <input
                      id="verify-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      className="input-field code-input"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="123456"
                      maxLength={6}
                      required
                    />
                  </div>

                  <motion.button
                    type="submit"
                    className="auth-btn"
                    style={{ marginTop: 4 }}
                    disabled={verifyLoading || code.length !== 6}
                    whileTap={{ scale: 0.97 }}
                  >
                    <CheckCircle size={20} />
                    {verifyLoading ? 'מאמת...' : 'אמת איש קשר'}
                  </motion.button>
                </form>

                <button
                  className="resend-btn"
                  onClick={handleResend}
                  disabled={resendLoading}
                >
                  <RefreshCw size={15} />
                  {resendLoading ? 'שולח...' : 'שלח קוד חדש'}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div style={{ height: 40 }} />
      </div>
    </motion.div>
  );
};

export default EmergencyContacts;