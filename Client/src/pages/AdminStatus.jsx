import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Activity, Server, Wifi, Clock, Zap, Gauge, CheckCircle, XCircle, RotateCcw, AlertTriangle, Smartphone, Search } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import apiClient from '../api/client';
import { getOverview } from '../services/adminService';

// ── Animation variants (match Settings page) ──
const pageVariants = {
  hidden:  { opacity: 0, x: 40 },
  visible: { opacity: 1, x: 0,  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, x: 40, transition: { duration: 0.22, ease: 'easeIn' } },
};

// ── Helpers ──
// Elapsed span as a live clock. Always shows seconds, and rolls into days once
// past 24h ("יום אחד, 3:05:12"). Hebrew needs three forms for the day count:
// singular, dual (יומיים), and plural.
const fmtUptime = (seconds) => {
  const total = Math.max(0, Math.floor(seconds || 0));
  const days = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');

  const clock = days > 0 || h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  if (days === 0) return clock;

  const dayLabel = days === 1 ? 'יום אחד' : days === 2 ? 'יומיים' : `${days} ימים`;
  return `${dayLabel}, ${clock}`;
};

const fmtMs = (ms) => ms > 0 ? `${Math.round(ms)}ms` : '—';

// Formats a time SPAN (not a point in time) into "X <unit> אחרונות" — picks
// whichever unit actually fits (seconds → minutes → hours → days → weeks),
// instead of always dividing by 60,000 and calling it "minutes" even when the
// span is really hours or days (e.g. a stale point sitting in a count-capped
// history buffer from a much earlier session).
const formatSpanLabel = (spanMs) => {
  const sec = Math.round(spanMs / 1000);
  if (sec < 60) return `${sec} שניות אחרונות`;

  const min = Math.round(sec / 60);
  if (min < 60) return `${min} דקות אחרונות`;

  const hours = Math.floor(min / 60);
  const remMin = min % 60;
  if (hours < 24) {
    return remMin > 0 ? `${hours} שעות ו-${remMin} דקות אחרונות` : `${hours} שעות אחרונות`;
  }

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (days < 7) {
    return remHours > 0 ? `${days} ימים ו-${remHours} שעות אחרונות` : `${days} ימים אחרונות`;
  }

  const weeks = Math.floor(days / 7);
  const remDays = days % 7;
  return remDays > 0 ? `${weeks} שבועות ו-${remDays} ימים אחרונות` : `${weeks} שבועות אחרונות`;
};

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
  response:       'בניית תשובה ושליחה',
  db_write:       'כתיבה ל-DB',
};
// db_write last on purpose: it is the only row that is NOT part of the frame's
// own total (the writes are batched onto a background thread once a second).
const STAGE_ORDER = ['decode_quality', 'inference', 'tracking', 'danger_logic', 'response', 'db_write'];

// ── Client-side stage labels (Hebrew) — the on-device half of the pipeline ──
const CLIENT_STAGE_LABELS = {
  capture:  'צילום פריים',
  encode:   'דחיסת JPEG',
  render:   'ציור תוצאה + HUD',
  feedback: 'קול + רטט (התראה)',
};
const CLIENT_STAGE_ORDER = ['capture', 'encode', 'render', 'feedback'];

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
    drawThreshold(100, 'rgba(234,179,8,0.5)',  '100ms');  // yellow — unstable
    drawThreshold(150, 'rgba(249,115,22,0.5)', '150ms');  // orange — severe
    drawThreshold(200, 'rgba(239,68,68,0.5)',  '200ms');  // red — disconnect

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
    // rtt_history is capped by COUNT (60 points), not by time, so if the points
    // aren't evenly spaced (e.g. a stale point from a session hours/days ago is
    // still sitting in the buffer) the real span can be hours or days, not just
    // minutes — format whichever unit actually fits, not always "X דקות".
    const spanLabel = formatSpanLabel(history[history.length - 1].ts - history[0].ts);
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
  // ?email=... lets AdminUsers deep-link straight into one user's report.
  const [searchParams, setSearchParams] = useSearchParams();
  const emailParam = searchParams.get('email');
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const intervalRef = useRef(null);

  // Scope of the report: null = every user, or an email to drill into one.
  // There is no time selector any more — the page always reports the full recorded
  // history, which is what the persisted per-minute buckets already hold.
  const [scope, setScope]     = useState(emailParam);   // applied email (or null)
  const scopeRef              = useRef(scope);
  useEffect(() => { scopeRef.current = scope; }, [scope]);

  const [emailInput, setEmailInput] = useState(emailParam ?? '');  // what's typed in the box

  // Follow the URL when it changes (deep link, back/forward) without fighting
  // the search box: only react when the param genuinely differs from the scope.
  useEffect(() => {
    const next = emailParam || null;
    if (next !== scopeRef.current) {
      setScope(next);
      setEmailInput(next ?? '');
    }
  }, [emailParam]);
  const [notFound, setNotFound]     = useState(false);

  // Reset confirmation
  const [showReset, setShowReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [actorLevel, setActorLevel] = useState(0);   // gate reset button to super admin

  useEffect(() => { getOverview().then((o) => setActorLevel(o.actor_level ?? 0)).catch(() => {}); }, []);

  const fetchStatus = async () => {
    const email = scopeRef.current;
    try {
      const res = await apiClient.get('/get_system_status', {
        params: email ? { email } : {},
      });
      setData(res.data);
      setError(null);
      setNotFound(false);
    } catch (err) {
      const status = err.response?.status;
      if (status === 403)      setError('אין הרשאת אדמין');
      // Drop the previous scope's report too: leaving it on screen under "no such
      // user" reads as if those numbers belong to the email that was just searched.
      else if (status === 404) { setNotFound(true); setError(null); setData(null); }
      else                     setError('שגיאה בטעינת נתונים');
    } finally {
      setLoading(false);
    }
  };

  // Re-fetch (and restart auto-refresh) whenever the scope changes.
  useEffect(() => {
    fetchStatus();
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(fetchStatus, 3000); // refresh every 3s
    return () => clearInterval(intervalRef.current);
  }, [scope]);

  const applySearch = (e) => {
    e?.preventDefault();
    const v = emailInput.trim();
    setScope(v || null);          // empty box => back to all users
    setSearchParams(v ? { email: v } : {}, { replace: true });
  };

  const clearSearch = () => {
    setEmailInput('');
    setScope(null);
    setSearchParams({}, { replace: true });
  };

  // Local 1s tick for the measured-span clock. The server's uptime_seconds comes
  // from minute-aligned buckets, so on its own it sits still and then jumps a
  // whole minute; deriving the span from the first bucket's timestamp against the
  // current clock lets it run smoothly between the 3s data refreshes.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const measuredSpan = useMemo(() => {
    const first = data?.range?.first_ts;
    // No buckets yet (or an unexpected future timestamp) → fall back to the
    // server's own figure rather than showing a nonsense duration.
    if (!first || nowSec < first) return data?.uptime_seconds ?? 0;
    return nowSec - first;
  }, [data, nowSec]);

  // Rates measured over time actually spent streaming. The server reports both
  // these and the calendar-based figures; fall back to the calendar ones so an
  // older server (or history recorded before per-bucket timestamps existed) still
  // renders a number rather than a blank card.
  const activeSeconds = data?.range?.active_seconds ?? 0;
  const userFps = data?.fps?.active ?? data?.fps?.overall ?? 0;
  const throughputPs = data?.throughput?.active_per_second
    ?? data?.throughput?.per_second ?? 0;

  const handleReset = async () => {
    setResetting(true);
    try {
      // Scope the wipe to whoever is on screen. Sending no email wipes EVERY
      // user, so this must follow the view rather than default to "everything".
      await apiClient.post('/reset_system_status', null, {
        params: scope ? { email: scope } : {},
      });
      setShowReset(false);
      fetchStatus();
    } catch {
      setError('איפוס נכשל. נסה שוב.');
    } finally {
      setResetting(false);
    }
  };

  // "לקוח בלבד" — the on-device cost of producing one frame, to sit alongside
  // "שרת בלבד" and End-to-End. Only capture + encode count: those are the two
  // stages a frame passes through BEFORE it is sent, so together they're the
  // client's share of the send path (render/feedback happen after the reply and
  // would double-count if added here). Present only for the all-users view: client
  // stage timings are process-wide, so the server omits them when scoped to one
  // user rather than misattribute other people's numbers.
  const clientOnly = useMemo(() => {
    const cs = data?.client_stage_latency;
    if (!cs) return null;
    const parts = ['capture', 'encode'].map((k) => cs[k]).filter(Boolean);
    if (parts.length === 0) return null;
    return {
      avg: parts.reduce((s, p) => s + (p.avg_ms ?? 0), 0),
      min: parts.reduce((s, p) => s + (p.min_ms ?? 0), 0),
      max: parts.reduce((s, p) => s + (p.max_ms ?? 0), 0),
    };
  }, [data]);

  /* Split the network time into an outbound and a return leg.
     There is no way to measure a ONE-WAY delay without synchronised clocks, so
     this leans on the one asymmetry we do have: the frame going up is ~40-70 KB
     while the result coming back is a small JSON. The health watchdog's /health
     ping carries almost nothing in either direction, so its round trip is
     essentially two propagations — half of it is what the reply needs just to
     travel, and everything left over is the time the compressed frame itself
     spends being pushed up the link. That is the number compression moves. */
  const netLegs = useMemo(() => {
    const rtt  = data?.client_rtt?.avg_ms ?? 0;
    const srv  = data?.server_latency?.avg_ms ?? 0;
    const base = data?.client_rtt?.base_ms ?? 0;
    const kb   = data?.frame_bytes?.avg_kb ?? 0;
    if (!(rtt > 0 && srv > 0)) return null;

    const net = rtt - srv;
    const kbR = Math.round(kb * 10) / 10;

    // The two legs are NOT measured over the same window, and that is why this
    // block used to blink out of existence. rtt and srv are all-time averages
    // read from the persisted per-minute buckets; base_ms is live — the last 100
    // /health pings of the CURRENT server process, gone on every restart. So the
    // split can legitimately be uncomputable, and when it is, saying why beats
    // disappearing: a row that silently vanishes reads as a broken page.
    if (!(base > 0)) {
      return { kb: kbR, unavailable: 'אין עדיין דגימת פינג חיה מהשרת הנוכחי — הפיצול לשני הכיוונים יופיע ברגע שמישהו יתחיל לסרוק.' };
    }

    const down = base / 2;
    const up   = net - down;
    if (!(net > 0) || !(up > 0)) {
      return { kb: kbR, unavailable: 'הפינג החי גדול מזמן הרשת הממוצע, כך שההלוך יוצא שלילי — כלומר הרשת כרגע איטית מהממוצע ההיסטורי, ואי אפשר לפצל אותה בכנות.' };
    }

    return {
      up:   Math.round(up),
      down: Math.round(down),
      kb:   kbR,
      perKb: kb > 0 ? Math.round((up / kb) * 10) / 10 : null,
    };
  }, [data]);

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

      {/* ── Scope: all users, or drill into one by email ── */}
      <form className="admin-scope-bar" onSubmit={applySearch}>
        <Search size={16} className="admin-scope-icon" />
        <input
          type="email"
          placeholder="חפש לפי אימייל (ריק = כל המשתמשים)"
          value={emailInput}
          onChange={(e) => setEmailInput(e.target.value)}
          dir="ltr"
        />
        <button type="submit" className="admin-scope-btn">הצג</button>
        {scope && (
          <button type="button" className="admin-scope-btn ghost" onClick={clearSearch}>
            הכל
          </button>
        )}
      </form>

      {notFound && <div className="admin-error">לא נמצא משתמש עם אימייל זה</div>}

      {loading && <div className="admin-loading">טוען נתוני ביצועים...</div>}
      {error   && <div className="admin-error">{error}</div>}

      {data && (
        <div className="admin-content">
          {/* ── Who this report covers ── */}
          {data.user && (
            <div className="admin-scope-note">
              <Smartphone size={13} />
              <span>
                מציג נתונים של <strong>{data.user.name || data.user.email}</strong>
                {' '}<span dir="ltr">({data.user.email})</span> — מאז הפריים הראשון שנרשם עבורו
              </span>
            </div>
          )}

          {/* ── Top stat cards ── */}
          <div className="admin-stats-grid">
            <StatCard
              icon={Clock}
              label="טווח נמדד"
              value={fmtUptime(measuredSpan)}
              // Streaming time is what the FPS card divides by, so it belongs next
              // to the calendar span: together they explain why a 30 FPS stream can
              // average 1.5 over the period. Summed across users it is session time,
              // not wall-clock (concurrent sessions overlap) — hence the two labels.
              sub={activeSeconds > 0
                ? `${data.user ? 'זמן שידור בפועל' : 'זמן שידור מצטבר'}: ${fmtUptime(activeSeconds)}`
                : undefined}
              color="#22d3ee"
            />
            {/* Capacity / actual / client are live rates from the in-memory tracker,
                so they describe the SERVER right now — not the searched user. When
                scoped to one person, show that person's own rate instead rather than
                put process-wide numbers under their name.

                That per-user rate is measured over time spent streaming, which is
                what makes it comparable to the live gauge beside it. Dividing by the
                calendar instead (fps.overall) answers a different question — how much
                of the period was used — so it rides along in the sub-line rather than
                masquerading as the same "FPS" the global view shows. */}
            <StatCard
              icon={Zap}
              label={data.user ? 'FPS ממוצע (למשתמש)' : 'FPS שרת (יכולת)'}
              value={data.user ? userFps : (data.fps?.server_capacity ?? 0)}
              sub={data.user
                ? `בזמן שידור בפועל · לאורך כל התקופה: ${data.fps?.overall ?? 0}`
                : `בפועל: ${data.fps?.server_actual ?? 0} | לקוח: ${data.fps?.client_actual ?? 0}`}
              color="#a78bfa"
            />
            <StatCard
              icon={CheckCircle}
              label="פריימים"
              value={data.total_frames?.toLocaleString()}
              sub={`${data.success_count} ✓  ${data.failure_count} ✗`}
              color="#22c55e"
            />
            {/* Same correction as the FPS card: successful frames per second of
                streaming, not per second of calendar. */}
            <StatCard
              icon={Gauge}
              label="תפוקה (Throughput)"
              value={`${throughputPs}/שנ׳`}
              sub={`פריימים מוצלחים לשנייה — בזמן שידור בפועל${
                data.throughput?.per_second != null
                  ? ` · לאורך כל התקופה: ${data.throughput.per_second}`
                  : ''}`}
              color="#f59e0b"
            />
          </div>

          {/* ── Response-time comparison ── */}
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
            {/* Client-only = the on-device cost of PRODUCING a frame (capture + encode).
                render/feedback are excluded on purpose: they happen after the result
                comes back, so they aren't part of the send path this row compares. */}
            {clientOnly && (
              <LatencyRow
                label="לקוח בלבד"
                avg={clientOnly.avg}
                min={clientOnly.min}
                max={clientOnly.max}
                color="#f472b6"
                fmt={fmtStageMs}
              />
            )}
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
                  רשת (הערכה): {Math.round(data.client_rtt.avg_ms - data.server_latency.avg_ms)}ms~
                </span>
              </div>
            )}
            {netLegs && (
              <>
                <div className="admin-network-legs">
                  {netLegs.unavailable ? (
                    <span>{netLegs.unavailable}</span>
                  ) : (
                    <>
                      <span>הלוך (העלאת הפריים) ~{netLegs.up}ms</span>
                      <span>חזור (התוצאה) ~{netLegs.down}ms</span>
                    </>
                  )}
                  {netLegs.kb > 0 && <span>{netLegs.kb}KB לפריים</span>}
                  {netLegs.perKb != null && <span>~{netLegs.perKb}ms לכל KB</span>}
                </div>
                {!netLegs.unavailable && (
                  <p className="admin-network-legs-note">
                    * החזור נאמד מחצי מזמן הפינג הקטן ({Math.round(data.client_rtt.base_ms)}ms),
                    שכמעט ואין לו מה להעביר — ולכן הוא בעצם זמן ההגעה לכיוון אחד.
                    ההלוך הוא כל השאר, כלומר הזמן שבו הפריים הדחוס עצמו עולה.
                    הקטנת הדחיסה אמורה להזיז את ההלוך ולהשאיר את החזור כמעט זהה.
                    הפינג נמדד חי ואילו שאר המספרים הם ממוצע כל ההיסטוריה, ולכן הפיצול הוא הערכה בלבד.
                  </p>
                )}
              </>
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
              {/* The size the client actually negotiated, not what the repo says.
                  INPUT_SIZE lives in the client bundle, so a cached or un-redeployed
                  bundle keeps sending the old size — and since it directly sets how
                  much work YOLO does, that is otherwise only inferable by comparing
                  inference times. */}
              {data.input_size && (
                <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginTop: 6 }}>
                  גודל קלט בפועל: <strong dir="ltr">{data.input_size}×{data.input_size}</strong>
                  {' '}(מה שהלקוח שולח בפועל)
                  {data.frame_bytes?.avg_kb > 0 && (
                    <> · משקל ממוצע לפריים: <strong dir="ltr">{data.frame_bytes.avg_kb}KB</strong></>
                  )}
                </p>
              )}
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 4 }}>
                * נמדד רק על פריימים שעברו את כל השלבים בהצלחה (לא כולל פריימים שנדחו בבדיקת איכות).
                חמשת השלבים הראשונים מרכיבים יחד את &quot;שרת בלבד&quot;. הכתיבה ל-DB היא היוצאת
                מן הכלל — היא רצה בצרורות ברקע פעם בשנייה, ולכן מוצג כאן המחיר הממוצע לרשומה
                והוא לא נספר בתוך זמן הפריים.
              </p>
            </div>
          )}

          {/* ── Stage-by-stage CLIENT latency breakdown (live only) ── */}
          {data.client_stage_latency && Object.keys(data.client_stage_latency).length > 0 && (
            <div className="admin-section">
              <h2 className="admin-section-title">
                <Smartphone size={16} />
                פירוט זמן עיבוד בלקוח (לפי שלב)
              </h2>
              {CLIENT_STAGE_ORDER
                .filter((key) => data.client_stage_latency[key])
                .map((key) => (
                  <LatencyRow
                    key={key}
                    label={CLIENT_STAGE_LABELS[key] ?? key}
                    avg={data.client_stage_latency[key].avg_ms}
                    min={data.client_stage_latency[key].min_ms}
                    max={data.client_stage_latency[key].max_ms}
                    color="#a78bfa"
                    fmt={fmtStageMs}
                  />
                ))}
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 4 }}>
                * מדידה על מכשיר הלקוח (מדווח כל 5 שנ׳). לא כולל זמן רשת/שרת (מוצג בנפרד כ-RTT). זמין במצב חי בלבד.
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

          {/* ── Reset performance data (super admin / level 2 only) ──
               Scoped to whatever is on screen, and the label says which, so the
               button can't read as "reset this user" while wiping everyone. */}
          {actorLevel >= 2 && (
            <button className="admin-reset-btn" onClick={() => setShowReset(true)}>
              <RotateCcw size={16} />
              {scope
                ? `אפס נתוני ביצועים של ${data.user?.name || scope}`
                : 'אפס את כל נתוני הביצועים (כל המשתמשים)'}
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
              <h3 className="admin-modal-title">
                {scope ? 'לאפס את נתוני המשתמש?' : 'לאפס את נתוני כל המשתמשים?'}
              </h3>
              <p className="admin-modal-body">
                {scope ? (
                  <>
                    פעולה זו תמחק <strong>לצמיתות</strong> את היסטוריית הביצועים של{' '}
                    <strong>{data.user?.name || scope}</strong> <span dir="ltr">({scope})</span> בלבד.
                    נתוני שאר המשתמשים לא ייפגעו. <strong>אי אפשר לבטל.</strong>
                  </>
                ) : (
                  <>
                    פעולה זו תמחק <strong>לצמיתות</strong> את כל מדדי הביצועים של{' '}
                    <strong>כל המשתמשים</strong> — גם את הנתונים החיים וגם את כל ההיסטוריה
                    השמורה. הספירה תתחיל מאפס. <strong>אי אפשר לבטל.</strong>
                  </>
                )}
              </p>
              <button className="admin-reset-btn confirm" onClick={handleReset} disabled={resetting}>
                <RotateCcw size={16} />
                {resetting ? 'מאפס...' : (scope ? 'כן, אפס משתמש זה' : 'כן, אפס הכל')}
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