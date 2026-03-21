import apiClient from '../api/client';

/**
 * Converts a base64 data-URL (e.g. "data:image/jpeg;base64,/9j/...")
 * into a Blob so it can be sent as multipart/form-data.
 */
const dataURLtoBlob = (dataUrl) => {
  const [header, b64] = dataUrl.split(',');
  const mime          = header.match(/:(.*?);/)[1];
  const binary        = atob(b64);
  const bytes         = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};

/**
 * Sends a single JPEG frame to POST /analyze_frame for object detection.
 *
 * @param {string} base64DataUrl  JPEG frame as a base64 data-URL
 * @param {string} userId         User ID for session tracking (default: 'default')
 * @returns {Promise<{
 *   danger: boolean,
 *   alert_level: 'high'|'low'|'none',
 *   distance: 'Close'|'Medium'|'Far',
 *   objects_detected: Array<{class_name: string, confidence: number}>
 * }>}
 */
export const analyzeFrame = async (base64DataUrl, userId = 'default') => {
  const formData = new FormData();
  formData.append('file',    dataURLtoBlob(base64DataUrl), 'frame.jpg');
  formData.append('user_id', userId);

  const { data } = await apiClient.post('/analyze_frame', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });

  return data;
};
