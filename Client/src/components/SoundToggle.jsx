import React, { useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isMuted, toggleMuted } from '../services/feedbackService';

/**
 * Global sound toggle — a small floating button shown on every page while logged
 * in. Default is UNMUTED (sound plays). State is persisted in localStorage by
 * feedbackService, so it survives navigation and refresh.
 */
const SoundToggle = () => {
  const { isAuthenticated } = useAuth();
  const [muted, setMuted] = useState(isMuted());

  if (!isAuthenticated) return null;

  return (
    <button
      className={`sound-toggle${muted ? ' muted' : ''}`}
      onClick={() => setMuted(toggleMuted())}
      aria-label={muted ? 'הפעל קול' : 'השתק קול'}
      aria-pressed={muted}
      title={muted ? 'קול מושתק — לחץ להפעלה' : 'קול פעיל — לחץ להשתקה'}
    >
      {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
    </button>
  );
};

export default SoundToggle;
