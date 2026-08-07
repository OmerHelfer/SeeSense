
import apiClient from '../api/client';

export const getSettings = async (userId) => {
  const { data } = await apiClient.get('/settings/get_settings', {
    params: { user_id: userId },
  });
  return data.settings;
};

export const updateSettings = async (userId, settings) => {
  const { data } = await apiClient.post('/settings/update_settings', settings, {
    params: { user_id: userId },
  });
  return data.settings;
};

export const getAvailableClasses = async () => {
  const { data } = await apiClient.get('/settings/available_classes');
  return data.classes;
};

export const resetSettings = async (userId) => {
  const { data } = await apiClient.post('/settings/reset_settings', null, {
    params: { user_id: userId },
  });
  return data.settings;
};
