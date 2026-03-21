import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LogIn, Eye, EyeOff } from 'lucide-react';

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = (e) => {
    e.preventDefault();
    // Simulate API login
    login({ email, id: '123' });
    navigate('/');
  };

  return (
    <div className="auth-page">
      <header className="auth-header">
        <h1>SeeSense</h1>
        <p>מערכת עזר חכמה לניידות</p>
      </header>

      <form onSubmit={handleSubmit} className="auth-form">
        <div className="input-group">
          <label htmlFor="email">אימייל</label>
          <input 
            id="email"
            type="email" 
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
            required 
          />
        </div>

        <div className="input-group">
          <label htmlFor="password">סיסמה</label>
          <div className="password-wrapper">
            <input 
              id="password"
              type={showPassword ? "text" : "password"} 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="הכנס סיסמה"
              required 
            />
            <button 
              type="button" 
              className="toggle-password"
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? <EyeOff size={24} /> : <Eye size={24} />}
            </button>
          </div>
        </div>

        <button type="submit" className="main-trigger">
          <LogIn size={24} />
          התחברות
        </button>
      </form>

      <footer className="auth-footer">
        <p>עוד לא רשום? <Link to="/register">צור חשבון חדש</Link></p>
      </footer>
    </div>
  );
};

export default Login;