import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, AlertTriangle, MapPin, Users, Clock, ExternalLink } from 'lucide-react';
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
  } catch { return iso; }
};

const SOSHistory = () => {
  const navigate = useNavigate();
  const [alerts, setAlerts]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [expanded, setExpanded] = useState(null); // alert_id of expanded card

  useEffect(() => {
    getEmergencyAlerts()
      .then((list) => setAlerts(list))
      .catch(() => setError('לא ניתן לטעון היסטוריית קריאות חירום.'))
      .finally(() => setLoading(false));
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
        <div className="contact-list">
          <AnimatePresence>
            {alerts.map((alert) => {
              const isOpen = expanded === alert.alert_id;
              return (
                <motion.div
                  key={alert.alert_id}
                  className="sos-history-card"
                  layout
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: 40 }}
                  transition={{ duration: 0.22 }}
                  onClick={() => setExpanded(isOpen ? null : alert.alert_id)}
                >
                  {/* Card header row */}
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
                        <span>{alert.notified_contacts?.length ?? 0} אנשי קשר קיבלו התראה</span>
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

                  {/* Expandable details */}
                  <AnimatePresence>
                    {isOpen && (
                      <motion.div
                        className="sos-card-details"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        {/* GPS */}
                        <div className="sos-detail-row">
                          <MapPin size={14} />
                          <span>מיקום:</span>
                          <a
                            href={alert.google_maps_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="sos-map-link"
                            onClick={(e) => e.stopPropagation()}
                          >
                            פתח במפות <ExternalLink size={12} />
                          </a>
                        </div>

                        {/* GPS coords */}
                        <div className="sos-detail-row sub">
                          <span>
                            {alert.gps?.lat?.toFixed(5)}, {alert.gps?.lon?.toFixed(5)}
                          </span>
                        </div>

                        {/* Contacts notified */}
                        <div className="sos-contacts-list">
                          {(alert.notified_contacts ?? []).map((c, i) => (
                            <div key={i} className="sos-contact-chip">
                              <span className="sos-contact-name">{c.name}</span>
                              <span className="sos-contact-email">{c.email}</span>
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>

        <div style={{ height: 40 }} />
      </div>
    </motion.div>
  );
};

export default SOSHistory;