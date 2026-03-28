import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Mail, Scan } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { forgotPassword } from '../services/userService';

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

const ForgotPassword = () => {
  const [email, setEmail]     = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent]       = useState(false);
  const [error, setError]     = useState('');
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await forgotPassword({ email });
      setSent(true);
    } catch {
      setError('שגיאה בשליחת הקוד. נסה שוב.');
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
            <p className="auth-logo-tagline">שחזור סיסמה</p>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {sent ? (
            <motion.div
              key="sent"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              <p className="auth-heading">קוד נשלח!</p>
              <div className="success-banner">
                אם האימייל קיים במערכת, נשלח אליו קוד לאיפוס הסיסמה. הקוד בתוקף ל-15 דקות.
              </div>
              <motion.button
                className="auth-btn"
                style={{ marginTop: 20 }}
                onClick={() => navigate('/reset-password', { state: { email } })}
                whileTap={{ scale: 0.97 }}
              >
                המשך לאיפוס סיסמה
              </motion.button>
            </motion.div>
          ) : (
            <motion.form
              key="form"
              onSubmit={handleSubmit}
              noValidate
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              <p className="auth-heading">שכחת סיסמה?</p>
              <p className="auth-subtext">
                הזן את האימייל שלך ונשלח קוד חד-פעמי לאיפוס.
              </p>

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

              <div className="input-group">
                <label className="input-label" htmlFor="fp-email">אימייל</label>
                <input
                  id="fp-email"
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

              <motion.button
                type="submit"
                className="auth-btn"
                disabled={loading || !email}
                whileTap={{ scale: 0.97 }}
                aria-label="שלח קוד לאיפוס"
              >
                <Mail size={20} />
                {loading ? 'שולח...' : 'שלח קוד לאיפוס'}
              </motion.button>
            </motion.form>
          )}
        </AnimatePresence>

        <p className="auth-footer">
          <Link to="/login">חזרה להתחברות</Link>
        </p>
      </motion.div>
    </div>
  );
};

export default ForgotPassword;
