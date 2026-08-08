import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Activity, Server, Wifi, Clock, Zap, Gauge, CheckCircle, RotateCcw, AlertTriangle, Smartphone, Search } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import apiClient from '../api/client';
import { getOverview } from '../services/adminService';

const pageVariants = {
  hidden:  { opacity: 0, x: 40 },
  visible: { opacity: 1, x: 0,  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, x: 40, transition: { duration: 0.22, ease: 'easeIn' } },
};

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

const fmtStageMs = (ms) => {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
};

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

const OutcomeRow = ({ label, value = 0, total, color }) => {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="admin-outcome-row">
      <span className="admin-outcome-label" style={{ color }}>{label}</span>
      <span className="admin-outcome-track">
        <span className="admin-outcome-fill" style={{ width: `${Math.min(100, pct)}%`, background: color }} />
      </span>
      <span className="admin-outcome-value" dir="ltr">
        {value.toLocaleString()}
        <span className="admin-outcome-pct">
          {value === 0 ? '0%' : `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`}
        </span>
      </span>
    </div>
  );
};

const STAGE_LABELS = {
  decode_quality: 'פענוח + בדיקת איכות',
  inference:      'YOLO (מודל)',
  tracking:       'מעקב תנועה (Tracking)',
  danger_logic:   'לוגיקת סכנה',
  response:       'בניית תשובה ושליחה',
  db_write:       'כתיבה ל-DB (לרשומה)',
  db_flush:       'כתיבה ל-DB (צרור שלם)',
};
const STAGE_ORDER = ['decode_quality', 'inference', 'tracking', 'danger_logic', 'response', 'db_write', 'db_flush'];

const CLIENT_STAGE_LABELS = {
  capture:  'צילום פריים',
  encode:   'דחיסת JPEG',
  render:   'ציור תוצאה + HUD',
  feedback: 'קול + רטט (התראה)',
};
const CLIENT_STAGE_ORDER = ['capture', 'encode', 'render', 'feedback'];

const UTIL_OVER_COLOR = '#ef4444';
const overStyle = (util) =>
  (util != null && util > 100 ? { color: UTIL_OVER_COLOR, fontWeight: 700 } : undefined);
const OVER_TITLE = 'מעל 100% — ההערכה של התקרה כבר לא מדויקת (ראה הערה בקוד). המספר אמיתי, אבל אי אפשר לקרוא אותו כאחוז מתקרה ידועה.';


const FPS_GAP_TOLERANCE = 1.08;
const GAP_COLOR = '#f59e0b';
const GAP_TITLE = 'הלקוח שולח יותר פריימים ממה שהשרת מקבל — כלומר פריימים אובדים בדרך. זה לא באג בתצוגה אלא סימן לבעיית העלאה.';

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

    ctx.clearRect(0, 0, w, h);

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
    drawThreshold(130, 'rgba(234,179,8,0.5)',  '130ms');
    drawThreshold(170, 'rgba(249,115,22,0.5)', '170ms');
    drawThreshold(200, 'rgba(239,68,68,0.5)',  '200ms');

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

    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    grad.addColorStop(0, 'rgba(34,211,238,0.25)');
    grad.addColorStop(1, 'rgba(34,211,238,0)');
    ctx.lineTo(pad.left + (values.length - 1) * stepX, pad.top + plotH);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    if (values.length > 0) {
      const lastX = pad.left + (values.length - 1) * stepX;
      const lastY = pad.top + plotH * (1 - values[values.length - 1] / maxVal);
      ctx.beginPath();
      ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#22d3ee';
      ctx.fill();
    }

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


const AdminStatus = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const emailParam = searchParams.get('email');
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const intervalRef = useRef(null);

  const [scope, setScope]     = useState(emailParam);
  const scopeRef              = useRef(scope);
  useEffect(() => { scopeRef.current = scope; }, [scope]);

  const [emailInput, setEmailInput] = useState(emailParam ?? '');

  useEffect(() => {
    const next = emailParam || null;
    if (next !== scopeRef.current) {
      setScope(next);
      setEmailInput(next ?? '');
    }
  }, [emailParam]);
  const [notFound, setNotFound]     = useState(false);

  const [showReset, setShowReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [actorLevel, setActorLevel] = useState(0);

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
      else if (status === 404) { setNotFound(true); setError(null); setData(null); }
      else                     setError('שגיאה בטעינת נתונים');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(fetchStatus, 3000);
    return () => clearInterval(intervalRef.current);
  }, [scope]);

  const applySearch = (e) => {
    e?.preventDefault();
    const v = emailInput.trim();
    setScope(v || null);
    setSearchParams(v ? { email: v } : {}, { replace: true });
  };

  const clearSearch = () => {
    setEmailInput('');
    setScope(null);
    setSearchParams({}, { replace: true });
  };

  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const measuredSpan = useMemo(() => {
    const first = data?.range?.first_ts;
    if (!first || nowSec < first) return data?.uptime_seconds ?? 0;
    return nowSec - first;
  }, [data, nowSec]);

  const activeSeconds = data?.range?.active_seconds ?? 0;
  const userFps = data?.fps?.active ?? data?.fps?.overall ?? 0;
  const throughputPs = data?.throughput?.active_per_second
    ?? data?.throughput?.per_second ?? 0;

  const handleReset = async () => {
    setResetting(true);
    try {
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

  const srvUtil = useMemo(() => {
    const cap = data?.fps?.server_capacity ?? 0;
    const act = data?.fps?.server_actual ?? 0;
    if (!(cap > 0 && act > 0)) return null;
    return Math.round((act / cap) * 100);
  }, [data]);

  const cliUtil = useMemo(() => {
    const act  = data?.fps?.client_actual ?? 0;
    const cost = clientOnly?.avg ?? 0;
    if (!(act > 0 && cost > 0)) return null;
    return Math.round((act / (1000 / cost)) * 100);
  }, [data, clientOnly]);


  const fpsGap = useMemo(() => {
    const cli = data?.fps?.client_actual ?? 0;
    const srv = data?.fps?.server_actual ?? 0;
    if (!(cli > 0 && srv > 0)) return null;
    if (cli <= srv * FPS_GAP_TOLERANCE) return null;
    return Math.round(((cli - srv) / cli) * 100);
  }, [data]);

  const outcomes = useMemo(() => {
    if (!data) return null;
    const success      = data.success_count ?? 0;
    const reject       = data.reject_count ?? 0;
    const error        = data.error_count ?? 0;
    const unclassified = data.unclassified_count ?? 0;
    const lost         = data.lost_count ?? 0;
    const sent = success + reject + error + unclassified + lost;
    if (sent === 0) return null;
    return { success, reject, error, unclassified, lost, sent };
  }, [data]);

  const netLegs = useMemo(() => {
    const rtt  = data?.client_rtt?.avg_ms ?? 0;
    const srv  = data?.server_latency?.avg_ms ?? 0;
    const base = data?.client_rtt?.base_ms ?? 0;
    const kb   = data?.frame_bytes?.avg_kb ?? 0;
    if (!(rtt > 0 && srv > 0)) return null;

    const net = rtt - srv;
    const kbR = Math.round(kb * 10) / 10;

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
      <header className="inner-page-header">
        <button className="back-btn" onClick={() => navigate('/settings')} aria-label="חזור">
          <ArrowRight size={22} />
        </button>
        <span className="inner-page-title">ביצועי מערכת</span>
        <div style={{ width: 46 }} />
      </header>

      <div className="inner-page-body">

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
          {data.user && (
            <div className="admin-scope-note">
              <Smartphone size={13} />
              <span>
                מציג נתונים של <strong>{data.user.name || data.user.email}</strong>
                {' '}<span dir="ltr">({data.user.email})</span> — מאז הפריים הראשון שנרשם עבורו
              </span>
            </div>
          )}

          <div className="admin-stats-grid">
            <StatCard
              icon={Clock}
              label="טווח נמדד"
              value={fmtUptime(measuredSpan)}
              sub={activeSeconds > 0
                ? `${data.user ? 'זמן שידור בפועל' : 'זמן שידור מצטבר'}: ${fmtUptime(activeSeconds)}`
                : undefined}
              color="#22d3ee"
            />
            <StatCard
              icon={Zap}
              label={data.user ? 'FPS ממוצע (למשתמש)' : 'FPS שרת (יכולת)'}
              value={data.user ? userFps : (data.fps?.server_capacity ?? 0)}
              sub={data.user
                ? `בזמן שידור בפועל · לאורך כל התקופה: ${data.fps?.overall ?? 0}`
                : (
                  <span className="admin-stat-sub-rows">
                    <span
                      style={overStyle(srvUtil)}
                      title={srvUtil > 100 ? OVER_TITLE : undefined}
                    >
                      שרת בפועל: {data.fps?.server_actual ?? 0}
                      {srvUtil != null && <> · ניצולת שרת: {srvUtil}%</>}
                    </span>
                    <span
                      style={overStyle(cliUtil)}
                      title={cliUtil > 100 ? OVER_TITLE : undefined}
                    >
                      לקוח בפועל: {data.fps?.client_actual ?? 0}
                      {cliUtil != null && <> · ניצולת לקוח: {cliUtil}%</>}
                    </span>
                    {fpsGap != null && (
                      <span
                        style={{ color: GAP_COLOR, fontWeight: 700 }}
                        title={GAP_TITLE}
                      >
                        ⚠ פער לקוח/שרת: {fpsGap}% מהפריימים לא הגיעו
                      </span>
                    )}
                  </span>
                )}
              color="#a78bfa"
            />
            <StatCard
              icon={CheckCircle}
              label="פריימים"
              value={data.total_frames?.toLocaleString()}
              sub={`${data.success_count} ✓  ${data.failure_count} ✗`}
              color="#22c55e"
            />
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

          {outcomes && (
            <div className="admin-section">
              <h2 className="admin-section-title">
                <CheckCircle size={16} />
                גורל הפריימים
              </h2>
              <OutcomeRow label="✓ הצלחה"                value={outcomes.success} total={outcomes.sent} color="#22c55e" />
              <OutcomeRow label="⊘ נדחה בבדיקת איכות"   value={outcomes.reject}  total={outcomes.sent} color="#f59e0b" />
              <OutcomeRow label="⚠ שגיאת שרת"           value={outcomes.error}   total={outcomes.sent} color="#ef4444" />
              <OutcomeRow label="✗ נאבד בדרך"           value={outcomes.lost}    total={outcomes.sent} color="#a1a1aa" />
              {outcomes.unclassified > 0 && (
                <OutcomeRow label="? כשל לא מסווג" value={outcomes.unclassified} total={outcomes.sent} color="#6b7280" />
              )}
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 8, lineHeight: 1.6 }}>
                * מתוך {outcomes.sent.toLocaleString()} פריימים שהלקוח שלח. כל פריים מסתיים באחת מהאפשרויות
                האלה בדיוק, ולכן האחוזים מסתכמים ל-100.
                {' '}<strong>נדחה בבדיקת איכות</strong> = הגיע לשרת ונפסל (טשטוש, חושך, עדשה מכוסה) — העולם קשה, לא תקלה.
                {' '}<strong>שגיאת שרת</strong> = הגיע והתרסק; זה באחריותנו לתקן.
                {' '}<strong>נאבד בדרך</strong> = נשלח ולא חזרה עליו תשובה. נמדד בטלפון (השרת לא יכול לספור מה שלא הגיע אליו),
                ואמור להיות אפס כמעט תמיד — WebSocket רץ מעל TCP שלא מאבד מידע בשקט, אז כל מספר שאינו אפס מעיד
                על חיבור שנקטע עם פריימים באוויר או על שרת שנתקע.
                {outcomes.unclassified > 0 && ' כשל לא מסווג = נרשם לפני שהפיצול הזה נוסף, ולכן הסיבה לא ידועה.'}
              </p>
            </div>
          )}

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
              label="RTT (רשת + שרת)"
              avg={data.client_rtt?.avg_ms}
              min={data.client_rtt?.min_ms}
              max={data.client_rtt?.max_ms}
              color="#22d3ee"
            />
            {data.client_e2e?.avg_ms > 0 && (
              <LatencyRow
                label="E2E Latency"
                avg={data.client_e2e.avg_ms}
                min={data.client_e2e.min_ms}
                max={data.client_e2e.max_ms}
                color="#4ade80"
              />
            )}
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
                      <span>הלוך (העלאת הפריים) {netLegs.up}ms~</span>
                      <span>חזור (התוצאה) {netLegs.down}ms~</span>
                    </>
                  )}
                  {netLegs.kb > 0 && <span>{netLegs.kb}KB לפריים</span>}
                  {netLegs.perKb != null && <span>{netLegs.perKb}ms~ לכל KB</span>}
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
              {data.input_size && (
                <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginTop: 6 }}>
                  גודל קלט בפועל: <strong dir="ltr">{data.input_size}×{data.input_size}</strong>
                  {' '}(מה שהלקוח שולח בפועל)
                  {data.frame_bytes?.avg_kb > 0 && (
                    <> · משקל ממוצע לפריים: <strong dir="ltr">{data.frame_bytes.avg_kb}KB</strong></>
                  )}
                </p>
              )}
              {data.stream_config && (
                <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginTop: 4 }}>
                  עומק צנרת (MAX INFLIGHT): <strong dir="ltr">{data.stream_config.max_inflight}</strong>
                  {' '}· דחיסה: <strong dir="ltr">{data.stream_config.compression_percent}%</strong>
                  <br />
                  <span style={{ color: 'rgba(255,255,255,0.35)' }}>
                    עומק הצנרת = כמה פריימים מותר שיהיו בדרך לשרת בו-זמנית.
                    לפי חוק ליטל: FPS = עומק ÷ זמן הלוך-חזור, והשהיה = עומק × זמן לפריים.
                    העלאתו מוסיפה FPS רק כל עוד לצוואר הבקבוק נותר מקום (ניצולת מתחת ל-100%);
                    אחרת היא מוסיפה השהיה בלבד.
                  </span>
                </p>
              )}
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 4 }}>
                * נמדד רק על פריימים שעברו את כל השלבים בהצלחה (לא כולל פריימים שנדחו בבדיקת איכות).
                חמשת השלבים הראשונים מרכיבים יחד את &quot;שרת בלבד&quot;. שתי שורות ה-DB הן היוצאות
                מן הכלל — הכתיבה רצה בצרורות ברקע פעם בשנייה, ולכן <strong>אף אחת מהן לא נספרת
                בתוך זמן הפריים</strong>.
                <br />
                <strong>צרור שלם</strong> = כמה זמן לקח כל הסבב מול MongoDB (insert_many אחד +
                bulk_write אחד, למסד שנמצא ~4,000 ק&quot;מ משם). <strong>לרשומה</strong> = אותו מספר
                חלקי מספר הרשומות בצרור
                {data.db_writer?.last_flush_records > 0 && (
                  <> (בצרור האחרון: <strong dir="ltr">{data.db_writer.last_flush_records}</strong> רשומות)</>
                )}.
                אם ה&quot;צרור שלם&quot; עולה בלי שמספר הרשומות עולה — הבעיה במסד או בקו אליו,
                לא בקצב הפריימים.
              </p>
            </div>
          )}

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

          {data.rtt_history && data.rtt_history.length >= 2 && (
            <div className="admin-section">
              <h2 className="admin-section-title">
                <Wifi size={16} />
                גרף RTT בזמן אמת
              </h2>
              <RttChart history={data.rtt_history} />
            </div>
          )}

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