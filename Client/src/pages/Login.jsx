import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { login as apiLogin } from '../services/authService';
import { consumeSessionExpiredNotice } from '../services/sessionExpiry';
import { Eye, EyeOff, LogIn, Scan } from 'lucide-react';
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

const Login = () => {
  const [email, setEmail]             = useState('');
  const [password, setPassword]       = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // If we landed here because the JWT expired, explain it instead of just showing
  // a blank login form the user didn't ask for.
  const [error, setError]             = useState(
    () => (consumeSessionExpiredNotice() ? 'החיבור פג תוקף. יש להתחבר מחדש.' : ''),
  );
  const [loading, setLoading]         = useState(false);
  const { login }  = useAuth();
  const navigate   = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await apiLogin({ email, password });
      login(data.user, data.token);
      navigate('/');
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setError(detail === 'Invalid email or password'
        ? 'האימייל או הסיסמה שגויים. נסה שוב.'
        : 'ההתחברות נכשלה. נסה שוב.');
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
          <p className="auth-heading">התחברות</p>

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
            <label className="input-label" htmlFor="login-email">אימייל</label>
            <input
              id="login-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              className={`input-field${error ? ' has-error' : ''}`}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </div>

          <div className="input-group">
            <label className="input-label" htmlFor="login-password">סיסמה</label>
            <div className="input-password-wrap">
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                className={`input-field${error ? ' has-error' : ''}`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
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
            disabled={loading || !email || !password}
            whileTap={{ scale: 0.97 }}
            aria-label="התחבר לחשבון"
          >
            <LogIn size={20} />
            {loading ? 'מתחבר...' : 'התחבר'}
          </motion.button>
        </form>

        <p className="auth-footer">
          <Link to="/forgot-password">שכחת סיסמה?</Link>
        </p>
        <p className="auth-footer">
          עוד לא רשום?&nbsp;<Link to="/register">צור חשבון חדש</Link>
        </p>
      </motion.div>
    </div>
  );
};

export default Login;
