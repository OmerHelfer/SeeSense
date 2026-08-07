
   import apiClient from '../api/client';

   
   export const getProfile = async () => {
     const { data } = await apiClient.get('/users/profile');
     return data.user;
   };
   
   export const updateProfile = async (fields) => {
     const { data } = await apiClient.post('/users/profile/update', fields);
     return data.user;
   };
   
   export const changePassword = async ({ old_password, new_password }) => {
     const { data } = await apiClient.post('/users/change_password', {
       old_password,
       new_password,
     });
     return data;
   };
   
   export const deleteAccount = async () => {
     const { data } = await apiClient.delete('/users/account');
     return data;
   };

   export const heartbeat = async () => {
     try { await apiClient.post('/users/heartbeat'); } catch {  }
   };
   
   
   export const getContacts = async () => {
     const { data } = await apiClient.get('/users/contacts');
     return data.contacts;
   };
   
   export const addContact = async ({ name, phone, email }) => {
     const { data } = await apiClient.post('/users/contacts/add', {
       name,
       phone,
       email,
     });
     return data;
   };
   
   export const verifyContact = async ({ email, code }) => {
     const { data } = await apiClient.post('/users/contacts/verify', {
       email,
       code,
     });
     return data;
   };
   
   export const resendCode = async ({ email }) => {
     const { data } = await apiClient.post('/users/contacts/resend_code', {
       email,
     });
     return data;
   };
   
   export const removeContact = async ({ email }) => {
     const { data } = await apiClient.delete('/users/contacts/remove', {
       data: { email },
     });
     return data;
   };
   
   
   export const emergencyAlert = async ({ gps_lat, gps_lon }) => {
     const { data } = await apiClient.post('/users/emergency_alert', {
       gps_lat,
       gps_lon,
     });
     return data;
   };

   export const getEmergencyAlerts = async () => {
     const { data } = await apiClient.get('/users/emergency_alerts');
     return data.alerts ?? [];
   };
   
   export const getHistory = async ({ limit = 50, period = 'all', session_id } = {}) => {
     const params = { limit, period };
     if (session_id) params.session_id = session_id;
     const { data } = await apiClient.get('/users/history', { params });
     return data;
   };
   
   export const deleteHistoryRecord = async (record_id) => {
     const { data } = await apiClient.delete(`/users/history/${record_id}`);
     return data;
   };
   
   export const clearHistory = async () => {
     const { data } = await apiClient.delete('/users/history');
     return data;
   };
   
   export const feedbackFromHistory = async ({ record_id, feedback_type, notes }) => {
     const { data } = await apiClient.post('/users/feedback/from_history', {
       record_id,
       feedback_type,
       ...(notes ? { notes } : {}),
     });
     return data;
   };
   
   
   export const quickFeedback = async ({ feedback_type, record_id }) => {
     const body = { feedback_type };
     if (record_id) body.record_id = record_id;
     const { data } = await apiClient.post('/users/feedback/quick', body);
     return data;
   };
   
   export const generalFeedback = async ({ feedback_type, notes }) => {
     const { data } = await apiClient.post('/users/feedback/general', {
       feedback_type,
       ...(notes ? { notes } : {}),
     });
     return data;
   };
   
   export const getPendingFeedback = async () => {
     const { data } = await apiClient.get('/users/feedback/pending');
     return data.feedback ?? [];
   };
   
   export const getSubmittedFeedback = async () => {
     const { data } = await apiClient.get('/users/feedback/all');
     return (data.feedback ?? []).filter((f) => f.status === 'submitted');
   };
   
   export const submitFeedback = async (feedback_id, { notes, feedback_type } = {}) => {
     if ((notes && notes.trim()) || feedback_type) {
       const body = {};
       if (notes && notes.trim()) body.notes = notes.trim();
       if (feedback_type) body.feedback_type = feedback_type;
       const { data } = await apiClient.post(`/users/feedback/${feedback_id}/update`, body);
       return data;
     } else {
       const { data } = await apiClient.post(`/users/feedback/${feedback_id}/submit`);
       return data;
     }
   };

   export const updateFeedback = async (feedback_id, { feedback_type, notes }) => {
     const body = {};
     if (feedback_type) body.feedback_type = feedback_type;
     if (notes !== undefined) body.notes = notes;
     const { data } = await apiClient.post(`/users/feedback/${feedback_id}/update`, body);
     return data;
   };

   export const getFeedbackRecordIds = async () => {
     const { data } = await apiClient.get('/users/feedback/all');
     const ids = new Set();
     for (const fb of (data.feedback ?? [])) {
       if (fb.record_id) ids.add(fb.record_id);
     }
     return ids;
   };
   
   
   export const deleteFeedback = async (feedback_id) => {
     const { data } = await apiClient.delete(`/users/feedback/${feedback_id}`);
     return data;
   };

   export const getUnseenResponseCount = async () => {
     try {
       const { data } = await apiClient.get('/users/feedback/responses/unseen_count');
       return data.count ?? 0;
     } catch { return 0; }
   };

   export const markResponsesSeen = async () => {
     const { data } = await apiClient.post('/users/feedback/responses/seen');
     return data;
   };
   
   export const forgotPassword = async ({ email }) => {
     const { data } = await apiClient.post('/users/forgot_password', { email });
     return data;
   };
   
   export const resetPassword = async ({ email, code, new_password }) => {
     const { data } = await apiClient.post('/users/reset_password', {
       email,
       code,
       new_password,
     });
     return data;
   };