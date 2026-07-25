import React, { useState, useEffect } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  isMuted,
  toggleMuted,
  subscribeFeedback,
  getFeedbackSettings,
  seedFeedbackSettings,
  haptic,
  announceMute,
} from '../services/feedbackService';
import { getSettings, updateSettings } from '../services/settingsService';

/**
 * Global sound toggle — a small floating button shown on every page while logged
 * in. It is a shortcut for the audio channel: tapping it mutes (volume 0) or
 * unmutes (volume 80%). State lives in the shared feedback store, so it stays in
 * sync with the volume slider in Settings, and is persisted to the DB.
 */
const SoundToggle = () => {
  const { isAuthenticated, user } = useAuth();
  const userId = user?.id ?? user?.user_id;

  const [muted, setMutedState] = useState(isMuted());

  // ── Seed the shared store from the DB once, so audio/haptic use the
  //    user's real preferences everywhere (not just after opening Settings). ──
  useEffect(() => {
    if (!isAuthenticated || !userId) return;
    let cancelled = false;
    getSettings(userId)
      .then((s) => { if (!cancelled) seedFeedbackSettings(s); })
      .catch(() => { /* keep cached defaults */ });
    return () => { cancelled = true; };
  }, [isAuthenticated, userId]);

  // ── Keep the icon in sync with the store (e.g. slider dragged to 0). ──
  useEffect(() => subscribeFeedback(() => setMutedState(isMuted())), []);

  if (!isAuthenticated) return null;

  const handleToggle = () => {
    toggleMuted();               // updates the shared runtime store
    const nowMuted = isMuted();
    setMutedState(nowMuted);

    haptic('aligned');           // tactile tick (no-op where unsupported, e.g. iOS)
    announceMute(nowMuted);      // spoken "שמע דלוק" / "שמע כבוי"

    // Persist the resulting volume (and any alert_type change from unmuting).
    if (userId) {
      const fb = getFeedbackSettings();
      updateSettings(userId, {
        volume_intensity: fb.volume_intensity,
        alert_type:       fb.alert_type,
      }).catch(() => { /* non-fatal: store already updated locally */ });
    }
  };

  return (
    <button
      className={`sound-toggle${muted ? ' muted' : ''}`}
      onClick={handleToggle}
      aria-label={muted ? 'הפעל קול' : 'השתק קול'}
      aria-pressed={muted}
      title={muted ? 'קול מושתק — לחץ להפעלה' : 'קול פעיל — לחץ להשתקה'}
    >
      {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
    </button>
  );
};

export default SoundToggle;
