/* ═══════════════════════════════════════════════════
   settingsService.js
   AI detection settings API calls.
   All settings endpoints require user_id as a
   query parameter — passed via Axios `params`.
   ═══════════════════════════════════════════════════ */

import apiClient from '../api/client';

/**
 * GET /settings/get_settings?user_id={id}
 * Returns the user's current settings object.
 */
export const getSettings = async (userId) => {
  const { data } = await apiClient.get('/settings/get_settings', {
    params: { user_id: userId },
  });
  return data.settings;
};

/**
 * POST /settings/update_settings?user_id={id}
 * Send only the fields you want to change (all optional).
 *
 * @param {string} userId
 * @param {{
 *   alert_type?: 'audio'|'haptic'|'both',
 *   volume_intensity?: number,
 *   vibration_intensity?: number,
 *   detection_sensitivity?: 'low'|'medium'|'high',
 *   high_risk_classes?: string[]
 * }} settings
 */
export const updateSettings = async (userId, settings) => {
  const { data } = await apiClient.post('/settings/update_settings', settings, {
    params: { user_id: userId },
  });
  return data.settings;
};

/**
 * GET /settings/available_classes
 * Returns all 14 supported class name strings.
 */
export const getAvailableClasses = async () => {
  const { data } = await apiClient.get('/settings/available_classes');
  return data.classes;
};

/**
 * POST /settings/reset_settings?user_id={id}
 * Restores all settings to defaults.
 */
export const resetSettings = async (userId) => {
  const { data } = await apiClient.post('/settings/reset_settings', null, {
    params: { user_id: userId },
  });
  return data.settings;
};
