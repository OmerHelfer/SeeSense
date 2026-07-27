import axios from 'axios';

/**
 * Pre-configured Axios instance for the SeeSense FastAPI backend.
 * Base URL is read from VITE_API_URL in the .env file.
 */
const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL,
  timeout: 8000,
});

// Attach JWT token from localStorage on every request (when available)
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/**
 * Endpoints where a 401 means "wrong credentials", NOT "your session died".
 * Logging the user out because they mistyped a password would be absurd.
 */
const PUBLIC_AUTH_PATHS = ['/users/login', '/users/register', '/users/forgot-password', '/users/reset-password'];

// A 401 on any authenticated call means the JWT is expired/revoked/invalid — end
// the session so the app redirects to /login instead of spraying console errors.
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error?.response?.status;
    const url    = error?.config?.url || '';
    const isPublicAuthCall = PUBLIC_AUTH_PATHS.some((p) => url.includes(p));

    if (status === 401 && !isPublicAuthCall && localStorage.getItem('token')) {
      const { notifySessionExpired } = await import('../services/sessionExpiry');
      notifySessionExpired();
    }
    return Promise.reject(error);
  },
);

export default apiClient;
