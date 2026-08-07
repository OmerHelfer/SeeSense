
const NOTICE_KEY = 'seesense_session_expired';

let handler = null;
let alreadyFiring = false;

export function setSessionExpiredHandler(fn) {
  handler = fn;
  return () => { if (handler === fn) handler = null; };
}

export function notifySessionExpired() {
  if (alreadyFiring || !handler) return;
  alreadyFiring = true;
  try {
    sessionStorage.setItem(NOTICE_KEY, '1');
  } catch {  }
  try {
    handler();
  } finally {
    setTimeout(() => { alreadyFiring = false; }, 1000);
  }
}

export function consumeSessionExpiredNotice() {
  try {
    if (sessionStorage.getItem(NOTICE_KEY)) {
      sessionStorage.removeItem(NOTICE_KEY);
      return true;
    }
  } catch {  }
  return false;
}