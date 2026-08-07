import apiClient from '../api/client';

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

export const login = async ({ email, password }) => {
  const { data } = await apiClient.post('/users/login', { email, password });
  return data;
};
