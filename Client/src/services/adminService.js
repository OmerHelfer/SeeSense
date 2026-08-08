
import apiClient from '../api/client';

export const getOverview = async () => {
  const { data } = await apiClient.get('/admin/api/overview');
  return data;
};

export const getAdmins = async () => {
  const { data } = await apiClient.get('/admin/api/admins');
  return data;
};

export const getUserByEmail = async (email) => {
  const { data } = await apiClient.get('/admin/api/user', { params: { email } });
  return data;
};

export const setUserPassword = async (email, new_password) => {
  const { data } = await apiClient.post('/admin/api/user/set_password', { email, new_password });
  return data;
};

export const updateUser = async (email, fields) => {
  const { data } = await apiClient.post('/admin/api/user/update', { email, ...fields });
  return data;
};

export const setUserLevel = async (email, admin_level) => {
  const { data } = await apiClient.post('/admin/api/user/set_level', { email, admin_level });
  return data;
};

export const deleteUserByEmail = async (email) => {
  const { data } = await apiClient.delete('/admin/api/user', { data: { email } });
  return data;
};



export const getStreamConfig = async () => {
  const { data } = await apiClient.get('/admin/api/stream-config');
  return data;
};

export const updateStreamConfig = async (fields) => {
  const { data } = await apiClient.put('/admin/api/stream-config', fields);
  return data.config;
};

export const resetStreamConfig = async () => {
  const { data } = await apiClient.delete('/admin/api/stream-config');
  return data.config;
};


export const getFeedbackAdmin = async (handling_status) => {
  const params = handling_status ? { handling_status } : {};
  const { data } = await apiClient.get('/admin/api/feedback', { params });
  return data;
};

export const takeFeedback = async (feedbackId) => {
  const { data } = await apiClient.post(`/admin/api/feedback/${feedbackId}/take`);
  return data.feedback;
};

export const resolveFeedback = async (feedbackId, response) => {
  const { data } = await apiClient.post(`/admin/api/feedback/${feedbackId}/resolve`, { response });
  return data.feedback;
};

export const assignFeedback = async (feedbackId, assigneeId) => {
  const { data } = await apiClient.post(`/admin/api/feedback/${feedbackId}/assign`, { assignee_id: assigneeId });
  return data.feedback;
};
