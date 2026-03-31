import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Trash2, Flag, AlertTriangle, Clock, ChevronDown, ChevronUp, CheckCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '../context/AuthContext';
import {
  getHistory,
  deleteHistoryRecord,
  feedbackFromHistory,
  getFeedbackRecordIds,
} from '../services/userService';

// ── Page transition variants ──────────────────────────
const pageVariants = {
  hidden:  { opacity: 0, x: 40 },
  visible: { opacity: 1, x: 0,  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, x: 40, transition: { duration: 0.22, ease: 'easeIn' } },
};

const modalVariants = {
  hidden:  { opacity: 0, scale: 0.93, y: 24 },
  visible: { opacity: 1, scale: 1,    y: 0,  transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, scale: 0.93, y: 24, transition: { duration: 0.18, ease: 'easeIn' } },
};

// ── Helpers ───────────────────────────────────────────

const PERIODS = [
  { key: 'all',          label: 'הכל'       },
  { key: 'today',        label: 'היום'      },
  { key: 'week',         label: 'שבוע'      },
  { key: 'month',        label: 'חודש'      },
  { key: 'three_months', label: '3 חודשים'  },
  { key: 'half_year',    label: 'חצי שנה'   },
  { key: 'older',        label: 'ישן יותר'  },
];

const FEEDBACK_TYPES = [
  { key: 'wrong_detection', label: 'זיהוי שגוי'    },
  { key: 'missed_obstacle', label: 'פספוס מכשול'   },
  { key: 'general',         label: 'כללי'           },
];

/** Hebrew names for detected object classes. */
const HEBREW_NAMES = {
  person:        'אדם',
  car:           'מכונית',
  bicycle:       'אופניים',
  motorcycle:    'אופנוע',
  bench:         'ספסל',
  fire_hydrant:  'ברז כיבוי אש',
  traffic_light: 'רמזור',
  stairs:        'מדרגות',
  pole:          'עמוד',
  dog:           'כלב',
  bus:           'אוטובוס',
  truck:         'משאית',
};

function hebrewName(className) {
  return HEBREW_NAMES[className] || className || '?';
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('he-IL', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDate(ts) {
  const d = new Date(ts);
  const datePart = d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long' });
  const timePart = d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  return `${datePart} ${timePart}`;
}

function isToday(ts) {
  const d = new Date(ts);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth()    === now.getMonth()    &&
    d.getDate()     === now.getDate()
  );
}

function alertLevelColor(level) {
  if (level === 'high') return 'var(--danger)';
  if (level === 'low')  return 'var(--caution)';
  return 'var(--text-3)';
}

function alertLevelLabel(level) {
  if (level === 'high') return 'סכנה גבוהה';
  if (level === 'low')  return 'סכנה נמוכה';
  return 'ללא';
}

function safetyScoreColor(score) {
  if (score >= 80) return 'var(--safe)';
  if (score >= 60) return 'var(--caution)';
  return 'var(--danger)';
}

/** Group records by session_id, preserving order. */
function groupBySession(records) {
  const groups = [];
  const map = new Map();
  for (const r of records) {
    const sid = r.session_id ?? 'unknown';
    if (!map.has(sid)) {
      const group = { session_id: sid, records: [] };
      map.set(sid, group);
      groups.push(group);
    }
    map.get(sid).records.push(r);
  }
  return groups;
}

/** Build display info for a session header. */
function sessionInfo(records) {
  if (!records.length) return {};
  const first = new Date(records[records.length - 1].timestamp);
  const last  = new Date(records[0].timestamp);
  const date  = first.toLocaleDateString('he-IL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const t1 = first.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  const t2 = last.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  const dangers = records.filter((r) => r.danger).length;
  return { date, time: `${t1} – ${t2}`, count: records.length, dangers };
}

/** Build display string for detected objects in a frame. */
function objectsLabel(record) {
  const objs = record.objects ?? [];
  if (objs.length > 0) {
    return objs.map((o) => hebrewName(o.class_name)).join(', ');
  }
  // Fallback for old records that don't have object names
  if (record.objects_detected > 0) {
    return `${record.objects_detected} עצמים`;
  }
  return 'ללא זיהוי';
}

// ── Component ─────────────────────────────────────────

const History = () => {
  const navigate = useNavigate();
  const { user }  = useAuth();

  const [records,     setRecords]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [loadError,   setLoadError]   = useState('');
  const [period,      setPeriod]      = useState('all');

  // Which sessions are expanded
  const [expandedSessions, setExpandedSessions] = useState(new Set());

  // Record IDs that already have feedback
  const [feedbackIds, setFeedbackIds] = useState(new Set());

  // modal
  const [activeRecord, setActiveRecord] = useState(null);
  const [modalView,    setModalView]    = useState('menu');

  // feedback form
  const [fbType,    setFbType]    = useState('wrong_detection');
  const [fbNotes,   setFbNotes]   = useState('');
  const [fbLoading, setFbLoading] = useState(false);
  const [fbError,   setFbError]   = useState('');

  // delete
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError,   setDeleteError]   = useState('');

  // ── Fetch history ──────────────────────────────────
  const loadHistory = useCallback(async (p = period) => {
    setLoading(true);
    setLoadError('');
    try {
      const { history } = await getHistory({ limit: 200, period: p });
      setRecords(history ?? []);
    } catch {
      setLoadError('לא ניתן לטעון היסטוריה. נסה שוב.');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    loadHistory(period);
  }, [period, loadHistory]);

  // Load which records already have feedback
  useEffect(() => {
    getFeedbackRecordIds().then(setFeedbackIds).catch(() => {});
  }, [records]);

  // Auto-expand first session on initial load
  useEffect(() => {
    if (records.length > 0) {
      const groups = groupBySession(records);
      if (groups.length > 0 && expandedSessions.size === 0) {
        setExpandedSessions(new Set([groups[0].session_id]));
      }
    }
  }, [records]);

  // ── Summary stats ──────────────────────────────────
  const total        = records.length;
  const todayDanger  = records.filter((r) => r.danger && isToday(r.timestamp)).length;
  const dangerCount  = records.filter((r) => r.danger).length;
  const safetyScore  = total > 0 ? Math.round((1 - dangerCount / total) * 100) : 100;

  // ── Session expand/collapse ─────────────────────────
  const toggleSession = (sessionId) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

  // ── Modal helpers ──────────────────────────────────
  const openActionSheet = (record) => {
    setActiveRecord(record);
    setModalView('menu');
    setFbType('wrong_detection');
    setFbNotes('');
    setFbError('');
    setDeleteError('');
  };

  const closeModal = () => {
    setActiveRecord(null);
    setModalView('menu');
  };

  // ── Feedback submit ────────────────────────────────
  const handleFeedbackSubmit = async () => {
    if (!activeRecord) return;
    setFbError('');
    setFbLoading(true);
    try {
      await feedbackFromHistory({
        record_id:     activeRecord.record_id,
        feedback_type: fbType,
        notes:         fbNotes.trim() || undefined,
      });
      setModalView('feedbackDone');
      setTimeout(() => closeModal(), 1500);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setFbError(typeof detail === 'string' ? detail : 'שליחת המשוב נכשלה. נסה שוב.');
    } finally {
      setFbLoading(false);
    }
  };

  // ── Delete record ──────────────────────────────────
  const handleDelete = async () => {
    if (!activeRecord) return;
    setDeleteError('');
    setDeleteLoading(true);
    try {
      await deleteHistoryRecord(activeRecord.record_id);
      setRecords((prev) => prev.filter((r) => r.record_id !== activeRecord.record_id));
      closeModal();
    } catch {
      setDeleteError('מחיקה נכשלה. נסה שוב.');
    } finally {
      setDeleteLoading(false);
    }
  };

  const sessionGroups = groupBySession(records);

  // ── Render ─────────────────────────────────────────
  return (
    <motion.div
      className="inner-page"
      variants={pageVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      {/* ── Header ── */}
      <header className="inner-page-header">
        <button
          className="back-btn"
          onClick={() => navigate('/settings')}
          aria-label="חזרה"
        >
          <ArrowRight size={22} />
        </button>
        <span className="inner-page-title">היסטוריה</span>
        <div style={{ width: 46 }} />
      </header>

      <div className="inner-page-body">

        {/* ── Summary card ── */}
        <div className="glass-section" style={{ marginBottom: 16 }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 8,
          }}>
            {/* Tile: daily danger */}
            <div style={statTileStyle}>
              <span style={statValueStyle}>
                <AlertTriangle size={14} style={{ color: 'var(--danger)', marginInlineEnd: 4, flexShrink: 0 }} />
                {todayDanger}
              </span>
              <span style={statLabelStyle}>התראות היום</span>
            </div>

            {/* Tile: total scans */}
            <div style={statTileStyle}>
              <span style={statValueStyle}>
                <Clock size={14} style={{ color: 'var(--cyan)', marginInlineEnd: 4, flexShrink: 0 }} />
                {total}
              </span>
              <span style={statLabelStyle}>סריקות</span>
            </div>

            {/* Tile: safety score */}
            <div style={statTileStyle}>
              <span style={{ ...statValueStyle, color: safetyScoreColor(safetyScore) }}>
                {safetyScore}%
              </span>
              <span style={statLabelStyle}>ציון בטיחות</span>
            </div>
          </div>
        </div>

        {/* ── Filter chips ── */}
        <div style={{
          display: 'flex',
          flexDirection: 'row-reverse',
          gap: 8,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}>
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              style={{
                padding: '6px 16px',
                borderRadius: 999,
                border: period === p.key
                  ? '1.5px solid var(--cyan)'
                  : '1.5px solid var(--glass-border)',
                background: period === p.key
                  ? 'rgba(0,240,255,0.10)'
                  : 'var(--glass-bg)',
                color: period === p.key ? 'var(--cyan)' : 'var(--text-2)',
                fontSize: 13,
                fontFamily: 'var(--font-body)',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* ── Loading ── */}
        {loading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
            <div className="settings-loading">
              <div className="settings-loading-dot" />
              <div className="settings-loading-dot" />
              <div className="settings-loading-dot" />
            </div>
          </div>
        )}

        {/* ── Load error ── */}
        {!loading && loadError && (
          <div className="error-banner">{loadError}</div>
        )}

        {/* ── Empty state ── */}
        {!loading && !loadError && records.length === 0 && (
          <div className="empty-state">
            <span style={{ fontSize: 38 }}>🧭</span>
            <p>אין נתוני זיהוי עדיין</p>
          </div>
        )}

        {/* ── Sessions list ── */}
        {!loading && !loadError && sessionGroups.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {sessionGroups.map((group) => {
              const info = sessionInfo(group.records);
              const isExpanded = expandedSessions.has(group.session_id);

              return (
                <div
                  key={group.session_id}
                  style={{
                    background: 'var(--glass-bg)',
                    border: '1px solid var(--glass-border)',
                    borderRadius: 'var(--r-md)',
                    overflow: 'hidden',
                  }}
                >
                  {/* ── Session header — tap to expand/collapse ── */}
                  <button
                    onClick={() => toggleSession(group.session_id)}
                    style={{
                      width: '100%',
                      padding: '14px 16px',
                      border: 'none',
                      background: 'none',
                      cursor: 'pointer',
                      direction: 'rtl',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
                      <span style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: 'var(--text)',
                        fontFamily: 'var(--font-body)',
                      }}>
                        {info.date}
                      </span>
                      <span style={{
                        fontSize: 12,
                        color: 'var(--text-3)',
                        fontFamily: 'var(--font-body)',
                      }}>
                        {info.time} • {info.count} פריימים
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {info.dangers > 0 && (
                        <span style={{
                          background: 'rgba(255,59,48,0.12)',
                          color: 'var(--danger)',
                          borderRadius: 999,
                          padding: '2px 8px',
                          fontSize: 11,
                          fontFamily: 'var(--font-body)',
                        }}>
                          {info.dangers} התראות
                        </span>
                      )}
                      {isExpanded
                        ? <ChevronUp size={18} color="var(--text-3)" />
                        : <ChevronDown size={18} color="var(--text-3)" />
                      }
                    </div>
                  </button>

                  {/* ── Expanded frames ── */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.25 }}
                        style={{ overflow: 'hidden' }}
                      >
                        <div style={{
                          padding: '0 12px 12px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                        }}>
                          {group.records.map((record) => (
                            <div
                              key={record.record_id}
                              onClick={() => openActionSheet(record)}
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                padding: '10px 12px',
                                borderRadius: 'var(--r-sm)',
                                cursor: 'pointer',
                                direction: 'rtl',
                                transition: 'background 0.15s',
                                background: record.danger
                                  ? 'rgba(255,59,48,0.06)'
                                  : 'rgba(255,255,255,0.02)',
                                border: record.danger
                                  ? '1px solid rgba(255,59,48,0.15)'
                                  : '1px solid rgba(255,255,255,0.04)',
                              }}
                            >
                              {/* Frame info */}
                              <div style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 3,
                                flex: 1,
                                minWidth: 0,
                              }}>
                                {/* Row 1: time + alert badge */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <span style={{
                                    fontSize: 12,
                                    color: 'var(--text-3)',
                                    fontFamily: 'var(--font-body)',
                                    flexShrink: 0,
                                  }}>
                                    {formatTime(record.timestamp)}
                                  </span>
                                  <span style={{
                                    fontSize: 11,
                                    color: alertLevelColor(record.alert_level),
                                    background: `${alertLevelColor(record.alert_level)}18`,
                                    borderRadius: 999,
                                    padding: '1px 8px',
                                    fontFamily: 'var(--font-body)',
                                    flexShrink: 0,
                                  }}>
                                    {alertLevelLabel(record.alert_level)}
                                  </span>
                                </div>

                                {/* Row 2: object names in Hebrew */}
                                <span style={{
                                  fontSize: 13,
                                  color: 'var(--text)',
                                  fontFamily: 'var(--font-body)',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}>
                                  {objectsLabel(record)}
                                </span>

                                {/* Row 3: distance */}
                                <span style={{
                                  fontSize: 11,
                                  color: 'var(--text-3)',
                                  fontFamily: 'var(--font-body)',
                                }}>
                                  מרחק: {record.distance}
                                </span>
                              </div>

                              {/* Icons: danger + feedback */}
                              <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                flexShrink: 0,
                                marginInlineStart: 8,
                              }}>
                                {record.danger && (
                                  <AlertTriangle size={14} color="var(--danger)" />
                                )}
                                {feedbackIds.has(record.record_id)
                                  ? <CheckCircle size={14} color="var(--safe)" />
                                  : <Flag size={14} color="var(--text-3)" />
                                }
                              </div>
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ height: 40 }} />
      </div>

      {/* ── Action sheet modal ── */}
      <AnimatePresence>
        {activeRecord && (
          <>
            {/* Backdrop */}
            <motion.div
              className="modal-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={closeModal}
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.65)',
                zIndex: 100,
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'center',
              }}
            />

            {/* Sheet */}
            <motion.div
              className="modal-card"
              variants={modalVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              style={{
                position: 'fixed',
                bottom: 0,
                left: 0,
                right: 0,
                zIndex: 101,
                background: 'var(--bg-2)',
                border: '1px solid var(--glass-border)',
                borderRadius: 'var(--r-lg) var(--r-lg) 0 0',
                padding: '24px 20px 32px',
                direction: 'rtl',
                maxWidth: 520,
                margin: '0 auto',
              }}
            >
              {/* ── Menu view ── */}
              {modalView === 'menu' && (
                <>
                  <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 6, fontFamily: 'var(--font-body)' }}>
                    {formatDate(activeRecord.timestamp)}
                  </p>

                  {/* Show detected objects in modal header */}
                  {activeRecord.objects && activeRecord.objects.length > 0 && (
                    <p style={{
                      fontSize: 14,
                      color: 'var(--text)',
                      marginBottom: 16,
                      fontFamily: 'var(--font-body)',
                      fontWeight: 600,
                    }}>
                      {activeRecord.objects.map((o) => hebrewName(o.class_name)).join(', ')} — {activeRecord.distance}
                    </p>
                  )}

                  <button
                    className="ghost-btn"
                    style={{ width: '100%', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}
                    onClick={() => { setFbError(''); setModalView('feedback'); }}
                  >
                    <Flag size={16} />
                    דווח שגיאה
                  </button>

                  <button
                    className="danger-btn"
                    style={{ width: '100%', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}
                    onClick={() => { setDeleteError(''); setModalView('confirmDelete'); }}
                  >
                    <Trash2 size={16} />
                    מחק רשומה
                  </button>

                  <button
                    className="ghost-btn"
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}
                    onClick={closeModal}
                  >
                    סגור
                  </button>
                </>
              )}

              {/* ── Confirm delete view ── */}
              {modalView === 'confirmDelete' && (
                <>
                  <p style={{ fontSize: 15, color: 'var(--text)', marginBottom: 8, fontFamily: 'var(--font-body)', fontWeight: 600 }}>
                    מחיקת רשומה
                  </p>
                  <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 20, fontFamily: 'var(--font-body)' }}>
                    האם למחוק את הרשומה מ-{formatDate(activeRecord.timestamp)}?
                  </p>

                  {deleteError && (
                    <div className="error-banner" style={{ marginBottom: 12 }}>{deleteError}</div>
                  )}

                  <button
                    className="danger-btn"
                    style={{ width: '100%', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}
                    onClick={handleDelete}
                    disabled={deleteLoading}
                  >
                    <Trash2 size={16} />
                    {deleteLoading ? 'מוחק...' : 'כן, מחק'}
                  </button>

                  <button
                    className="ghost-btn"
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}
                    onClick={() => setModalView('menu')}
                    disabled={deleteLoading}
                  >
                    ביטול
                  </button>
                </>
              )}

              {/* ── Feedback form view ── */}
              {modalView === 'feedback' && (
                <>
                  <p style={{ fontSize: 15, color: 'var(--text)', marginBottom: 16, fontFamily: 'var(--font-body)', fontWeight: 600 }}>
                    דיווח שגיאה
                  </p>

                  {/* Feedback type chips */}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                    {FEEDBACK_TYPES.map((ft) => (
                      <button
                        key={ft.key}
                        onClick={() => setFbType(ft.key)}
                        style={{
                          padding: '6px 14px',
                          borderRadius: 999,
                          border: fbType === ft.key
                            ? '1.5px solid var(--cyan)'
                            : '1.5px solid var(--glass-border)',
                          background: fbType === ft.key
                            ? 'rgba(0,240,255,0.10)'
                            : 'var(--glass-bg)',
                          color: fbType === ft.key ? 'var(--cyan)' : 'var(--text-2)',
                          fontSize: 13,
                          fontFamily: 'var(--font-body)',
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        {ft.label}
                      </button>
                    ))}
                  </div>

                  {/* Notes textarea */}
                  <textarea
                    value={fbNotes}
                    onChange={(e) => setFbNotes(e.target.value)}
                    placeholder="הערות נוספות (אופציונלי)"
                    rows={3}
                    style={{
                      width: '100%',
                      background: 'var(--glass-bg)',
                      border: '1px solid var(--glass-border)',
                      borderRadius: 'var(--r-sm)',
                      color: 'var(--text)',
                      fontFamily: 'var(--font-body)',
                      fontSize: 14,
                      padding: '10px 12px',
                      resize: 'none',
                      outline: 'none',
                      boxSizing: 'border-box',
                      marginBottom: 12,
                      direction: 'rtl',
                    }}
                  />

                  {fbError && (
                    <div className="error-banner" style={{ marginBottom: 12 }}>{fbError}</div>
                  )}

                  <button
                    className="accent-btn"
                    style={{ width: '100%', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}
                    onClick={handleFeedbackSubmit}
                    disabled={fbLoading}
                  >
                    <Flag size={16} />
                    {fbLoading ? 'שולח...' : 'שלח'}
                  </button>

                  <button
                    className="ghost-btn"
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}
                    onClick={() => setModalView('menu')}
                    disabled={fbLoading}
                  >
                    ביטול
                  </button>
                </>
              )}

              {/* ── Feedback done view ── */}
              {modalView === 'feedbackDone' && (
                <div style={{ textAlign: 'center', padding: '20px 0' }}>
                  <p style={{ fontSize: 18, marginBottom: 8, fontFamily: 'var(--font-display)', color: 'var(--safe)' }}>
                    תודה על הדיווח!
                  </p>
                  <p style={{ fontSize: 13, color: 'var(--text-2)', fontFamily: 'var(--font-body)' }}>
                    המשוב נשלח בהצלחה.
                  </p>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

// ── Inline style constants ────────────────────────────

const statTileStyle = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
  padding: '12px 4px',
  background: 'var(--glass-bg)',
  border: '1px solid var(--glass-border)',
  borderRadius: 'var(--r-sm)',
};

const statValueStyle = {
  fontSize: 18,
  fontWeight: 700,
  fontFamily: 'var(--font-display)',
  color: 'var(--text)',
  display: 'flex',
  alignItems: 'center',
};

const statLabelStyle = {
  fontSize: 11,
  color: 'var(--text-3)',
  fontFamily: 'var(--font-body)',
  textAlign: 'center',
};

export default History;