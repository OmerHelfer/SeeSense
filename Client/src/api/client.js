import axios from 'axios';

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL,
  timeout: 8000,
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

const PUBLIC_AUTH_PATHS = ['/users/login', '/users/register', '/users/forgot-password', '/users/reset-password'];

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
