import { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LogOut, Settings, Home, Scan, VideoOff, Flag } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import CameraView      from '../components/CameraView';
import useOrientation  from '../hooks/useOrientation';
import { VisionStream, setActiveStream }          from '../services/visionService';
import { haptic, announceDetections, speakMessage, speakStatus, dangerPhrase, staticPhrase, HEBREW_NAMES } from '../services/feedbackService';
import { emergencyAlert, quickFeedback } from '../services/userService';
import { startHealthWatch, stopHealthWatch } from '../services/healthService';
import { recordClientStage } from '../services/clientMetrics';


const ALERT_LABELS = {
  high: '⚠ סכנה קרובה',
  low:  '! שים לב',
};

const DANGER_REPEAT_MS = 2000;


const Corner = ({ position }) => (
  <div className={`hud-corner hud-corner-${position}`} />
);

const SpiritLevel = ({ beta, gamma, isAligned }) => {
  const CONTAINER_R = 23;
  const clamp       = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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

const fmtFps = (v) => (v == null ? '–' : Math.round(v));

const HealthDot = ({ status, rtt, user, fps }) => {
  if (status === 'idle') return null;
  const colors = { green: '#22c55e', yellow: '#eab308', orange: '#f97316', red: '#ef4444' };
  const labels = { green: 'חיבור יציב', yellow: 'חיבור לא יציב', orange: 'חיבור חלש', red: 'אין חיבור' };
  const isAdmin = user?.admin_level >= 1;
  const rttText = rtt != null ? `${rtt} ms` : ' ';
  const showFps = isAdmin && (fps?.server != null || fps?.client != null);
  return (
    <div className="health-dot-wrap">
      <div className="health-dot-row" title={labels[status] || rttText}>
        <div
          className={`health-dot ${status}`}
          style={{ backgroundColor: colors[status] }}
        />
        {isAdmin && (
          <span className="health-ms" dir="ltr" style={{ color: colors[status] }}>
            {rttText}
          </span>
        )}
        {labels[status] && (
          <span className={`health-label ${status}`} style={{ color: colors[status] }}>
            {labels[status]}
          </span>
        )}
      </div>

      {showFps && (
        <div className="health-fps" title="פריימים לשנייה — שרת מול לקוח">
          <span className="health-fps-unit">FPS</span>
          <span>שרת <bdi>{fmtFps(fps.server)}</bdi></span>
          <span>לקוח <bdi>{fmtFps(fps.client)}</bdi></span>
        </div>
      )}
    </div>
  );
};


const Dashboard = () => {
  const { logout, user }            = useAuth();
  const navigate                    = useNavigate();
  const [isScanning, setIsScanning]       = useState(false);
  const [alertLevel, setAlertLevel]       = useState('none');
  const [healthStatus, setHealthStatus]   = useState('idle');
  const [healthRtt, setHealthRtt]         = useState(null);
  const [detectionDir, setDetectionDir]   = useState(null);
  const [detectedClass, setDetectedClass] = useState(null);
  const [detections, setDetections]       = useState([]);
  const [quickReportState, setQuickReportState] = useState('idle');
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [inputSize, setInputSize]         = useState(640);
  const [liveFps, setLiveFps]             = useState({ server: null, client: null });

  const { beta, gamma, isAligned, requestPermission } = useOrientation();

  const isScanningRef  = useRef(isScanning);
  const isAlignedRef   = useRef(isAligned);
  const visionStreamRef    = useRef(null);
  const prevAlignedRef     = useRef(isAligned);
  const quickReportTimerRef = useRef(null);
  const lastRecordIdRef    = useRef(null);

  const [feedbackState, setFeedbackState] = useState('hidden');
  const feedbackTimerRef = useRef(null);
  const lastDangerRepeatRef = useRef(0);

  const [sosState, setSosState]       = useState('idle');

  useEffect(() => () => {
    visionStreamRef.current?.disconnect();
    visionStreamRef.current = null;
    setActiveStream(null);
    stopHealthWatch();
    clearTimeout(feedbackTimerRef.current);
    clearTimeout(quickReportTimerRef.current);
  }, []);

  useEffect(() => { isScanningRef.current = isScanning;        }, [isScanning]);
  useEffect(() => { isAlignedRef.current  = isAligned;         }, [isAligned]);

  const isAdminView = (user?.admin_level ?? 0) >= 1;
  useEffect(() => {
    if (!isScanning || !isAdminView) return undefined;
    const id = setInterval(() => {
      const s = visionStreamRef.current;
      const server = s?.serverFps != null ? Math.round(s.serverFps) : null;
      const client = s?.clientFps != null ? Math.round(s.clientFps) : null;
      setLiveFps((prev) =>
        prev.server === server && prev.client === client ? prev : { server, client });
    }, 1000);
    return () => clearInterval(id);
  }, [isScanning, isAdminView]);

  useEffect(() => {
    if (isScanning && isAligned && !prevAlignedRef.current) {
      haptic('aligned');
    }
    prevAlignedRef.current = isAligned;
  }, [isAligned, isScanning]);

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

  const showFeedbackBriefly = useCallback(() => {
    clearTimeout(feedbackTimerRef.current);
    setFeedbackState('visible');
    feedbackTimerRef.current = setTimeout(() => setFeedbackState('hidden'), 3500);
  }, []);

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

  const handleResult = useCallback((result) => {
    if (!isScanningRef.current) return;
    if (result.status === 'paused') return;

    // try/finally so the end-to-end clock closes on EVERY path out of this handler,
    // including the early returns below. E2E therefore always ends at the same
    // point — result rendered and any speech/haptics issued — whether or not this
    // particular frame raised an alert. Note "issued", not "heard": speech is queued
    // by the Web Speech API, exactly as the 'feedback' client stage already measures.
    try {
      const tRender = performance.now();

      const level   = result.alert_level ?? 'none';
      const objects = result.objects ?? [];

      if (result.record_id) lastRecordIdRef.current = result.record_id;

      setDetections(objects);

      setAlertLevel(level);

      const dir = objects[0]?.position ?? null;
      const cls = objects[0]?.class_name ?? null;
      setDetectionDir(level !== 'none' ? dir : null);
      setDetectedClass(level !== 'none' && cls ? (HEBREW_NAMES[cls] ?? cls) : null);

      recordClientStage('render', performance.now() - tRender);

      if (result.danger_cleared) {
        const tFb = performance.now();
        speakMessage('נתיב פנוי', { priority: true });
        recordClientStage('feedback', performance.now() - tFb);
        setDetectionDir(null);
        setDetectedClass(null);
        return;
      }

      if (result.static_notice) {
        const tFb = performance.now();
        speakStatus(staticPhrase(result.static_notice.class_name, result.static_notice.position));
        recordClientStage('feedback', performance.now() - tFb);
      }

      const stillClosingIn =
        result.danger && (objects[0]?.motion?.approaching ?? false);
      const now = performance.now();
      if (stillClosingIn && now - lastDangerRepeatRef.current >= DANGER_REPEAT_MS) {
        lastDangerRepeatRef.current = now;
        const tRep = performance.now();
        haptic('danger');
        speakMessage(dangerPhrase(objects), { priority: true });
        showFeedbackBriefly();
        recordClientStage('feedback', performance.now() - tRep);
        return;
      }
      if (!result.danger) lastDangerRepeatRef.current = 0;

      if (!result.alert_is_new) return;

      const tFb = performance.now();
      if (result.danger) {
        haptic('danger');
        announceDetections(objects, true);
        showFeedbackBriefly();
      } else if (level === 'low') {
        haptic('detection');
        announceDetections(objects, false);
        showFeedbackBriefly();
      }
      recordClientStage('feedback', performance.now() - tFb);
    } finally {
      visionStreamRef.current?.completeE2E();
    }
  }, [showFeedbackBriefly]);

  const toggleScan = async () => {
    const next = !isScanning;

    if (next) {
      await requestPermission();

      const token  = localStorage.getItem('token');
      const stream = new VisionStream({
        onResult:    handleResult,
        onConnected: (msg) => {
          console.info(
            '[SeeSense] WS connected, session:', msg.session_id,
            '| input_size:', msg.input_size,
            '| compression:', msg.compression_percent,
            '| depth:', msg.max_inflight,
          );
          if (msg.input_size) setInputSize(msg.input_size);
          speakStatus('התחבר בהצלחה');
        },
        onError:     (err) => console.warn('[SeeSense] WS error:', err?.message),
      });
      stream.connect(token);
      setActiveStream(stream);
      visionStreamRef.current = stream;

      startHealthWatch({
        onStatusChange: (status, rtt) => { setHealthStatus(status); setHealthRtt(rtt ?? null); },
        onDisconnect: () => {
          console.warn('[SeeSense] Health watchdog: connection lost');
        },
        onReconnect: () => {
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
      setLiveFps({ server: null, client: null });
      setQuickReportState('idle');
      clearTimeout(quickReportTimerRef.current);
      stopHealthWatch();
    }

    setIsScanning(next);
    haptic(next ? 'start' : 'stop');
    if (next) {
      speakStatus('סריקה הופעלה, מתחבר');
    } else {
      speakMessage('סריקה הופסקה', { priority: true });
    }
  };

  const canCaptureFrame = useCallback(() => {
    if (!isScanningRef.current || !isAlignedRef.current) return false;
    const s = visionStreamRef.current;
    return !!s && s.isOpen && s.canSend;
  }, []);

  const handleFrameCapture = useCallback((blob, captureT0) => {
    if (!isScanningRef.current || !isAlignedRef.current) return;
    const s = visionStreamRef.current;
    if (!s?.isOpen || !s.canSend) return;
    s.sendFrame(blob, captureT0);
  }, []);

  const handleSOSClick = (e) => {
    e.preventDefault();
    if (sosState !== 'idle') return;
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

    if (!navigator.geolocation) { send(null, null); return; }

    navigator.geolocation.getCurrentPosition(
      (pos) => send(pos.coords.latitude, pos.coords.longitude),
      () => navigator.geolocation.getCurrentPosition(
        (pos) => send(pos.coords.latitude, pos.coords.longitude),
        ()    => send(null, null),
        { timeout: 8000, enableHighAccuracy: false, maximumAge: 300000 },
      ),
      { timeout: 12000, enableHighAccuracy: true, maximumAge: 0 },
    );
  };

  const bracketClass = [
    'hud-brackets',
    isScanning ? 'active'  : '',
    isScanning && isAligned ? 'aligned' : '',
  ].filter(Boolean).join(' ');

  const badgeLabel = !isScanning ? 'IDLE'
    : isAligned ? 'TRACKING'
    : 'LIVE';


  return (
    <motion.div
      className="dashboard-page"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
    >
      <header className="dashboard-header">
        <span className="header-brand">SEE<span>SENSE</span></span>
        <div className="header-actions">
          <HealthDot status={healthStatus} rtt={healthRtt} user={user} fps={liveFps} />
          <button className="icon-btn" onClick={() => navigate('/settings')} aria-label="הגדרות">
            <Settings size={20} />
          </button>
          <button className="icon-btn" onClick={() => setShowLogoutConfirm(true)} aria-label="יציאה">
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <main className={[
        'camera-viewport',
        isScanning ? 'scanning' : '',
        alertLevel === 'high' ? 'danger-border' : '',
      ].filter(Boolean).join(' ')}>
        <CameraView isActive={isScanning} onFrameCapture={handleFrameCapture} shouldCapture={canCaptureFrame} inputSize={inputSize} detections={detections} />

        <div className="hud-overlay">

          <div className={bracketClass}>
            <Corner position="tl" />
            <Corner position="tr" />
            <Corner position="bl" />
            <Corner position="br" />
          </div>

          <div className="hud-top-row">
            <div className={`live-badge${isScanning ? ' active' : ''}`}>
              <div className={`status-dot${isScanning ? ' active' : ''}`} />
              {badgeLabel}
            </div>
          </div>

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

          {isScanning && isAligned && <div className="scan-line" />}

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

          <SpiritLevel beta={beta} gamma={gamma} isAligned={isAligned} />
        </div>

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