import { fmtDay, h, todayISO } from '../util.js';

/** What a request's state is, as a pill — the same words on every screen. */
export function statusPill(r) {
  const [text, tone] = (() => {
    if (r.status === 'waiting') return ['Waiting', 'info'];
    if (r.status === 'approved') return ['Approved', 'info'];
    if (r.status === 'issued') return [r.short ? 'Partly issued — confirm' : 'Issued — confirm', 'warn'];
    if (r.status === 'received') {
      if (r.difference) return ['Difference reported', 'bad'];
      if (r.receivedAuto) return ['Not confirmed', 'warn'];
      return [r.short ? 'Received (part)' : 'Received', 'good'];
    }
    if (r.status === 'declined') return ['Declined', 'bad'];
    if (r.status === 'cancelled') return ['Cancelled', ''];
    return [r.status, ''];
  })();
  return h(`span.pill${tone ? `.${tone}` : ''}`, text);
}

/** "06:28" today, "Sun 06:10" this week, a date before that. */
export function timeOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = d.toISOString().slice(0, 10);
  if (day === todayISO()) return time;
  const days = (Date.now() - d.getTime()) / 86400000;
  if (days < 6) return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
  return `${fmtDay(day)} ${time}`;
}

/** "13 min", "1 h 05". */
export function minutes(n) {
  if (n == null) return '—';
  if (n < 60) return `${n} min`;
  return `${Math.floor(n / 60)} h ${String(n % 60).padStart(2, '0')}`;
}
