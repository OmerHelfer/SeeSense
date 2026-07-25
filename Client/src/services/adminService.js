/* ═══════════════════════════════════════════════════
   adminService.js
   Admin user-management API calls. All require an admin
   token (level 1+); level-2-only actions are enforced
   server-side and will 403 for level-1 admins.
   ═══════════════════════════════════════════════════ */

import apiClient from '../api/client';

/** GET /admin/overview → { total, online, offline, admins, admins_online, actor_level } */
export const getOverview = async () => {
  const { data } = await apiClient.get('/admin/overview');
  return data;
};

/** GET /admin/admins → { admins:[{user_id,name,email,admin_level,online,last_seen}], actor_level } */
export const getAdmins = async () => {
  const { data } = await apiClient.get('/admin/admins');
  return data;
};

/** GET /admin/user?email= → full admin view of a user (+ actor_level) */
export const getUserByEmail = async (email) => {
  const { data } = await apiClient.get('/admin/user', { params: { email } });
  return data; // { user, actor_level }
};

/** POST /admin/user/set_password */
export const setUserPassword = async (email, new_password) => {
  const { data } = await apiClient.post('/admin/user/set_password', { email, new_password });
  return data;
};

/** POST /admin/user/update — send only changed fields */
export const updateUser = async (email, fields) => {
  const { data } = await apiClient.post('/admin/user/update', { email, ...fields });
  return data; // { user }
};

/** POST /admin/user/set_level — level 2 only. admin_level ∈ {0,1,2} */
export const setUserLevel = async (email, admin_level) => {
  const { data } = await apiClient.post('/admin/user/set_level', { email, admin_level });
  return data;
};

/** DELETE /admin/user — level 2 only */
export const deleteUserByEmail = async (email) => {
  const { data } = await apiClient.delete('/admin/user', { data: { email } });
  return data;
};

// ── Feedback management ──────────────────────────────

/** GET /admin/feedback[?handling_status=] → { feedback:[...], stats, actor_level } */
export const getFeedbackAdmin = async (handling_status) => {
  const params = handling_status ? { handling_status } : {};
  const { data } = await apiClient.get('/admin/feedback', { params });
  return data;
};

/** POST /admin/feedback/{id}/take — pending → in progress, under the caller. (level 1+) */
export const takeFeedback = async (feedbackId) => {
  const { data } = await apiClient.post(`/admin/feedback/${feedbackId}/take`);
  return data.feedback;
};

/** POST /admin/feedback/{id}/resolve — response note required. (handling admin or L2) */
export const resolveFeedback = async (feedbackId, response) => {
  const { data } = await apiClient.post(`/admin/feedback/${feedbackId}/resolve`, { response });
  return data.feedback;
};

/** POST /admin/feedback/{id}/assign — assign to a specific admin. L2 only. */
export const assignFeedback = async (feedbackId, assigneeId) => {
  const { data } = await apiClient.post(`/admin/feedback/${feedbackId}/assign`, { assignee_id: assigneeId });
  return data.feedback;
};
