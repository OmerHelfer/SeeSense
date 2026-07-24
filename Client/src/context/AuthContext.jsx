import { createContext, useState, useContext, useEffect } from 'react';

const AuthContext = createContext();

// Must match the key used in api/client.js interceptor
const TOKEN_KEY = 'token';
const USER_KEY  = 'seesense_user';

const loadStoredUser = () => {
  try {
    const stored = localStorage.getItem(USER_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
};

export const AuthProvider = ({ children }) => {
  // Rehydrate from localStorage so the session survives a page refresh
  const [user, setUser] = useState(loadStoredUser);

  const isAuthenticated = !!user;

  // Presence heartbeat — while logged in, ping the server every 30s so the user
  // reads as "online" in admin views even when not actively scanning the camera.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const beat = async () => {
      if (cancelled) return;
      const { heartbeat } = await import('../services/userService');
      heartbeat();
    };
    beat(); // immediate first beat
    const id = setInterval(beat, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [user]);

  /**
   * Call after a successful login or register.
   * @param {object} userData  - The user object returned by the backend
   *                             (must include user_id, name, email)
   * @param {string} token     - JWT returned by the backend
   */
  const login = (userData, token) => {
    // Normalise backend's user_id → id so all consumers can use user.id
    const normalised = { ...userData, id: userData.user_id };
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(normalised));
    setUser(normalised);
  };

  const logout = async () => {
    const { disconnectStream } = await import('../services/visionService');
    disconnectStream();

    try {
      const { default: apiClient } = await import('../api/client');
      await apiClient.post('/users/logout');
    } catch (e) {}

    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setUser(null);
};

  return (
    <AuthContext.Provider value={{ user, isAuthenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
