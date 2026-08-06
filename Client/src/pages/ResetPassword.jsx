import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { Eye, EyeOff, KeyRound, Scan } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { resetPassword } from '../services/userService';

const MeshBackground = () => (
  <div className="mesh-background" aria-hidden="true">
    <div className="mesh-blob blob-1" />
    <div className="mesh-blob blob-2" />
    <div className="mesh-blob blob-3" />
  </div>
);

const cardVariants = {
  hidden:  { opacity: 0, y: 40, scale: 0.97 },
  visible: { opacity: 1, y: 0,  scale: 1,
    transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, y: -24, scale: 0.97,
    transition: { duration: 0.25, ease: 'easeIn' } },
};

const ResetPassword = () => {
  const navigate = useNavigate();
  const location = useLocation();

  // Email may be passed from ForgotPassword via router state
  const [email, setEmail]               = useState(location.state?.email ?? '');
  const [code, setCode]                 = useState('');
  const [newPassword, setNewPassword]   = useState('');
  const [confirmPw, setConfirmPw]       = useState('');
  const [showPw, setShowPw]             = useState(false);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState('');

  const isValid = email && code.length === 6 && newPassword.length >= 6 && newPassword === confirmPw;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPw) {
      setError('הסיסמאות אינן תואמות.');
      return;
    }
    if (newPassword.length < 6) {
      setError('הסיסמה חייבת להכיל לפחות 6 תווים.');
      return;
    }

    setLoading(true);
    try {
      await resetPassword({ email, code, new_password: newPassword });
      navigate('/login');
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'הקוד שגוי או פג תוקפו. נסה שוב.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <MeshBackground />

      <motion.div
        className="auth-card"
        variants={cardVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        <div className="auth-logo">
          <div className="auth-logo-mark">
            <Scan size={28} strokeWidth={2.5} />
          </div>
          <div>
            <h1 className="auth-logo-name">SEE<span>SENSE</span></h1>
            <p className="auth-logo-tagline">הגדרת סיסמה חדשה</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <p className="auth-heading">איפוס סיסמה</p>

          <AnimatePresence>
            {error && (
              <motion.div
                className="error-banner"
                initial={{ opacity: 0, y: -8, height: 0 }}
                animate={{ opacity: 1, y: 0,  height: 'auto' }}
                exit={{    opacity: 0, y: -8, height: 0 }}
                transition={{ duration: 0.2 }}
                role="alert"
              >
                {error}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Email field — pre-filled but editable in case user landed here directly */}
          <div className="input-group">
            <label className="input-label" htmlFor="rp-email">אימייל</label>
            <input
              id="rp-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              className="input-field"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </div>

          {/* 6-digit code */}
          <div className="input-group">
            <label className="input-label" htmlFor="rp-code">קוד חד-פעמי (6 ספרות)</label>
            <input
              id="rp-code"
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

          {/* New password */}
          <div className="input-group">
            <label className="input-label" htmlFor="rp-password">סיסמה חדשה</label>
            <div className="input-password-wrap">
              <input
                id="rp-password"
                type={showPw ? 'text' : 'password'}
                autoComplete="new-password"
                className="input-field"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="לפחות 6 תווים"
                required
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? 'הסתר סיסמה' : 'הצג סיסמה'}
              >
                {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          {/* Confirm password */}
          <div className="input-group">
            <label className="input-label" htmlFor="rp-confirm">אימות סיסמה</label>
            <input
              id="rp-confirm"
              type={showPw ? 'text' : 'password'}
              autoComplete="new-password"
              className={`input-field${confirmPw && confirmPw !== newPassword ? ' has-error' : ''}`}
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              placeholder="הזן שוב את הסיסמה"
              required
            />
          </div>

          <motion.button
            type="submit"
            className="auth-btn"
            disabled={loading || !isValid}
            whileTap={{ scale: 0.97 }}
            aria-label="אפס סיסמה"
          >
            <KeyRound size={20} />
            {loading ? 'מאפס...' : 'אפס סיסמה'}
          </motion.button>
        </form>

        <p className="auth-footer">
          <Link to="/login">חזרה להתחברות</Link>
        </p>
      </motion.div>
    </div>
  );
};

export default ResetPassword;
