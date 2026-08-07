import { createContext, useState, useContext, useEffect } from 'react';

const AuthContext = createContext();

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
  const [user, setUser] = useState(loadStoredUser);

  const isAuthenticated = !!user;

  useEffect(() => {
    let unsubscribe;
    import('../services/sessionExpiry').then(({ setSessionExpiredHandler }) => {
      unsubscribe = setSessionExpiredHandler(async () => {
        const { disconnectStream } = await import('../services/visionService');
        disconnectStream();
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        setUser(null);
      });
    });
    return () => { if (unsubscribe) unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const beat = async () => {
      if (cancelled) return;
      const { heartbeat } = await import('../services/userService');
      heartbeat();
    };
    beat();
    const id = setInterval(beat, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [user]);

  const login = (userData, token) => {
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
