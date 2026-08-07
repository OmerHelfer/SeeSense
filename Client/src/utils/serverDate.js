
const HAS_TZ = /([zZ])$|[+-]\d{2}:?\d{2}$/;

export function parseServerDate(iso) {
  if (!iso) return null;
  const s = typeof iso === 'string' ? iso : String(iso);
  return new Date(HAS_TZ.test(s) ? s : s + 'Z');
}

export function formatServerDateTime(iso) {
  const d = parseServerDate(iso);
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

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
