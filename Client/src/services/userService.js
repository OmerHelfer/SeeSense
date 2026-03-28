/* ═══════════════════════════════════════════════════
   userService.js
   All user, profile, contacts, and password API calls.
   Token is auto-attached by api/client.js interceptor.
   ═══════════════════════════════════════════════════ */

import apiClient from '../api/client';

// ── Profile ──────────────────────────────────────────

/** GET /users/profile — returns the user object (id from JWT) */
export const getProfile = async () => {
  const { data } = await apiClient.get('/users/profile');
  return data.user;
};

/**
 * POST /users/profile/update — send only the fields you want to change.
 * Updatable: name, phone, country, date_of_birth, height_cm, weight_kg
 */
export const updateProfile = async (fields) => {
  const { data } = await apiClient.post('/users/profile/update', fields);
  return data.user;
};

/**
 * POST /users/change_password
 * @param {{ old_password: string, new_password: string }} payload
 */
export const changePassword = async ({ old_password, new_password }) => {
  const { data } = await apiClient.post('/users/change_password', {
    old_password,
    new_password,
  });
  return data;
};

/** DELETE /users/account — JWT alone authorises deletion, no password needed */
export const deleteAccount = async () => {
  const { data } = await apiClient.delete('/users/account');
  return data;
};

// ── Emergency Contacts ────────────────────────────────

/** GET /users/contacts — returns array of contact objects */
export const getContacts = async () => {
  const { data } = await apiClient.get('/users/contacts');
  return data.contacts;
};

/**
 * POST /users/contacts/add — max 5 contacts.
 * Side-effect: sends 6-digit verification code to contact's email (30 min TTL).
 * @param {{ name: string, phone: string, email: string }} contact
 */
export const addContact = async ({ name, phone, email }) => {
  const { data } = await apiClient.post('/users/contacts/add', {
    name,
    phone,
    email,
  });
  return data;
};

/**
 * POST /users/contacts/verify — 3 wrong attempts auto-removes the contact.
 * @param {{ email: string, code: string }} payload
 */
export const verifyContact = async ({ email, code }) => {
  const { data } = await apiClient.post('/users/contacts/verify', {
    email,
    code,
  });
  return data;
};

/**
 * POST /users/contacts/resend_code
 * @param {{ email: string }} payload — contact's email
 */
export const resendCode = async ({ email }) => {
  const { data } = await apiClient.post('/users/contacts/resend_code', {
    email,
  });
  return data;
};

/**
 * DELETE /users/contacts/remove
 * @param {{ email: string }} payload — contact's email
 */
export const removeContact = async ({ email }) => {
  // Axios DELETE with JSON body requires the `data` key in config
  const { data } = await apiClient.delete('/users/contacts/remove', {
    data: { email },
  });
  return data;
};

// ── Emergency Alert ───────────────────────────────────

/**
 * POST /users/emergency_alert — No auth required (intentionally open).
 * Sends GPS location to all verified emergency contacts via email.
 *
 * @param {{ user_id: string, gps_lat: number, gps_lon: number, message?: string }} payload
 */
export const emergencyAlert = async ({ user_id, gps_lat, gps_lon, message = 'Emergency alert triggered' }) => {
  const { data } = await apiClient.post('/users/emergency_alert', {
    user_id,
    gps_lat,
    gps_lon,
    message,
  });
  return data;
};

// ── Password Recovery ─────────────────────────────────

/**
 * POST /users/forgot_password (rate-limited: 3/min)
 * Always returns 200 even if email not found (security).
 * Side-effect: sends 6-digit code email (15 min TTL).
 * @param {{ email: string }} payload
 */
export const forgotPassword = async ({ email }) => {
  const { data } = await apiClient.post('/users/forgot_password', { email });
  return data;
};

/**
 * POST /users/reset_password
 * @param {{ email: string, code: string, new_password: string }} payload
 */
export const resetPassword = async ({ email, code, new_password }) => {
  const { data } = await apiClient.post('/users/reset_password', {
    email,
    code,
    new_password,
  });
  return data;
};
