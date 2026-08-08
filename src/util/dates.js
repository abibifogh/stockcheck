// Date helpers. Days are plain 'YYYY-MM-DD' strings in the property's local
// timezone. We parse them at UTC noon so that ±12h shifts never roll the date.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function isDay(value) {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && toDay(d) === value;
}

export function isMonth(value) {
  return typeof value === 'string' && MONTH_RE.test(value);
}

function toDay(date) {
  return date.toISOString().slice(0, 10);
}

function parse(day) {
  return new Date(`${day}T12:00:00Z`);
}

/** Current date in the given IANA timezone, as 'YYYY-MM-DD'. */
export function todayIn(timezone = 'UTC') {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return toDay(new Date());
  }
}

export function addDays(day, n) {
  const d = parse(day);
  d.setUTCDate(d.getUTCDate() + n);
  return toDay(d);
}

export function diffDays(from, to) {
  return Math.round((parse(to) - parse(from)) / 86400000);
}

/** Inclusive list of days from `from` to `to`. */
export function rangeDays(from, to) {
  const out = [];
  const total = diffDays(from, to);
  for (let i = 0; i <= total; i++) out.push(addDays(from, i));
  return out;
}

/** Monday-based day-of-week index: Mon=0 … Sun=6. */
export function dow(day) {
  return (parse(day).getUTCDay() + 6) % 7;
}

/** Monday of the week containing `day`. */
export function startOfWeek(day) {
  return addDays(day, -dow(day));
}

export function monthOf(day) {
  return day.slice(0, 7);
}

export function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const from = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from, to: `${month}-${String(last).padStart(2, '0')}` };
}

export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
