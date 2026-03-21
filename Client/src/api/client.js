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

export default apiClient;
