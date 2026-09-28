// Helpers for event-local 'YYYY-MM-DD HH:MM:SS' strings (see db.js: dateStrings).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parts(dt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(dt));
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  return { y, mo, d, h, mi };
}

export function time(dt) {
  const p = parts(dt);
  if (!p) return '';
  const h12 = p.h % 12 || 12;
  return `${h12}:${String(p.mi).padStart(2, '0')} ${p.h < 12 ? 'AM' : 'PM'}`;
}

export function timeRange(start, end) {
  return `${time(start)} – ${time(end)}`;
}

export function dayLabel(dt) {
  const p = parts(dt);
  if (!p) return '';
  const wd = DAYS[new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay()];
  return `${wd} ${p.d} ${MONTHS[p.mo - 1]}`;
}

export function shortDate(dt) {
  const p = parts(dt);
  return p ? `${p.d} ${MONTHS[p.mo - 1]}` : '';
}

export function dateTime(dt) {
  return dt ? `${dayLabel(dt)}, ${time(dt)}` : '';
}

/** '10 Oct 9:00 AM – 11 Oct 9:00 AM' style range for the whole event. */
export function eventRange(event) {
  return `${shortDate(event.start_at)}, ${time(event.start_at)} – ${shortDate(event.end_at)}, ${time(event.end_at)}`;
}

export function fullName(p) {
  return [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');
}

export function displayName(p) {
  return p.preferred_name?.trim() || [p.first_name, p.last_name].filter(Boolean).join(' ');
}

export function ageOn(dob, onDate) {
  const a = parts(`${dob} 00:00`);
  const b = parts(onDate);
  if (!a || !b) return null;
  let age = b.y - a.y;
  if (b.mo < a.mo || (b.mo === a.mo && b.d < a.d)) age--;
  return age;
}

/** Local 'YYYY-MM-DD HH:MM:SS' for "now" at the given UTC offset such as '+05:30'. */
export function nowLocal(offset = '+05:30') {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  const mins = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(Date.now() + mins * 60000).toISOString().slice(0, 19).replace('T', ' ');
}

/** Adds minutes to a local 'YYYY-MM-DD HH:MM:SS' string, rolling over midnight correctly. */
export function shiftLocal(dt, minutes) {
  const iso = `${String(dt).slice(0, 19).replace(' ', 'T')}Z`;
  return new Date(Date.parse(iso) + minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
}

/** Icon name for an activity card, chosen from words in the activity name. */
export function activityIcon(name = '') {
  const n = name.toLowerCase();
  if (/music|band/.test(n)) return 'music';
  if (/adoration|qurbana|mass/.test(n)) return 'sun';
  if (/vigil|night/.test(n)) return 'moon';
  if (/rosary/.test(n)) return 'rosary';
  if (/vr|virtual/.test(n)) return 'vr';
  if (/theatre|theater|drama|carlo|miracle/.test(n)) return 'theatre';
  if (/blood|donat/.test(n)) return 'heart';
  if (/bishop|meet/.test(n)) return 'users';
  if (/confession|joy|garden/.test(n)) return 'heart';
  if (/selfie|photo/.test(n)) return 'camera';
  if (/registration|reception/.test(n)) return 'file';
  return 'sparkle';
}
