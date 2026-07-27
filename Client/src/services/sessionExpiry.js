/**
 * sessionExpiry — bridge between the Axios interceptor (plain JS, outside React)
 * and AuthContext (React state).
 *
 * When the server rejects a request with 401 the JWT is dead (expired after
 * JWT_EXPIRATION_HOURS, revoked by logout, or signed with a different key). The
 * interceptor can't call a React hook, so it calls notifySessionExpired() here and
 * AuthContext — which registered itself on mount — performs the actual logout.
 * ProtectedRoute then redirects to /login on its own, because isAuthenticated
 * flips to false.
 */

const NOTICE_KEY = 'seesense_session_expired';

let handler = null;
let alreadyFiring = false;   // a dead token 401s every in-flight request at once

/** AuthContext registers the logout routine here (returns an unsubscribe fn). */
export function setSessionExpiredHandler(fn) {
  handler = fn;
  return () => { if (handler === fn) handler = null; };
}

/**
 * Called by the 401 interceptor. Runs the handler exactly once per dead session —
 * a whole burst of parallel 401s must not trigger a burst of logouts.
 */
export function notifySessionExpired() {
  if (alreadyFiring || !handler) return;
  alreadyFiring = true;
  try {
    sessionStorage.setItem(NOTICE_KEY, '1');   // so /login can explain why
  } catch { /* private mode — the notice is optional */ }
  try {
    handler();
  } finally {
    // Re-arm only after the teardown settles, so late 401s from the same dead
    // session are still swallowed.
    setTimeout(() => { alreadyFiring = false; }, 1000);
  }
}

/** Read + clear the "your session expired" notice (for the Login page). */
export function consumeSessionExpiredNotice() {
  try {
    if (sessionStorage.getItem(NOTICE_KEY)) {
      sessionStorage.removeItem(NOTICE_KEY);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}