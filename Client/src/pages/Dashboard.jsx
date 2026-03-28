import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LogOut, Settings, Home, Scan, VideoOff } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import CameraView      from '../components/CameraView';
import useOrientation  from '../hooks/useOrientation';
import { analyzeFrame }          from '../services/visionService';
import { haptic, announceDetections, speakMessage } from '../services/feedbackService';
import { emergencyAlert } from '../services/userService';

// ── Constants ────────────────────────────────────────────

const ALERT_LABELS = {
  high: '⚠ סכנה קרובה',
  low:  '! שים לב',
};

// ── Sub-components ───────────────────────────────────────

/** One corner bracket of the HUD frame */
const Corner = ({ position }) => (
  <div className={`hud-corner hud-corner-${position}`} />
);

/**
 * Spirit Level — gyroscope bubble indicator.
 * Bubble moves based on device tilt (beta/gamma).
 * Glows green when the device is aligned.
 */
const SpiritLevel = ({ beta, gamma, isAligned }) => {
  const CONTAINER_R = 23; // (62px container - 16px bubble) / 2
  const clamp       = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // gamma = left/right tilt, beta deviation = front/back tilt from vertical
  const bubbleX = clamp((gamma ?? 0) * 0.38, -CONTAINER_R, CONTAINER_R);
  const bubbleY = clamp(((beta ?? 90) - 90) * 0.38, -CONTAINER_R, CONTAINER_R);

  return (
    <div className={`spirit-level-wrap${isAligned ? ' aligned' : ''}`}>
      <div className={`spirit-level ${isAligned ? 'aligned' : 'tilted'}`}>
        <div
          className="spirit-bubble"
          style={{
            left:      `calc(50% + ${bubbleX}px)`,
            top:       `calc(50% + ${bubbleY}px)`,
            transform: 'translate(-50%, -50%)',
          }}
        />
        <div className="spirit-crosshair" />
      </div>
      <span className="spirit-label">
        {isAligned ? '⬤ מיושר' : '◯ יישר מצלמה'}
      </span>
    </div>
  );
};

// ── Dashboard ────────────────────────────────────────────

const Dashboard = () => {
  const { logout, user }            = useAuth();
  const navigate                    = useNavigate();
  const [isScanning, setIsScanning] = useState(false);
  const [alertLevel, setAlertLevel] = useState('none'); // 'none' | 'low' | 'high'

  // Gyroscope — isAligned: beta within ±15° of 90° (phone held upright)
  const { beta, gamma, isAligned, requestPermission } = useOrientation();

  /* ── Refs: let handleFrameCapture read latest state
     without being re-created (which would reset the 500ms interval) ── */
  const isScanningRef  = useRef(isScanning);
  const isAlignedRef   = useRef(isAligned);
  const isAnalyzingRef = useRef(false);       // prevent concurrent API calls
  const userIdRef      = useRef(user?.id ?? 'default');
  const prevAlignedRef = useRef(isAligned);

  // ── SOS state ──
  // 'idle' | 'pressing' | 'sending' | 'sent'
  const [sosState, setSosState]       = useState('idle');
  const [sosProgress, setSosProgress] = useState(0); // 0–1 during long-press
  const sosRafRef                     = useRef(null);
  const sosStartRef                   = useRef(null);

  useEffect(() => { isScanningRef.current = isScanning;        }, [isScanning]);
  useEffect(() => { isAlignedRef.current  = isAligned;         }, [isAligned]);
  useEffect(() => { userIdRef.current     = user?.id ?? 'default'; }, [user]);

  /* ── Haptic feedback when device becomes aligned while scanning ── */
  useEffect(() => {
    if (isScanning && isAligned && !prevAlignedRef.current) {
      haptic('aligned');
    }
    prevAlignedRef.current = isAligned;
  }, [isAligned, isScanning]);

  /* ── Start / Stop scanning ── */
  const toggleScan = async () => {
    const next = !isScanning;

    // On iOS 13+, gyroscope permission must be requested from a user gesture
    if (next) await requestPermission();

    setIsScanning(next);
    if (!next) setAlertLevel('none');
    haptic(next ? 'start' : 'stop');
  };

  /* ── Frame analysis loop ──
     Stable callback (empty deps) — reads live values via refs.
     Called by CameraView every 500 ms with a base64 JPEG data-URL. */
  const handleFrameCapture = useCallback(async (base64Frame) => {
    // Gate: only analyze when actively scanning AND camera is aligned
    if (!isScanningRef.current || !isAlignedRef.current) return;

    // Skip this frame if the previous API call hasn't resolved yet
    if (isAnalyzingRef.current) return;
    isAnalyzingRef.current = true;

    try {
      const result  = await analyzeFrame(base64Frame, userIdRef.current);
      const level   = result.alert_level ?? 'none';
      const objects = result.objects ?? [];

      setAlertLevel(level);

      if (result.danger) {
        haptic('danger');
        // Prefer the backend's pre-composed alert_message; fall back to class-name mapping
        const alertMsg = objects[0]?.alert_message;
        if (alertMsg) speakMessage(alertMsg);
        else          announceDetections(objects);
      } else if (level === 'low') {
        haptic('detection');
        announceDetections(objects);
      }
    } catch (err) {
      // Network / server error — don't crash, just log
      console.warn('[SeeSense] Frame analysis failed:', err?.message);
    } finally {
      isAnalyzingRef.current = false;
    }
  }, []); // stable reference — no deps, reads state through refs

  /* ── SOS: long-press handlers ──
     Hold for 2 s → get GPS → POST /users/emergency_alert */
  const handleSOSDown = (e) => {
    e.preventDefault();
    if (sosState !== 'idle') return;
    setSosState('pressing');
    haptic('aligned'); // subtle acknowledgement tick
    sosStartRef.current = Date.now();

    const tick = () => {
      const progress = Math.min((Date.now() - sosStartRef.current) / 2000, 1);
      setSosProgress(progress);
      if (progress < 1) {
        sosRafRef.current = requestAnimationFrame(tick);
      } else {
        fireSOS();
      }
    };
    sosRafRef.current = requestAnimationFrame(tick);
  };

  const cancelSOS = () => {
    if (sosRafRef.current) {
      cancelAnimationFrame(sosRafRef.current);
      sosRafRef.current = null;
    }
    if (sosState === 'pressing') {
      setSosState('idle');
      setSosProgress(0);
    }
  };

  const fireSOS = () => {
    if (sosRafRef.current) {
      cancelAnimationFrame(sosRafRef.current);
      sosRafRef.current = null;
    }
    setSosState('sending');
    setSosProgress(1);
    haptic('danger');

    const send = async (lat, lon) => {
      try {
        await emergencyAlert({
          user_id: userIdRef.current,
          gps_lat: lat,
          gps_lon: lon,
        });
      } catch (err) {
        console.warn('[SeeSense] Emergency alert failed:', err?.message);
      }
      setSosState('sent');
      setSosProgress(0);
      setTimeout(() => setSosState('idle'), 3000);
    };

    navigator.geolocation.getCurrentPosition(
      (pos) => send(pos.coords.latitude, pos.coords.longitude),
      ()    => send(0, 0),
      { timeout: 5000, enableHighAccuracy: true }
    );
  };

  /* ── CSS class string for corner brackets ── */
  const bracketClass = [
    'hud-brackets',
    isScanning ? 'active'  : '',
    isScanning && isAligned ? 'aligned' : '',
  ].filter(Boolean).join(' ');

  /* ── LIVE badge label ── */
  const badgeLabel = !isScanning ? 'IDLE'
    : isAligned ? 'TRACKING'
    : 'LIVE';

  // ── Render ────────────────────────────────────────

  return (
    <motion.div
      className="dashboard-page"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
    >
      {/* ── Header ── */}
      <header className="dashboard-header">
        <span className="header-brand">SEE<span>SENSE</span></span>
        <div className="header-actions">
          <button className="icon-btn" onClick={() => navigate('/settings')} aria-label="הגדרות">
            <Settings size={20} />
          </button>
          <button className="icon-btn" onClick={logout} aria-label="יציאה">
            <LogOut size={20} />
          </button>
        </div>
      </header>

      {/* ── Camera + HUD ── */}
      <main className={[
        'camera-viewport',
        isScanning ? 'scanning' : '',
        alertLevel === 'high' ? 'danger-border' : '',
      ].filter(Boolean).join(' ')}>
        <CameraView isActive={isScanning} onFrameCapture={handleFrameCapture} />

        {/* Non-interactive HUD elements */}
        <div className="hud-overlay">

          {/* Corner brackets: gray → cyan (active) → green (aligned) */}
          <div className={bracketClass}>
            <Corner position="tl" />
            <Corner position="tr" />
            <Corner position="bl" />
            <Corner position="br" />
          </div>

          {/* Status badge */}
          <div className="hud-top-row">
            <div className={`live-badge${isScanning ? ' active' : ''}`}>
              <div className={`status-dot${isScanning ? ' active' : ''}`} />
              {badgeLabel}
            </div>
          </div>

          {/* Scan sweep line — only shown when scanning AND aligned (frames are being sent) */}
          {isScanning && isAligned && <div className="scan-line" />}

          {/* Tilt warning — shown when scanning but device is not aligned */}
          <AnimatePresence>
            {isScanning && !isAligned && (
              <motion.div
                className="alignment-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                aria-live="polite"
              >
                <span className="alignment-icon" aria-hidden="true">📱</span>
                <p className="alignment-text">הטה את המכשיר</p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Gyroscope spirit level */}
          <SpiritLevel beta={beta} gamma={gamma} isAligned={isAligned} />
        </div>

        {/* Danger / caution alert overlay */}
        <AnimatePresence>
          {isScanning && alertLevel !== 'none' && (
            <motion.div
              className={`alert-overlay ${alertLevel}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              role="alert"
              aria-live="assertive"
            >
              <span className="alert-pill">{ALERT_LABELS[alertLevel]}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Idle overlay — shown when camera is off */}
        <AnimatePresence>
          {!isScanning && (
            <motion.div
              className="idle-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              aria-hidden="true"
            >
              <div className="idle-icon"><VideoOff size={38} /></div>
              <p>לחץ להפעלת הסריקה</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── SOS Emergency Button ── */}
        <div
          className={`sos-btn sos-${sosState}`}
          onPointerDown={handleSOSDown}
          onPointerUp={cancelSOS}
          onPointerLeave={cancelSOS}
          onContextMenu={(e) => e.preventDefault()}
          role="button"
          aria-label="כפתור חירום — לחץ לחיצה ארוכה (2 שניות) לשליחת התראה"
        >
          {/* SVG progress ring — fills clockwise as user holds */}
          <svg className="sos-ring" viewBox="0 0 80 80" aria-hidden="true">
            <circle
              cx="40" cy="40" r="36"
              fill="none"
              stroke="rgba(255,255,255,0.9)"
              strokeWidth="3.5"
              strokeDasharray={`${sosProgress * 226.2} 226.2`}
              strokeLinecap="round"
              transform="rotate(-90 40 40)"
            />
          </svg>
          <span className="sos-label">
            {sosState === 'sent' ? '✓' : sosState === 'sending' ? '...' : 'SOS'}
          </span>
        </div>
      </main>

      {/* ── Main scan button ── */}
      <div className="scan-btn-wrap">
        <motion.button
          className={`scan-btn ${isScanning ? 'stop' : 'start'}`}
          onClick={toggleScan}
          aria-label={isScanning ? 'עצור סריקה' : 'התחל סריקה'}
          aria-pressed={isScanning}
          whileTap={{ scale: 0.96 }}
          layout
        >
          <span className="scan-btn-icon">
            {isScanning ? <VideoOff size={24} /> : <Scan size={24} />}
          </span>
          <AnimatePresence mode="wait">
            <motion.span
              key={isScanning ? 'stop' : 'start'}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}
            >
              {isScanning ? 'עצור סריקה' : 'התחל סריקה'}
            </motion.span>
          </AnimatePresence>
        </motion.button>
      </div>

      {/* ── Floating glass tab bar ── */}
      <div className="tab-bar-wrap">
        <nav className="tab-bar" role="navigation" aria-label="ניווט ראשי">
          <button className="tab-btn" onClick={logout} aria-label="יציאה">
            <LogOut size={20} />
            <span>יציאה</span>
          </button>
          <button className="tab-btn tab-home" aria-label="בית" aria-current="page">
            <Home size={22} />
            <span>בית</span>
          </button>
          <button className="tab-btn" onClick={() => navigate('/settings')} aria-label="הגדרות">
            <Settings size={20} />
            <span>הגדרות</span>
          </button>
        </nav>
      </div>
    </motion.div>
  );
};

export default Dashboard;
