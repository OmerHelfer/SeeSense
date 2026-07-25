import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Activity, Server, Wifi, Clock, Zap, CheckCircle, XCircle, RotateCcw, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import apiClient from '../api/client';
import { getOverview } from '../services/adminService';

// Time-range presets for the performance history selector.
const RANGE_PRESETS = [
  { key: 'live',  label: 'חי' },
  { key: 'start', label: 'מההתחלה' },
  { key: '30m',   label: '30 דק׳' },
  { key: '1h',    label: 'שעה' },
  { key: '1d',    label: 'יום' },
  { key: '1w',    label: 'שבוע' },
  { key: '1mo',   label: 'חודש' },
  { key: '3mo',   label: '3 ח׳' },
  { key: '6mo',   label: '6 ח׳' },
  { key: '1y',    label: 'שנה' },
  { key: 'custom', label: 'מותאם' },
];

// ── Animation variants (match Settings page) ──
const pageVariants = {
  hidden:  { opacity: 0, x: 40 },
  visible: { opacity: 1, x: 0,  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, x: 40, transition: { duration: 0.22, ease: 'easeIn' } },
};

// ── Helpers ──
const fmtUptime = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const fmtMs = (ms) => ms > 0 ? `${Math.round(ms)}ms` : '—';

// For the per-stage breakdown, a value under 1ms is REAL data (a stage that took
// e.g. 0.3ms), not "missing" — so show it with one decimal (e.g. "0.4ms") rather
// than the "—" that fmtMs uses for zero. Only a truly absent value shows "—".
// This keeps the min/avg/max columns symmetric and precise for sub-ms stages.
const fmtStageMs = (ms) => {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
};

// ── Stat Card ──
const StatCard = ({ icon: Icon, label, value, sub, color }) => (
  <div className="admin-stat-card">
    <div className="admin-stat-icon" style={{ color }}>
      <Icon size={18} />
    </div>
    <div className="admin-stat-body">
      <span className="admin-stat-value">{value}</span>
      <span className="admin-stat-label">{label}</span>
      {sub && <span className="admin-stat-sub">{sub}</span>}
    </div>
  </div>
);

// ── Stage labels (Hebrew) ──
const STAGE_LABELS = {
  decode_quality: 'פענוח + בדיקת איכות',
  inference:      'YOLO (מודל)',
  tracking:       'מעקב תנועה (Tracking)',
  danger_logic:   'לוגיקת סכנה',
  db_write:       'כתיבה ל-DB',
};
const STAGE_ORDER = ['decode_quality', 'inference', 'tracking', 'danger_logic', 'db_write'];

// ── Latency Row ──
const LatencyRow = ({ label, avg, min, max, color, fmt = fmtMs }) => (
  <div className="admin-latency-row">
    <span className="admin-latency-label" style={{ borderRightColor: color }}>{label}</span>
    <div className="admin-latency-values">
      <div className="admin-latency-cell">
        <span className="admin-latency-num">{fmt(avg)}</span>
        <span className="admin-latency-tag">ממוצע</span>
      </div>
      <div className="admin-latency-cell">
        <span className="admin-latency-num">{fmt(min)}</span>
        <span className="admin-latency-tag">מינימום</span>
      </div>
      <div className="admin-latency-cell">
        <span className="admin-latency-num">{fmt(max)}</span>
        <span className="admin-latency-tag">מקסימום</span>
      </div>
    </div>
  </div>
);

// ── Mini RTT Chart (canvas-based) ──
const RttChart = ({ history }) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || history.length < 2) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width  = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const values = history.map(p => p.rtt);
    const maxVal = Math.max(...values, 100);
    const pad    = { top: 16, right: 8, bottom: 24, left: 36 };
    const plotW  = w - pad.left - pad.right;
    const plotH  = h - pad.top  - pad.bottom;

    // Background
    ctx.clearRect(0, 0, w, h);

    // Grid lines + labels
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.fillStyle   = 'rgba(255,255,255,0.3)';
    ctx.font        = '10px system-ui';
    ctx.textAlign   = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + plotH * (1 - i / 4);
      const v = Math.round(maxVal * i / 4);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      ctx.fillText(`${v}`, pad.left - 4, y + 3);
    }

    // Threshold lines
    const drawThreshold = (ms, color, label) => {
      if (ms > maxVal) return;
      const y = pad.top + plotH * (1 - ms / maxVal);
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.fillText(label, w - pad.right - 40, y - 4);
    };
    drawThreshold(150, 'rgba(234,179,8,0.5)',  '150ms');  // yellow — unstable
    drawThreshold(200, 'rgba(249,115,22,0.5)', '200ms');  // orange — severe
    drawThreshold(250, 'rgba(239,68,68,0.5)',  '250ms');  // red — disconnect

    // Data line
    ctx.beginPath();
    const stepX = plotW / (values.length - 1);
    values.forEach((v, i) => {
      const x = pad.left + i * stepX;
      const y = pad.top + plotH * (1 - v / maxVal);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.stroke();

    // Gradient fill
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    grad.addColorStop(0, 'rgba(34,211,238,0.25)');
    grad.addColorStop(1, 'rgba(34,211,238,0)');
    ctx.lineTo(pad.left + (values.length - 1) * stepX, pad.top + plotH);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Last point dot
    if (values.length > 0) {
      const lastX = pad.left + (values.length - 1) * stepX;
      const lastY = pad.top + plotH * (1 - values[values.length - 1] / maxVal);
      ctx.beginPath();
      ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#22d3ee';
      ctx.fill();
    }

    // X-axis label — computed from actual timestamps, not a hardcoded guess.
    // rtt_history is reported every ~5s from the client, up to 60 points,
    // so the real span can be several minutes, not a fixed "30 seconds".
    const spanMs = history[history.length - 1].ts - history[0].ts;
    const spanLabel = spanMs >= 60000
      ? `${Math.round(spanMs / 60000)} דקות אחרונות`
      : `${Math.round(spanMs / 1000)} שניות אחרונות`;
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.textAlign = 'center';
    ctx.fillText(spanLabel, w / 2, h - 4);
  }, [history]);

  return (
    <div className="admin-chart-wrap">
      <canvas ref={canvasRef} className="admin-chart-canvas" />
    </div>
  );
};

// ══════════════════════════════════════════════════════════
// AdminStatus Page
// ══════════════════════════════════════════════════════════

const AdminStatus = () => {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const intervalRef = useRef(null);

  // Selected time range: { range, start, end }. Presets set start/end null.
  const [sel, setSel]         = useState({ range: 'live', start: null, end: null });
  const selRef                = useRef(sel);
  useEffect(() => { selRef.current = sel; }, [sel]);

  // Custom range picker (datetime-local strings)
  const [customStart, setCustomStart] = useState('');
  const [customEnd,   setCustomEnd]   = useState('');

  // Reset confirmation
  const [showReset, setShowReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [actorLevel, setActorLevel] = useState(0);   // gate reset button to super admin

  useEffect(() => { getOverview().then((o) => setActorLevel(o.actor_level ?? 0)).catch(() => {}); }, []);

  const fetchStatus = async () => {
    const s = selRef.current;
    // Custom range needs both ends chosen before it can be fetched
    if (s.range === 'custom' && (!s.start || !s.end)) { setLoading(false); return; }
    try {
      const params = { range: s.range };
      if (s.range === 'custom') { params.start = s.start; params.end = s.end; }
      const res = await apiClient.get('/get_system_status', { params });
      setData(res.data);
      setError(null);
    } catch (err) {
      if (err.response?.status === 403) {
        setError('אין הרשאת אדמין');
      } else {
        setError('שגיאה בטעינת נתונים');
      }
    } finally {
      setLoading(false);
    }
  };

  // Re-fetch (and restart the auto-refresh) whenever the selected range changes.
  useEffect(() => {
    fetchStatus();
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(fetchStatus, 3000); // refresh every 3s
    return () => clearInterval(intervalRef.current);
  }, [sel]);

  const applyCustom = () => {
    if (!customStart || !customEnd) return;
    // datetime-local → epoch seconds
    setSel({
      range: 'custom',
      start: Math.floor(new Date(customStart).getTime() / 1000),
      end:   Math.floor(new Date(customEnd).getTime() / 1000),
    });
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      await apiClient.post('/reset_system_status');
      setShowReset(false);
      fetchStatus();
    } catch {
      setError('איפוס נכשל. נסה שוב.');
    } finally {
      setResetting(false);
    }
  };

  const isRange = data?.mode === 'range';

  return (
    <motion.div
      className="inner-page admin-status-page"
      variants={pageVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      {/* Header */}
      <header className="inner-page-header">
        <button className="back-btn" onClick={() => navigate('/settings')} aria-label="חזור">
          <ArrowRight size={22} />
        </button>
        <span className="inner-page-title">ביצועי מערכת</span>
        <div style={{ width: 46 }} />
      </header>

      <div className="inner-page-body">

      {/* ── Time-range selector ── */}
      <div className="admin-range-bar">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.key}
            className={`admin-range-chip${sel.range === p.key ? ' active' : ''}`}
            onClick={() => setSel({ range: p.key, start: null, end: null })}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Custom date range picker */}
      {sel.range === 'custom' && (
        <div className="admin-custom-range">
          <label>מ־<input type="datetime-local" value={customStart} onChange={(e) => setCustomStart(e.target.value)} /></label>
          <label>עד<input type="datetime-local" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} /></label>
          <button className="admin-range-chip active" onClick={applyCustom} disabled={!customStart || !customEnd}>הצג</button>
        </div>
      )}

      {loading && <div className="admin-loading">טוען נתוני ביצועים...</div>}
      {error   && <div className="admin-error">{error}</div>}

      {data && (
        <div className="admin-content">
          {/* ── Top stat cards ── */}
          <div className="admin-stats-grid">
            <StatCard
              icon={Clock}
              label={isRange ? 'טווח נמדד' : 'זמן פעילות'}
              value={fmtUptime(data.uptime_seconds)}
              color="#22d3ee"
            />
            <StatCard
              icon={Zap}
              label={isRange ? 'FPS ממוצע' : 'FPS שרת (יכולת)'}
              value={isRange ? (data.fps?.overall ?? 0) : (data.fps?.server_capacity ?? 0)}
              sub={isRange ? 'לאורך הטווח' : `בפועל: ${data.fps?.server_actual ?? 0} | לקוח: ${data.fps?.client_actual ?? 0}`}
              color="#a78bfa"
            />
            <StatCard
              icon={CheckCircle}
              label="פריימים"
              value={data.total_frames?.toLocaleString()}
              sub={`${data.success_count} ✓  ${data.failure_count} ✗`}
              color="#22c55e"
            />
          </div>

          {/* Range info note (aggregated ranges only) */}
          {isRange && (
            <div className="admin-range-note">
              <AlertTriangle size={13} />
              <span>נתונים מצטברים מרגע הפעלת השמירה — טווחים ארוכים יתמלאו עם הזמן. ({data.range?.buckets ?? 0} דקות נתונים)</span>
            </div>
          )}

          {/* ── FPS comparison (live only — server/client real-time rates) ── */}
          {!isRange && (
          <div className="admin-section">
            <h2 className="admin-section-title">
              <Zap size={16} />
              השוואת קצב פריימים (FPS)
            </h2>

            <div className="admin-latency-row">
              <span className="admin-latency-label" style={{ borderRightColor: '#22c55e' }}>
                לקוח (שולח)
              </span>
              <div className="admin-latency-values">
                <div className="admin-latency-cell">
                  <span className="admin-latency-num">{data.fps?.client_actual ?? 0}</span>
                  <span className="admin-latency-tag">בפועל</span>
                </div>
              </div>
            </div>

            <div className="admin-latency-row">
              <span className="admin-latency-label" style={{ borderRightColor: '#a78bfa' }}>
                שרת (מעבד)
              </span>
              <div className="admin-latency-values">
                <div className="admin-latency-cell">
                  <span className="admin-latency-num">{data.fps?.server_actual ?? 0}</span>
                  <span className="admin-latency-tag">בפועל</span>
                </div>
                <div className="admin-latency-cell">
                  <span className="admin-latency-num">{data.fps?.server_capacity ?? 0}</span>
                  <span className="admin-latency-tag">יכולת</span>
                </div>
                <div className="admin-latency-cell">
                  <span className="admin-latency-num">{data.fps?.overall ?? 0}</span>
                  <span className="admin-latency-tag">מאז התחלה</span>
                </div>
              </div>
            </div>
          </div>
          )}

          {/* ── Latency comparison ── */}
          <div className="admin-section">
            <h2 className="admin-section-title">
              <Activity size={16} />
              השוואת זמני תגובה
            </h2>
            <LatencyRow
              label="שרת בלבד"
              avg={data.server_latency?.avg_ms}
              min={data.server_latency?.min_ms}
              max={data.server_latency?.max_ms}
              color="#a78bfa"
            />
            <LatencyRow
              label="End-to-End"
              avg={data.client_rtt?.avg_ms}
              min={data.client_rtt?.min_ms}
              max={data.client_rtt?.max_ms}
              color="#22d3ee"
            />
            {data.client_rtt?.avg_ms > 0 && data.server_latency?.avg_ms > 0 && (
              <div className="admin-network-calc">
                <Wifi size={14} />
                <span>
                  רשת (הערכה): ~{Math.round(data.client_rtt.avg_ms - data.server_latency.avg_ms)}ms
                </span>
              </div>
            )}
          </div>

          {/* ── Stage-by-stage server latency breakdown ── */}
          {data.stage_latency && Object.keys(data.stage_latency).length > 0 && (
            <div className="admin-section">
              <h2 className="admin-section-title">
                <Server size={16} />
                פירוט זמן עיבוד בשרת (לפי שלב)
              </h2>
              {STAGE_ORDER
                .filter((key) => data.stage_latency[key])
                .map((key) => (
                  <LatencyRow
                    key={key}
                    label={STAGE_LABELS[key] ?? key}
                    avg={data.stage_latency[key].avg_ms}
                    min={data.stage_latency[key].min_ms}
                    max={data.stage_latency[key].max_ms}
                    color="#22d3ee"
                    fmt={fmtStageMs}
                  />
                ))}
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 4 }}>
                * נמדד רק על פריימים שעברו את כל השלבים בהצלחה (לא כולל פריימים שנדחו בבדיקת איכות)
              </p>
            </div>
          )}

          {/* ── RTT Live Chart ── */}
          {data.rtt_history && data.rtt_history.length >= 2 && (
            <div className="admin-section">
              <h2 className="admin-section-title">
                <Wifi size={16} />
                גרף RTT בזמן אמת
              </h2>
              <RttChart history={data.rtt_history} />
            </div>
          )}

          {/* ── Reset all performance data (super admin / level 2 only) ── */}
          {actorLevel >= 2 && (
            <button className="admin-reset-btn" onClick={() => setShowReset(true)}>
              <RotateCcw size={16} />
              אפס את כל נתוני הביצועים
            </button>
          )}
        </div>
      )}
      </div>

      {/* ── Reset confirmation modal (centered) ── */}
      <AnimatePresence>
        {showReset && (
          <motion.div
            className="admin-modal-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => !resetting && setShowReset(false)}
          >
            <motion.div
              className="admin-modal-card"
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.92 }}
              transition={{ duration: 0.2 }}
            >
              <div className="admin-modal-icon"><AlertTriangle size={26} /></div>
              <h3 className="admin-modal-title">לאפס את כל נתוני הביצועים?</h3>
              <p className="admin-modal-body">
                פעולה זו תמחק <strong>לצמיתות</strong> את כל מדדי הביצועים — גם את הנתונים החיים
                וגם את כל ההיסטוריה השמורה (לכל הטווחים). הספירה תתחיל מאפס. <strong>אי אפשר לבטל.</strong>
              </p>
              <button className="admin-reset-btn confirm" onClick={handleReset} disabled={resetting}>
                <RotateCcw size={16} />
                {resetting ? 'מאפס...' : 'כן, אפס הכל'}
              </button>
              <button className="admin-modal-cancel" onClick={() => setShowReset(false)} disabled={resetting}>
                ביטול
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default AdminStatus;