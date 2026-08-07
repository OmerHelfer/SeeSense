import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  ArrowRight, Sliders, Save, RotateCcw, CheckCircle, AlertTriangle, Info,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  getStreamConfig, updateStreamConfig, resetStreamConfig,
} from '../services/adminService';

const pageVariants = {
  hidden:  { opacity: 0, x: 40 },
  visible: { opacity: 1, x: 0,  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, x: 40, transition: { duration: 0.22, ease: 'easeIn' } },
};

const FIELDS = [
  {
    key:   'input_size',
    label: 'גודל קלט (פיקסלים)',
    unit:  'px',
    help:  'הגודל הריבועי שנשלח למודל. גדול יותר = זיהוי טוב יותר של עצמים רחוקים, אבל כל פריים כבד יותר ברשת ואיטי יותר בעיבוד.',
    step:  32,
  },
  {
    key:   'compression_percent',
    label: 'אחוז דחיסה',
    unit:  '%',
    help:  'כמה לדחוס כל פריים לפני השליחה. גבוה יותר = פחות בייטים ברשת ו-FPS גבוה יותר בחיבור חלש, אבל איכות תמונה נמוכה יותר, ומעל ~85% הביטחון של המודל יורד מתחת לסף הזיהוי.',
    step:  5,
  },
  {
    key:   'max_inflight',
    label: 'עומק צנרת (MAX INFLIGHT)',
    unit:  'פריימים',
    help:  'כמה פריימים מותר שיהיו בדרך לשרת בו-זמנית לפני שהלקוח עוצר. לפי חוק ליטל: FPS = עומק ÷ זמן הלוך-חזור, וגם השהיה = עומק × זמן לפריים. העלאה מוסיפה FPS רק כל עוד לצוואר הבקבוק יש עוד מקום — אחרת היא רק מוסיפה השהיה.',
    step:  1,
  },
];

const AdminStreamConfig = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = (user?.admin_level ?? 0) >= 2;

  const [config, setConfig]   = useState(null);
  const [limits, setLimits]   = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [draft, setDraft]     = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState('');
  const [toast, setToast]     = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getStreamConfig();
      setConfig(res.config);
      setLimits(res.limits);
      setDefaults(res.defaults);
      setDraft(res.config);
    } catch {
      setError('טעינת ההגדרות נכשלה.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const dirty = config && FIELDS.some((f) => Number(draft[f.key]) !== Number(config[f.key]));

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const next = await updateStreamConfig({
        input_size:          Number(draft.input_size),
        compression_percent: Number(draft.compression_percent),
        max_inflight:        Number(draft.max_inflight),
      });
      setConfig(next);
      setDraft(next);
      flash('ההגדרות נשמרו. ייכנסו לתוקף בסריקה הבאה של כל לקוח.');
    } catch (e) {
      setError(e?.response?.data?.detail || 'השמירה נכשלה.');
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    setError('');
    try {
      const next = await resetStreamConfig();
      setConfig(next);
      setDraft(next);
      flash('ההגדרות אופסו לברירת המחדל.');
    } catch {
      setError('האיפוס נכשל.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div className="inner-page" variants={pageVariants} initial="hidden" animate="visible" exit="exit">
      <header className="inner-page-header">
        <button className="back-btn" onClick={() => navigate('/settings')} aria-label="חזרה">
          <ArrowRight size={22} />
        </button>
        <span className="inner-page-title">הגדרות שידור</span>
        <div style={{ width: 46 }} />
      </header>

      <div className="inner-page-body">
        <div className="asc-notice">
          <AlertTriangle size={15} />
          <span>
            ההגדרות האלה <strong>גלובליות</strong> — הן חלות על כל המשתמשים, לא רק עליך.
            שינוי נכנס לתוקף בסריקה הבאה של כל לקוח, ולא באמצע סריקה פעילה.
          </span>
        </div>

        <AnimatePresence>
          {toast && (
            <motion.div className="au-toast"
              initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
              <CheckCircle size={15} /> {toast}
            </motion.div>
          )}
        </AnimatePresence>

        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}

        {loading && <div className="admin-loading">טוען...</div>}

        {!loading && config && (
          <>
            {!canEdit && (
              <div className="asc-notice asc-notice-muted">
                <Info size={15} />
                <span>לצפייה בלבד — שינוי ההגדרות דורש אדמין רמה 2.</span>
              </div>
            )}

            <div className="au-card">
              <div className="asc-card-title">
                <Sliders size={16} />
                <span>פרמטרים</span>
              </div>

              {FIELDS.map((f) => {
                const lim = limits?.[f.key] ?? {};
                const live = config[f.key];
                const val  = draft[f.key];
                const changed = Number(val) !== Number(live);
                return (
                  <div key={f.key} className="asc-field">
                    <div className="asc-field-head">
                      <label htmlFor={`asc-${f.key}`}>{f.label}</label>
                      <span className="asc-range" dir="ltr">{lim.min}–{lim.max}</span>
                    </div>

                    <div className="asc-input-row">
                      <input
                        id={`asc-${f.key}`}
                        type="number"
                        dir="ltr"
                        value={val ?? ''}
                        min={lim.min}
                        max={lim.max}
                        step={f.step}
                        disabled={!canEdit || busy}
                        onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      />
                      <span className="asc-unit">{f.unit}</span>
                    </div>

                    <p className="asc-help">{f.help}</p>

                    <div className="asc-live">
                      <span>פעיל כעת בשרת: <strong dir="ltr">{live}</strong></span>
                      {defaults && (
                        <span className="asc-default">ברירת מחדל: <span dir="ltr">{defaults[f.key]}</span></span>
                      )}
                      {changed && <span className="asc-changed">שונה — טרם נשמר</span>}
                    </div>
                  </div>
                );
              })}

              {canEdit && (
                <div className="asc-actions">
                  <button className="asc-save" onClick={save} disabled={busy || !dirty}>
                    <Save size={15} /> שמור
                  </button>
                  <button className="asc-reset" onClick={reset} disabled={busy}>
                    <RotateCcw size={15} /> אפס לברירת מחדל
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        <div style={{ height: 40 }} />
      </div>
    </motion.div>
  );
};

export default AdminStreamConfig;
