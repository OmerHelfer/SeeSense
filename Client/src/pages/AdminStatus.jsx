import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Activity, Server, Wifi, Clock, Zap, CheckCircle, XCircle } from 'lucide-react';
import { motion } from 'framer-motion';
import apiClient from '../api/client';

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

// ── Latency Row ──
const LatencyRow = ({ label, avg, min, max, color }) => (
  <div className="admin-latency-row">
    <span className="admin-latency-label" style={{ borderRightColor: color }}>{label}</span>
    <div className="admin-latency-values">
      <div className="admin-latency-cell">
        <span className="admin-latency-num">{fmtMs(avg)}</span>
        <span className="admin-latency-tag">ממוצע</span>
      </div>
      <div className="admin-latency-cell">
        <span className="admin-latency-num">{fmtMs(min)}</span>
        <span className="admin-latency-tag">מינימום</span>
      </div>
      <div className="admin-latency-cell">
        <span className="admin-latency-num">{fmtMs(max)}</span>
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
    drawThreshold(150, 'rgba(234,179,8,0.5)', '150ms');
    drawThreshold(300, 'rgba(239,68,68,0.5)', '300ms');

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

    // X-axis label
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.textAlign = 'center';
    ctx.fillText('30 שניות אחרונות', w / 2, h - 4);
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

  const fetchStatus = async () => {
    try {
      const res = await apiClient.get('/get_system_status');
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

  useEffect(() => {
    fetchStatus();
    intervalRef.current = setInterval(fetchStatus, 3000); // refresh every 3s
    return () => clearInterval(intervalRef.current);
  }, []);

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

      {loading && <div className="admin-loading">טוען נתוני ביצועים...</div>}
      {error   && <div className="admin-error">{error}</div>}

      {data && (
        <div className="admin-content">
          {/* ── Top stat cards ── */}
          <div className="admin-stats-grid">
            <StatCard
              icon={Clock}
              label="זמן פעילות"
              value={fmtUptime(data.uptime_seconds)}
              color="#22d3ee"
            />
            <StatCard
              icon={Zap}
              label="FPS"
              value={data.fps?.recent ?? 0}
              sub={`ממוצע כללי: ${data.fps?.overall ?? 0}`}
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
        </div>
      )}
      </div>
    </motion.div>
  );
};

export default AdminStatus;