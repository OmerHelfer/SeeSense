import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login            from './pages/Login';
import Register         from './pages/Register';
import ForgotPassword   from './pages/ForgotPassword';
import ResetPassword    from './pages/ResetPassword';
import Dashboard        from './pages/Dashboard';
import Profile           from './pages/Profile';
import Settings          from './pages/Settings';
import EmergencyContacts from './pages/EmergencyContacts';
import History           from './pages/History';
import './styles/global.css';

const ProtectedRoute = ({ children }) => {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? children : <Navigate to="/login" />;
};

const AnimatedRoutes = () => {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        {/* Public */}
        <Route path="/login"           element={<Login />} />
        <Route path="/register"        element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password"  element={<ResetPassword />} />

        {/* Protected */}
        <Route
          path="/"
          element={
            <ProtectedRoute><Dashboard /></ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute><Settings /></ProtectedRoute>
          }
        />
        <Route
          path="/profile"
          element={
            <ProtectedRoute><Profile /></ProtectedRoute>
          }
        />
        <Route
          path="/contacts"
          element={
            <ProtectedRoute><EmergencyContacts /></ProtectedRoute>
          }
        />
        <Route
          path="/history"
          element={
            <ProtectedRoute><History /></ProtectedRoute>
          }
        />
      </Routes>
    </AnimatePresence>
  );
};

function App() {
  return (
    <AuthProvider>
      <Router>
        <AnimatedRoutes />
      </Router>
    </AuthProvider>
  );
}

export default App;
