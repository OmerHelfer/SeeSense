import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
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

const SoundToggle = () => {
  const { isAuthenticated, user } = useAuth();
  const location = useLocation();
  const userId = user?.id ?? user?.user_id;

  const [muted, setMutedState] = useState(isMuted());

  useEffect(() => {
    if (!isAuthenticated || !userId) return;
    let cancelled = false;
    getSettings(userId)
      .then((s) => { if (!cancelled) seedFeedbackSettings(s); })
      .catch(() => {  });
    return () => { cancelled = true; };
  }, [isAuthenticated, userId]);

  useEffect(() => subscribeFeedback(() => setMutedState(isMuted())), []);

  if (!isAuthenticated || location.pathname !== '/') return null;

  const handleToggle = () => {
    toggleMuted();
    const nowMuted = isMuted();
    setMutedState(nowMuted);

    haptic('aligned');
    announceMute(nowMuted);

    if (userId) {
      const fb = getFeedbackSettings();
      updateSettings(userId, {
        volume_intensity: fb.volume_intensity,
        alert_type:       fb.alert_type,
      }).catch(() => {  });
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
