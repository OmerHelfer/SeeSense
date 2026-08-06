import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, AlertTriangle, MapPin, Users, Clock, ExternalLink, Phone, Mail } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { getEmergencyAlerts } from '../services/userService';

const pageVariants = {
  hidden:  { opacity: 0, x: 40 },
  visible: { opacity: 1, x: 0,  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, x: 40, transition: { duration: 0.22, ease: 'easeIn' } },
};

const formatDate = (iso) => {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('he-IL', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (e) {
    return iso || '—';
  }
};

const formatCoord = (val) => {
  if (val === 0 || val === null || val === undefined) return null;
  return val.toFixed(5);
};

const SOSHistory = () => {
  const navigate = useNavigate();
  const [alerts, setAlerts]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await getEmergencyAlerts();
        if (!cancelled) setAlerts(Array.isArray(list) ? list : []);
      } catch (err) {
        console.warn('[SOSHistory] Failed to load alerts:', err?.message);
        if (!cancelled) setError('לא ניתן לטעון היסטוריית קריאות חירום.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  return (
    <motion.div
      className="inner-page"
      variants={pageVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <header className="inner-page-header">
        <button className="back-btn" onClick={() => navigate('/settings')} aria-label="חזרה">
          <ArrowRight size={22} />
        </button>
        <span className="inner-page-title">קריאות חירום</span>
        <div style={{ width: 46 }} />
      </header>

      <div className="inner-page-body">

        {/* Info banner */}
        <div className="glass-section info-section">
          <div className="section-label-row">
            <AlertTriangle size={15} />
            <span className="section-label">היסטוריית SOS</span>
          </div>
          <p className="info-text">
            כל קריאות החירום שנשלחו מהמכשיר שלך, כולל מיקום GPS ואנשי הקשר שקיבלו התראה.
          </p>
        </div>

        {/* Loading */}
        {loading && (
          <div className="settings-loading">
            <div className="settings-loading-dot" />
            <span>טוען קריאות חירום...</span>
          </div>
        )}

        {/* Error */}
        {!loading && error && <div className="error-banner">{error}</div>}

        {/* Empty state */}
        {!loading && !error && alerts.length === 0 && (
          <div className="empty-state">
            <AlertTriangle size={38} strokeWidth={1.5} />
            <p>אין קריאות חירום</p>
            <span>לא נשלחו קריאות SOS עד כה</span>
          </div>
        )}

        {/* Alert list */}
        {!loading && !error && alerts.length > 0 && (
          <div className="contact-list">
            <AnimatePresence>
              {alerts.map((alert, idx) => {
                const key = alert.alert_id || `sos-${idx}`;
                const isOpen = expanded === key;
                const contactCount = alert.notified_contacts?.length ?? 0;
                const hasRealGps = alert.gps && (alert.gps.lat !== 0 || alert.gps.lon !== 0);

                return (
                  <motion.div
                    key={key}
                    className="sos-history-card"
                    layout
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: 40 }}
                    transition={{ duration: 0.22 }}
                    onClick={() => setExpanded(isOpen ? null : key)}
                  >
                    {/* ── Card header ── */}
                    <div className="sos-card-header">
                      <div className="sos-card-icon">
                        <AlertTriangle size={18} />
                      </div>
                      <div className="sos-card-info">
                        <div className="sos-card-date">
                          <Clock size={13} />
                          <span>{formatDate(alert.timestamp)}</span>
                        </div>
                        <div className="sos-card-contacts-count">
                          <Users size={13} />
                          <span>
                            {contactCount} {contactCount === 1 ? 'איש קשר קיבל' : 'אנשי קשר קיבלו'} התראה
                          </span>
                        </div>
                      </div>
                      <ArrowRight
                        size={16}
                        className="nav-row-arrow"
                        style={{
                          transform: isOpen ? 'rotate(-90deg)' : 'rotate(0deg)',
                          transition: 'transform 0.2s ease',
                        }}
                      />
                    </div>

                    {/* ── Expandable details ── */}
                    <AnimatePresence>
                      {isOpen && (
                        <motion.div
                          className="sos-card-details"
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.2 }}
                        >
                          {/* ── Location section ── */}
                          <div className="sos-detail-section">
                            <div className="sos-detail-section-title">מיקום</div>
                            <div className="sos-detail-row">
                              <MapPin size={14} />
                              {hasRealGps ? (
                                <>
                                  <span>{formatCoord(alert.gps.lat)}, {formatCoord(alert.gps.lon)}</span>
                                  {alert.google_maps_link && (
                                    <a
                                      href={alert.google_maps_link}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="sos-map-link"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      פתח במפות <ExternalLink size={12} />
                                    </a>
                                  )}
                                </>
                              ) : (
                                <span style={{ color: 'var(--text-3)' }}>מיקום לא זמין (GPS כבוי)</span>
                              )}
                            </div>
                          </div>

                          {/* ── Contacts section ── */}
                          {contactCount > 0 && (
                            <div className="sos-detail-section">
                              <div className="sos-detail-section-title">אנשי קשר שקיבלו התראה</div>
                              <div className="sos-contacts-list">
                                {alert.notified_contacts.map((c, i) => (
                                  <div key={i} className="sos-contact-chip">
                                    <span className="sos-contact-name">{c.name}</span>
                                    <div className="sos-contact-details">
                                      <span className="sos-contact-email">
                                        <Mail size={11} /> {c.email}
                                      </span>
                                      {c.phone && (
                                        <span className="sos-contact-phone">
                                          <Phone size={11} /> {c.phone}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}

        <div style={{ height: 40 }} />
      </div>
    </motion.div>
  );
};

export default SOSHistory;