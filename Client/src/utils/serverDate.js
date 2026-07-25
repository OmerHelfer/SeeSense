/**
 * serverDate — parse timestamps coming from the backend correctly.
 *
 * The server writes timestamps with `datetime.now().isoformat()`, which on the
 * (UTC) Railway host produces a UTC value but WITHOUT any timezone marker, e.g.
 * "2026-07-25T11:30:00.123456". Browsers parse a marker-less ISO string as LOCAL
 * time, so every relative time ("seen X ago") is off by the viewer's UTC offset
 * (e.g. a just-now event shows as "3h ago" in Israel, which is UTC+3 in summer).
 *
 * Fix: if the string carries no timezone designator, treat it as UTC by appending
 * 'Z'. Strings that already have a 'Z' or a ±HH:MM offset are left untouched.
 */

const HAS_TZ = /([zZ])$|[+-]\d{2}:?\d{2}$/;

/** Parse a backend timestamp → Date (marker-less strings are treated as UTC). Null-safe. */
export function parseServerDate(iso) {
  if (!iso) return null;
  const s = typeof iso === 'string' ? iso : String(iso);
  return new Date(HAS_TZ.test(s) ? s : s + 'Z');
}

/**
 * Format a backend timestamp as Israel local time (Asia/Jerusalem), with minutes —
 * e.g. "25 ביולי, 14:30". Pinned to Israel's timezone so it reads the same for every
 * viewer regardless of their device's timezone.
 */
export function formatServerDateTime(iso) {
  const d = parseServerDate(iso);
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Hebrew relative time ("הרגע" / "לפני N דק׳ / שע׳ / ימים / חודשים / שנים"). */
export function relTime(iso) {
  const d = parseServerDate(iso);
  if (!d || Number.isNaN(d.getTime())) return 'לא ידוע';
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'הרגע';
  if (m < 60) return `לפני ${m} דק׳`;
  const h = Math.floor(m / 60);
  if (h < 24) return `לפני ${h} שע׳`;
  const dd = Math.floor(h / 24);
  if (dd < 30) return `לפני ${dd} ימים`;
  const mo = Math.floor(dd / 30);
  if (mo < 12) return `לפני ${mo} חודשים`;
  return `לפני ${Math.floor(mo / 12)} שנים`;
}
