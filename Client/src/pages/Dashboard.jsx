import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LogOut, Settings, Home, Scan, VideoOff, Flag } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import CameraView      from '../components/CameraView';
import useOrientation  from '../hooks/useOrientation';
import { VisionStream, setActiveStream }          from '../services/visionService';
import { haptic, announceDetections, speakMessage, HEBREW_NAMES } from '../services/feedbackService';
import { emergencyAlert, quickFeedback } from '../services/userService';
import { startHealthWatch, stopHealthWatch } from '../services/healthService';

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

/** Health status indicator dot + live latency (ms) + label */
const HealthDot = ({ status, rtt }) => {
  if (status === 'idle') return null;
  const colors = { green: '#22c55e', yellow: '#eab308', orange: '#f97316', red: '#ef4444' };
  const labels = { green: '', yellow: 'חיבור לא יציב', orange: 'חיבור חלש', red: 'אין חיבור' };
  const showLabel = status !== 'green';
  // Exact latency so the user knows precisely where the connection stands.
  // No reading (timeout / lost) → em dash.
  const rttText = rtt != null ? `${rtt} ms` : ' ';
  return (
    <div className="health-dot-wrap" title={labels[status] || rttText}>
      <div
        className={`health-dot ${status}`}
        style={{ backgroundColor: colors[status] }}
      />
      <span className="health-ms" style={{ color: colors[status] }}>
        {rttText}
      </span>
      {showLabel && (
        <span className="health-label" style={{ color: colors[status] }}>
          {labels[status]}
        </span>
      )}
    </div>
  );
};

// ── Dashboard ────────────────────────────────────────────

const Dashboard = () => {
  const { logout, user }            = useAuth();
  const navigate                    = useNavigate();
  const [isScanning, setIsScanning]       = useState(false);
  const [alertLevel, setAlertLevel]       = useState('none');   // 'none' | 'low' | 'high'
  const [healthStatus, setHealthStatus]   = useState('idle');   // 'idle' | 'green' | 'yellow' | 'red'
  const [healthRtt, setHealthRtt]         = useState(null);     // last ping RTT in ms (null = no reading)
  const [detectionDir, setDetectionDir]   = useState(null);     // 'left' | 'right' | 'center' | null
  const [detectedClass, setDetectedClass] = useState(null);     // hebrew class name of leading object
  const [detections, setDetections]       = useState([]);       // per-frame boxes for the overlay
  const [quickReportState, setQuickReportState] = useState('idle'); // 'idle' | 'sent'
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [captureFps, setCaptureFps]       = useState(4);        // driven by server TARGET_FPS on connect
  const [inputSize, setInputSize]         = useState(640);      // driven by server input_size on connect

  // Gyroscope — isAligned: beta within ±15° of 90° (phone held upright)
  const { beta, gamma, isAligned, requestPermission } = useOrientation();

  /* ── Refs: let handleFrameCapture read latest state
     without being re-created (which would reset the 250ms interval) ── */
  const isScanningRef  = useRef(isScanning);
  const isAlignedRef   = useRef(isAligned);
  const userIdRef       = useRef(user?.id ?? 'default');
  const visionStreamRef    = useRef(null);       // active VisionStream instance
  const prevAlignedRef     = useRef(isAligned);
  const quickReportTimerRef = useRef(null);      // quick-report reset timer
  const lastRecordIdRef    = useRef(null);       // record_id from last detection

  // ── Feedback state ──
  // 'hidden' | 'visible' | 'sent'
  const [feedbackState, setFeedbackState] = useState('hidden');
  const feedbackTimerRef = useRef(null);        // auto-hide timer

  // ── SOS state ──
  // 'idle' | 'sending' | 'sent'  (single tap → sending → sent → idle)
  const [sosState, setSosState]       = useState('idle');

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

  /* ── Permanent quick-report button (bottom-left, always visible while scanning) ── */
  const handleQuickReport = useCallback(async () => {
    if (quickReportState === 'sent') return;
    haptic('aligned');
    speakMessage('פידבק מהיר נשמר בהצלחה');
    setQuickReportState('sent');
    try {
      await quickFeedback({ feedback_type: 'wrong_detection', record_id: lastRecordIdRef.current });
    } catch (err) {
      console.warn('[SeeSense] Quick report failed:', err?.message);
    }
    quickReportTimerRef.current = setTimeout(() => setQuickReportState('idle'), 2500);
  }, [quickReportState]);

  /* ── Show feedback button for 3.5 s after any detection ── */
  const showFeedbackBriefly = useCallback(() => {
    clearTimeout(feedbackTimerRef.current);
    setFeedbackState('visible');
    feedbackTimerRef.current = setTimeout(() => setFeedbackState('hidden'), 3500);
  }, []);

  /* ── Quick feedback submit ── */
  const handleFeedback = useCallback(async () => {
    if (feedbackState !== 'visible') return;
    clearTimeout(feedbackTimerRef.current);
    setFeedbackState('sent');
    try {
      await quickFeedback({ feedback_type: 'wrong_detection', record_id: lastRecordIdRef.current });
    } catch (err) {
      console.warn('[SeeSense] Feedback failed:', err?.message);
    }
    feedbackTimerRef.current = setTimeout(() => setFeedbackState('hidden'), 1500);
  }, [feedbackState]);

  /* ── WebSocket result handler ──
     Fires for every frame result pushed by the server.
     TTS always uses Hebrew class-name mapping — backend alert_message is English.
     Uses only stable references → safe with [] deps. */
  const handleResult = useCallback((result) => {
    if (!isScanningRef.current) return;
    if (result.status === 'paused') return;

    const level   = result.alert_level ?? 'none';
    const objects = result.objects ?? [];

    // Track last record_id for quick feedback linking
    if (result.record_id) lastRecordIdRef.current = result.record_id;

    // Update the live bounding-box overlay every frame (all detected objects,
    // regardless of alert level). Cleared to [] when a frame has no detections.
    setDetections(objects);

    setAlertLevel(level);

    // Track direction and class of leading object for HUD display
    const dir = objects[0]?.motion?.direction ?? null;
    const cls = objects[0]?.class_name ?? null;
    setDetectionDir(level !== 'none' ? dir : null);
    setDetectedClass(level !== 'none' && cls ? (HEBREW_NAMES[cls] ?? cls) : null);

    // "Danger cleared" → one-shot Hebrew "Path Clear" announcement
    if (result.danger_cleared) {
      speakMessage('נתיב פנוי');
      setDetectionDir(null);
      setDetectedClass(null);
      return;
    }

    // alert_is_new (server-side, per track_id) gates TTS/haptic so the same
    // still-present object doesn't re-trigger them every single frame — the
    // HUD above (alertLevel/detectionDir/detectedClass) still updates live.
    if (!result.alert_is_new) return;

    if (result.danger) {
      haptic('danger');
      announceDetections(objects, true);   // "סכנה! מכונית מצד ימין"
      showFeedbackBriefly();
    } else if (level === 'low') {
      haptic('detection');
      announceDetections(objects, false);  // "כלב מצד שמאל"
      showFeedbackBriefly();
    }
  }, [showFeedbackBriefly]);

  /* ── Start / Stop scanning ── */
  const toggleScan = async () => {
    const next = !isScanning;

    if (next) {
      // On iOS 13+, gyroscope permission must be requested from a user gesture
      await requestPermission();

      const token  = localStorage.getItem('token');
      const stream = new VisionStream({
        onResult:    handleResult,
        onConnected: (msg) => {
          console.info('[SeeSense] WS connected, session:', msg.session_id, '| target_fps:', msg.target_fps, '| input_size:', msg.input_size);
          if (msg.target_fps) setCaptureFps(msg.target_fps);
          if (msg.input_size) setInputSize(msg.input_size);
        },
        onError:     (err) => console.warn('[SeeSense] WS error:', err?.message),
      });
      stream.connect(token);
      setActiveStream(stream);
      visionStreamRef.current = stream;

      // ── Start Health Watchdog ──
      startHealthWatch({
        onStatusChange: (status, rtt) => { setHealthStatus(status); setHealthRtt(rtt ?? null); },
        onDisconnect: () => {
          // Health RED → pause scanning visually (WebSocket may still be open but unusable)
          console.warn('[SeeSense] Health watchdog: connection lost');
        },
        onReconnect: () => {
          // Health recovered from RED → log recovery
          console.info('[SeeSense] Health watchdog: connection restored');
        },
      });
    } else {
      visionStreamRef.current?.disconnect();
      visionStreamRef.current = null;
      setAlertLevel('none');
      setDetectionDir(null);
      setDetectedClass(null);
      setDetections([]);
      setHealthStatus('idle');
      setHealthRtt(null);
      setQuickReportState('idle');
      clearTimeout(quickReportTimerRef.current);
      stopHealthWatch();
    }

    setIsScanning(next);
    haptic(next ? 'start' : 'stop');
    speakMessage(next ? 'סריקה הופעלה' : 'סריקה הופסקה');
  };

  /* ── Capture gate ──
     Predicate handed to CameraView, checked BEFORE the (async) JPEG encode so we
     never spend CPU encoding a frame we'd only drop. May we capture+send now? */
  const canCaptureFrame = useCallback(() => {
    if (!isScanningRef.current || !isAlignedRef.current) return false;
    const s = visionStreamRef.current;
    // Bounded-depth backpressure (MAX_INFLIGHT): allow a small number of frames
    // in flight so the pipe stays full and the server never starves — while the
    // queue stays bounded (no runaway backlog).
    return !!s && s.isOpen && s.canSend;
  }, []);

  /* ── Frame capture → WebSocket send ──
     Stable callback (empty deps) — reads live values via refs.
     Called by CameraView each capture tick with a ready-to-send JPEG Blob. */
  const handleFrameCapture = useCallback((blob) => {
    // Re-check the gate at send time: state (alignment / in-flight count) may
    // have changed during the async encode between canCaptureFrame() and here.
    if (!isScanningRef.current || !isAlignedRef.current) return;
    const s = visionStreamRef.current;
    if (!s?.isOpen || !s.canSend) return;
    s.sendFrame(blob);
  }, []); // stable reference — no deps, reads state through refs

  /* ── SOS: single tap ──
     One press → get GPS → POST /users/emergency_alert.
     No long-press: the button fires immediately and shows a sending state. */
  const handleSOSClick = (e) => {
    e.preventDefault();
    if (sosState !== 'idle') return; // ignore taps while sending / just-sent
    fireSOS();
  };

  const fireSOS = () => {
    setSosState('sending');
    haptic('danger');

    const send = async (lat, lon) => {
      try {
        await emergencyAlert({
          gps_lat: lat,
          gps_lon: lon,
        });
        haptic('danger');
        speakMessage('בקשת עזרה נשלחה בהצלחה');
      } catch (err) {
        console.warn('[SeeSense] Emergency alert failed:', err?.message);
        speakMessage('שליחת בקשת עזרה נכשלה');
      }
      setSosState('sent');
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
          <HealthDot status={healthStatus} rtt={healthRtt} />
          <button className="icon-btn" onClick={() => navigate('/settings')} aria-label="הגדרות">
            <Settings size={20} />
          </button>
          <button className="icon-btn" onClick={() => setShowLogoutConfirm(true)} aria-label="יציאה">
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
        <CameraView isActive={isScanning} onFrameCapture={handleFrameCapture} shouldCapture={canCaptureFrame} captureFps={captureFps} inputSize={inputSize} detections={detections} />

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

          {/* Quick feedback button — appears 3.5 s after a detection */}
          <AnimatePresence>
            {feedbackState !== 'hidden' && (
              <motion.button
                className={`feedback-btn${feedbackState === 'sent' ? ' sent' : ''}`}
                onClick={handleFeedback}
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.2 }}
                aria-label="דווח על זיהוי שגוי"
              >
                <Flag size={13} />
                {feedbackState === 'sent' ? 'תודה ✓' : 'זיהוי שגוי?'}
              </motion.button>
            )}
          </AnimatePresence>

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

          {/* Direction indicator — shows while a detection is active */}
          <AnimatePresence>
            {isScanning && detectionDir && detectionDir !== 'unknown' && (
              <motion.div
                className={`direction-indicator alert-${alertLevel}`}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: 0.18 }}
                aria-hidden="true"
              >
                <span className="dir-arrow">
                  {detectionDir === 'left' ? '←' : detectionDir === 'right' ? '→' : '↑'}
                </span>
                {detectedClass && (
                  <span className="dir-class">{detectedClass}</span>
                )}
                <span className="dir-label">
                  {detectionDir === 'left' ? 'שמאל' : detectionDir === 'right' ? 'ימין' : 'מרכז'}
                </span>
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

        {/* ── Quick Report Button (bottom-left, visible while scanning) ── */}
        <AnimatePresence>
          {isScanning && (
            <motion.button
              className={`quick-report-btn${quickReportState === 'sent' ? ' sent' : ''}`}
              onClick={handleQuickReport}
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.7 }}
              transition={{ duration: 0.2 }}
              aria-label="דיווח מהיר על זיהוי שגוי"
            >
              <Flag size={16} />
              <span className="quick-report-label">
                {quickReportState === 'sent' ? '✓' : 'דיווח'}
              </span>
            </motion.button>
          )}
        </AnimatePresence>

        {/* ── SOS Emergency Button ── */}
        <button
          type="button"
          className={`sos-btn sos-${sosState}`}
          onClick={handleSOSClick}
          disabled={sosState === 'sending'}
          onContextMenu={(e) => e.preventDefault()}
          aria-label="כפתור חירום — לחץ לשליחת התראה"
        >
          <span className="sos-label">
            {sosState === 'sent' ? '✓' : sosState === 'sending' ? '...' : 'SOS'}
          </span>
        </button>
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
          <button className="tab-btn" onClick={() => setShowLogoutConfirm(true)} aria-label="יציאה">
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

      {/* ── Logout confirmation ── */}
      <AnimatePresence>
        {showLogoutConfirm && (
          <motion.div
            className="confirm-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setShowLogoutConfirm(false)}
            role="dialog"
            aria-modal="true"
          >
            <motion.div
              className="confirm-card"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ duration: 0.2 }}
              onClick={(e) => e.stopPropagation()}
            >
              <p className="confirm-title">האם אתה בטוח שברצונך להתנתק?</p>
              <div className="confirm-actions">
                <button className="confirm-btn confirm-yes" onClick={logout}>כן</button>
                <button className="confirm-btn confirm-no" onClick={() => setShowLogoutConfirm(false)}>לא</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default Dashboard;