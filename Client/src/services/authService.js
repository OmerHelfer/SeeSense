import apiClient from '../api/client';

/**
 * Register a new user.
 * POST /users/register — JSON body, no auth required.
 * @returns {{ status, message, user, token }}
 */
export const register = async ({ name, email, phone, password, country }) => {
  const { data } = await apiClient.post('/users/register', {
    name,
    email,
    phone,
    password,
    country,
  });
  return data;
};

/**
 * Authenticate an existing user.
 * POST /users/login — JSON body, no auth required.
 * @returns {{ status, message, user, token }}
 */
export const login = async ({ email, password }) => {
  const { data } = await apiClient.post('/users/login', { email, password });
  return data;
};
