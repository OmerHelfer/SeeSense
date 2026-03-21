import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { UserPlus, ArrowRight } from 'lucide-react';

const Register = () => {
  const [formData, setFormData] = useState({ name: '', email: '', password: '' });
  const navigate = useNavigate();

  const handleSubmit = (e) => {
    e.preventDefault();
    console.log("Registering:", formData);
    navigate('/login');
  };

  return (
    <div className="auth-page">
      <header className="auth-header">
        <h1>הרשמה</h1>
        <p>הצטרף לקהילת SeeSense</p>
      </header>

      <form onSubmit={handleSubmit} className="auth-form">
        <div className="input-group">
          <label>שם מלא</label>
          <input 
            type="text" 
            placeholder="הכנס שם מלא"
            onChange={(e) => setFormData({...formData, name: e.target.value})}
            required 
          />
        </div>
        <div className="input-group">
          <label>אימייל</label>
          <input 
            type="email" 
            inputMode="email"
            placeholder="your@email.com"
            onChange={(e) => setFormData({...formData, email: e.target.value})}
            required 
          />
        </div>
        <div className="input-group">
          <label>סיסמה</label>
          <input 
            type="password" 
            placeholder="בחר סיסמה חזקה"
            onChange={(e) => setFormData({...formData, password: e.target.value})}
            required 
          />
        </div>

        <button type="submit" className="main-trigger">
          <UserPlus size={24} />
          צור חשבון
        </button>
      </form>

      <footer className="auth-footer">
        <p>כבר יש לך חשבון? <Link to="/login">התחבר כאן</Link></p>
      </footer>
    </div>
  );
};

export default Register;