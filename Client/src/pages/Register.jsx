import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Eye, EyeOff, UserPlus, Scan } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

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

const Register = () => {
  const [name, setName]               = useState('');
  const [email, setEmail]             = useState('');
  const [password, setPassword]       = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError]             = useState('');
  const [loading, setLoading]         = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (password.length < 6) {
      setError('הסיסמה חייבת להכיל לפחות 6 תווים.');
      return;
    }

    setLoading(true);
    try {
      // TODO: replace with → POST /users/register
      console.log('Registering:', { name, email });
      navigate('/login');
    } catch {
      setError('ההרשמה נכשלה. נסה שוב.');
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
        {/* Logo */}
        <div className="auth-logo">
          <div className="auth-logo-mark">
            <Scan size={28} strokeWidth={2.5} />
          </div>
          <div>
            <h1 className="auth-logo-name">SEE<span>SENSE</span></h1>
            <p className="auth-logo-tagline">ניווט חכם לעצמאות מלאה</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <p className="auth-heading">צור חשבון חדש</p>

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
            <label className="input-label" htmlFor="reg-name">שם מלא</label>
            <input
              id="reg-name"
              type="text"
              autoComplete="name"
              className="input-field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ישראל ישראלי"
              required
            />
          </div>

          <div className="input-group">
            <label className="input-label" htmlFor="reg-email">אימייל</label>
            <input
              id="reg-email"
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

          <div className="input-group">
            <label className="input-label" htmlFor="reg-password">סיסמה</label>
            <div className="input-password-wrap">
              <input
                id="reg-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                className="input-field"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="לפחות 6 תווים"
                required
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'הסתר סיסמה' : 'הצג סיסמה'}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <motion.button
            type="submit"
            className="auth-btn"
            disabled={loading || !name || !email || !password}
            whileTap={{ scale: 0.97 }}
            aria-label="צור חשבון חדש"
          >
            <UserPlus size={20} />
            {loading ? 'יוצר חשבון...' : 'צור חשבון'}
          </motion.button>
        </form>

        <p className="auth-footer">
          כבר יש לך חשבון?&nbsp;<Link to="/login">התחבר</Link>
        </p>
      </motion.div>
    </div>
  );
};

export default Register;
