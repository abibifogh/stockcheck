import { dailyInsights, loadDataset } from './analytics.js';
import {
  dayOverview, dayReport, loadDataset as loadHousekeeping, periodReport, slotOf,
} from './housekeeping.js';
import { addDays } from '../util/dates.js';
import { createNotice } from './notices.js';

/**
 * Notification email for a submitted day sheet.
 *
 * Sent through Resend's HTTP API — Workers cannot open SMTP connections, and
 * Resend verifies against a domain you already control. The API key lives in a
 * Worker secret; who receives the mail is a setting the admin edits in the app.
 *
 * Sending is always fired through `waitUntil` so that a mail outage can never
 * slow down, or fail, a cook pressing Submit.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function parseRecipients(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter(isEmail);
  } catch {
    // Fall through: a plain comma-separated list is a reasonable thing for
    // someone to have typed, so accept it rather than silently sending nothing.
  }
  return String(value).split(/[,;\s]+/).map((s) => s.trim()).filter(isEmail);
}

export function isEmail(value) {
  return typeof value === 'string' && /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value.trim());
}

function money(currency, value) {
  if (value == null) return '—';
  return `${currency} ${Number(value).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
}

function num(value, places = 0) {
  if (value == null) return '—';
  return Number(value).toLocaleString('en-GB', { maximumFractionDigits: places });
}

function arrow(pct) {
  if (pct == null) return '';
  if (Math.abs(pct) < 0.05) return ' (no change)';
  return ` (${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%)`;
}

const ALERT_COLOUR = { high: '#c62f42', warn: '#b96a06', info: '#2f6df6' };

/**
 * The email body. Deliberately plain HTML with inline styles and a light
 * background: mail clients strip stylesheets, ignore CSS variables and vary
 * wildly on dark mode.
 */
export function renderDailyEmail({ insight, propertyName, siteUrl, submittedBy }) {
  const t = insight.today;
  const currency = insight.currency;
  const cmp = insight.comparisons;

  const dateLabel = new Date(`${insight.day}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  const stat = (label, value, sub = '') => `
    <td style="padding:10px 14px;background:#f6f7f9;border-radius:10px;vertical-align:top">
      <div style="font:600 11px/1.4 Arial,sans-serif;color:#5b6472;text-transform:uppercase;letter-spacing:.06em">${label}</div>
      <div style="font:700 20px/1.3 Arial,sans-serif;color:#14181f;margin-top:2px">${value}</div>
      ${sub ? `<div style="font:400 12px/1.4 Arial,sans-serif;color:#5b6472">${sub}</div>` : ''}
    </td>`;

  const alerts = insight.alerts.slice(0, 8).map((a) => `
    <tr><td style="padding:8px 12px;border-left:3px solid ${ALERT_COLOUR[a.level] || '#2f6df6'};background:#fafbfc">
      <div style="font:700 13px/1.4 Arial,sans-serif;color:#14181f">${escapeHtml(a.title)}</div>
      <div style="font:400 12px/1.5 Arial,sans-serif;color:#5b6472">${escapeHtml(a.detail || '')}</div>
    </td></tr>`).join('<tr><td style="height:6px"></td></tr>');

  const topRows = insight.topCosts.slice(0, 6).map((line) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #e6e9ee;font:400 13px Arial,sans-serif;color:#14181f">${escapeHtml(line.name)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e6e9ee;font:400 13px Arial,sans-serif;color:#5b6472;text-align:right">${num(line.qty, 2)} ${escapeHtml(line.unit)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e6e9ee;font:600 13px Arial,sans-serif;color:#14181f;text-align:right">${money(currency, line.cost)}</td>
    </tr>`).join('');

  const missing = insight.completeness.missing;

  return `
<div style="margin:0;padding:24px 12px;background:#eef1f5">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden">
  <tr><td style="padding:20px 24px;background:#14181f">
    <div style="font:700 17px/1.3 Arial,sans-serif;color:#ffffff">📦 ${escapeHtml(propertyName)}</div>
    <div style="font:400 13px/1.4 Arial,sans-serif;color:#9aa5b5">Breakfast recorded — ${dateLabel}</div>
  </td></tr>

  <tr><td style="padding:18px 24px 4px">
    <table role="presentation" cellpadding="0" cellspacing="6" width="100%"><tr>
      ${stat('Guests', num(t.guests), `${num(t.inhouse)} in-house · ${num(t.outside)} outside`)}
      ${stat('Food cost', money(currency, t.cost), `vs ${money(currency, cmp.last7.cost)} typical${arrow(cmp.last7.costDeltaPct)}`)}
    </tr><tr>
      ${stat('Cost per guest', money(currency, t.costPerGuest), `7-day avg ${money(currency, cmp.last7.costPerGuest)}${arrow(cmp.last7.costPerGuestDeltaPct)}`)}
      ${stat('Outsider income', money(currency, t.revenue), t.outside ? `${num(t.outside)} × ${money(currency, t.outsiderFee)}` : 'no outside guests')}
    </tr></table>
  </td></tr>

  ${insight.alerts.length ? `
  <tr><td style="padding:16px 24px 0">
    <div style="font:700 14px Arial,sans-serif;color:#14181f;margin-bottom:8px">What stands out</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${alerts}</table>
  </td></tr>` : `
  <tr><td style="padding:16px 24px 0">
    <div style="padding:10px 12px;background:#e2f5ec;border-radius:8px;font:400 13px Arial,sans-serif;color:#12855b">
      Everything is within its normal range for this headcount.
    </div>
  </td></tr>`}

  <tr><td style="padding:18px 24px 0">
    <div style="font:700 14px Arial,sans-serif;color:#14181f;margin-bottom:6px">Biggest costs today</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${topRows}</table>
  </td></tr>

  <tr><td style="padding:16px 24px 0">
    <div style="font:400 13px/1.6 Arial,sans-serif;color:#5b6472">
      <strong style="color:#14181f">Against a typical ${insight.weekday}:</strong>
      ${num(cmp.sameWeekday.guests, 1)} guests, ${money(currency, cmp.sameWeekday.costPerGuest)} per guest${arrow(cmp.sameWeekday.costPerGuestDeltaPct)}.<br>
      <strong style="color:#14181f">Sheet completeness:</strong> ${insight.completeness.score}%
      (${insight.completeness.recorded} of ${insight.completeness.expected} usual items)${missing.length ? ` — not recorded: ${missing.slice(0, 8).map((m) => escapeHtml(m.name)).join(', ')}` : ''}.<br>
      ${submittedBy ? `<strong style="color:#14181f">Submitted by:</strong> ${escapeHtml(submittedBy)}.` : ''}
      ${t.note ? `<br><strong style="color:#14181f">Note:</strong> ${escapeHtml(t.note)}` : ''}
    </div>
  </td></tr>

  ${siteUrl ? `
  <tr><td style="padding:20px 24px">
    <a href="${escapeAttr(siteUrl)}/#/daily?day=${insight.day}"
       style="display:inline-block;padding:10px 18px;background:#2f6df6;color:#ffffff;border-radius:8px;font:600 14px Arial,sans-serif;text-decoration:none">
      Open the full day report
    </a>
  </td></tr>` : '<tr><td style="height:20px"></td></tr>'}

  <tr><td style="padding:14px 24px;background:#f6f7f9;font:400 11px/1.5 Arial,sans-serif;color:#8b95a5">
    Sent automatically when the kitchen submitted this day.
    An administrator can change who receives these under Users &amp; data → Notifications.
  </td></tr>
</table>
</div>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

export async function sendEmail({ apiKey, from, to, subject, html }) {
  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Mail provider returned ${response.status}: ${text.slice(0, 300)}`);
  }
  return text;
}

/**
 * Build and send the notification for one day, recording the outcome either
 * way. Never throws — the caller is a background task and a failed email must
 * not surface as a failed save.
 */
export async function notifyDaySubmitted(db, env, { day, submittedBy, resubmission }) {
  const log = (status, detail, recipients = []) => db.prepare(
    'INSERT INTO email_log (kind, day, recipients, status, detail) VALUES (?, ?, ?, ?, ?)',
  ).bind('day_submitted', day, recipients.join(', '), status, detail ? String(detail).slice(0, 500) : null)
    .run()
    .catch(() => {});

  try {
    const settingsRows = await db.prepare('SELECT key, value FROM settings').all();
    const settings = Object.fromEntries((settingsRows.results ?? []).map((r) => [r.key, r.value]));

    if (settings.notify_on_submit !== '1') return;

    const recipients = parseRecipients(settings.notify_recipients);
    if (!recipients.length) {
      await log('skipped', 'No recipients configured');
      await failed('nobody is on the recipient list.');
      return;
    }
    if (!env.RESEND_API_KEY) {
      await log('failed', 'RESEND_API_KEY is not set on the Worker');
      await failed('this site has no sending key set.');
      return;
    }

    const from = settings.email_from?.trim();
    if (!from) {
      await log('failed', 'No "from" address configured in Notifications');
      await failed('no "from" address has been set.');
      return;
    }

    const ds = await loadDataset(db);
    const insight = dailyInsights(ds, day);

    const propertyName = settings.property_name || 'Breakfast Unit';
    const flagCount = insight.alerts.filter((a) => a.level === 'high').length;
    const subject = `${propertyName} — ${insight.weekday} ${day}: ${insight.today.guests} guests, `
      + `${insight.currency} ${Number(insight.today.costPerGuest ?? 0).toFixed(2)}/guest`
      + (flagCount ? ` · ${flagCount} to review` : '')
      + (resubmission ? ' (updated)' : '');

    const html = renderDailyEmail({
      insight,
      propertyName,
      siteUrl: settings.site_url?.trim() || '',
      submittedBy,
    });

    await sendEmail({ apiKey: env.RESEND_API_KEY, from, to: recipients, subject, html });
    await log('sent', null, recipients);
  } catch (err) {
    await log('failed', err?.message || String(err));
    await failed(`${err?.message || String(err)}`.slice(0, 200));
  }
}

// ---------------------------------------------------------------------------
// The dorm bed check
// ---------------------------------------------------------------------------

/**
 * The round email.
 *
 * Written as a findings list rather than a status report. The reader is a
 * manager on a phone who wants one thing from it: which beds to go and look at
 * before lunch. So the untagged beds come first, in full, with their room and
 * bed name — not a count, because a count cannot be acted on — and everything
 * else is arranged underneath it.
 */
export function renderRoundEmail({ report, day: dayView, trend, propertyName, siteUrl, submittedBy }) {
  const t = report.totals;
  const slot = slotOf(report.slot ?? 'morning');

  const dateLabel = new Date(`${report.day}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  const stat = (label, value, sub = '', colour = '#14181f') => `
    <td style="padding:10px 14px;background:#f6f7f9;border-radius:10px;vertical-align:top">
      <div style="font:600 11px/1.4 Arial,sans-serif;color:#5b6472;text-transform:uppercase;letter-spacing:.06em">${label}</div>
      <div style="font:700 20px/1.3 Arial,sans-serif;color:${colour};margin-top:2px">${value}</div>
      ${sub ? `<div style="font:400 12px/1.4 Arial,sans-serif;color:#5b6472">${sub}</div>` : ''}
    </td>`;

  const findingRow = (finding, colour, what) => `
    <tr><td style="padding:8px 12px;border-left:3px solid ${colour};background:#fafbfc">
      <div style="font:700 13px/1.4 Arial,sans-serif;color:#14181f">
        ${escapeHtml(finding.room)} · ${escapeHtml(finding.bed)}
      </div>
      <div style="font:400 12px/1.5 Arial,sans-serif;color:#5b6472">
        ${what}${finding.note ? ` — “${escapeHtml(finding.note)}”` : ''}${finding.checkedBy ? ` · checked by ${escapeHtml(finding.checkedBy)}` : ''}
      </div>
    </td></tr>`;

  const untagged = report.findings.filter((f) => f.severity === 'untagged');
  const unexpected = report.findings.filter((f) => f.severity === 'unexpected');
  const emptyBooked = report.findings.filter((f) => f.severity === 'empty_booked');

  const section = (title, rows) => (rows.length ? `
  <tr><td style="padding:16px 24px 0">
    <div style="font:700 14px Arial,sans-serif;color:#14181f;margin-bottom:8px">${title}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      ${rows.join('<tr><td style="height:6px"></td></tr>')}
    </table>
  </td></tr>` : '');

  const gaps = t.unchecked
    ? `<tr><td style="padding:16px 24px 0">
         <div style="padding:10px 12px;background:#fdf1e0;border-radius:8px;font:400 13px Arial,sans-serif;color:#8a5a06">
           ${t.unchecked} of ${t.expected} beds were not answered for. The figures above cover only the
           ${t.checked} that were.
         </div>
       </td></tr>`
    : '';

  const roomRows = report.rooms
    .filter((room) => room.totals.issues > 0 || room.totals.checked < room.beds.length)
    .map((room) => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #e6e9ee;font:400 13px Arial,sans-serif;color:#14181f">${escapeHtml(room.name)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e6e9ee;font:400 13px Arial,sans-serif;color:#5b6472;text-align:right">${room.totals.checked}/${room.beds.length} checked</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e6e9ee;font:600 13px Arial,sans-serif;color:${room.totals.issues ? '#c62f42' : '#12855b'};text-align:right">
          ${room.totals.issues ? `${room.totals.issues} to look at` : 'clear'}
        </td>
      </tr>`).join('');

  return `
<div style="margin:0;padding:24px 12px;background:#eef1f5">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden">
  <tr><td style="padding:20px 24px;background:#14181f">
    <div style="font:700 17px/1.3 Arial,sans-serif;color:#ffffff">🛏 ${escapeHtml(propertyName)}</div>
    <div style="font:400 13px/1.4 Arial,sans-serif;color:#9aa5b5">${escapeHtml(slot.label)} — ${dateLabel}</div>
  </td></tr>

  <tr><td style="padding:18px 24px 4px">
    <table role="presentation" cellpadding="0" cellspacing="6" width="100%"><tr>
      ${stat('No name tag', num(t.untagged), t.untagged ? 'occupied, nothing says who' : 'every occupied bed labelled', t.untagged ? '#c62f42' : '#12855b')}
      ${stat('Unexpected', num(t.unexpected), 'occupied, rostered free', t.unexpected ? '#c62f42' : '#14181f')}
    </tr><tr>
      ${stat('Beds checked', `${num(t.checked)}${t.expected ? ` / ${num(t.expected)}` : ''}`, t.coverage == null ? '' : `${t.coverage}% of the property`)}
      ${stat('Occupied', num(t.occupied), t.tagRate == null ? 'nothing occupied' : `${t.tagRate}% carried a tag`)}
    </tr></table>
  </td></tr>

  ${gaps}

  ${section('Occupied with no name tag', untagged.map((f) => findingRow(f, '#c62f42', 'Occupied, no name tag')))}
  ${section('Occupied but rostered free', unexpected.map((f) => findingRow(f, '#b96a06', `Found occupied${f.expectedNote ? ` — the roster expected ${escapeHtml(f.expectedNote)}` : ', the roster says this bed is free'}`)))}
  ${section('Booked but found empty', emptyBooked.map((f) => findingRow(f, '#2f6df6', `Empty${f.expectedNote ? ` — ${escapeHtml(f.expectedNote)} was expected` : ', though the roster has it occupied'}`)))}

  ${!report.findings.length ? `
  <tr><td style="padding:16px 24px 0">
    <div style="padding:10px 12px;background:#e2f5ec;border-radius:8px;font:400 13px Arial,sans-serif;color:#12855b">
      Every bed checked was as it should be — occupied beds labelled, free beds empty.
    </div>
  </td></tr>` : ''}

  ${roomRows ? `
  <tr><td style="padding:18px 24px 0">
    <div style="font:700 14px Arial,sans-serif;color:#14181f;margin-bottom:6px">Rooms wanting attention</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${roomRows}</table>
  </td></tr>` : ''}

  ${report.notes.length ? `
  <tr><td style="padding:18px 24px 0">
    <div style="font:700 14px Arial,sans-serif;color:#14181f;margin-bottom:6px">What housekeeping wrote down</div>
    <div style="font:400 13px/1.6 Arial,sans-serif;color:#5b6472">
      ${report.notes.slice(0, 12).map((n) => `<strong style="color:#14181f">${escapeHtml(n.room)} · ${escapeHtml(n.bed)}:</strong> ${escapeHtml(n.note)}`).join('<br>')}
    </div>
  </td></tr>` : ''}

  ${dayView ? `
  <tr><td style="padding:18px 24px 0">
    <div style="font:700 14px Arial,sans-serif;color:#14181f;margin-bottom:6px">The day so far</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      ${dayView.rounds.map((r) => `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #e6e9ee;font:${r.slot === report.slot ? 700 : 400} 13px Arial,sans-serif;color:#14181f">
            ${escapeHtml(r.label)}<span style="color:#8b95a5"> · ${escapeHtml(r.by)}</span>
          </td>
          <td style="padding:6px 8px;border-bottom:1px solid #e6e9ee;font:400 13px Arial,sans-serif;color:#5b6472;text-align:right">
            ${r.submitted ? `${r.totals.checked} beds` : r.started ? `${r.totals.checked} beds, not submitted` : 'not done yet'}
          </td>
          <td style="padding:6px 8px;border-bottom:1px solid #e6e9ee;font:600 13px Arial,sans-serif;text-align:right;color:${r.totals.untagged ? '#c62f42' : '#12855b'}">
            ${r.started ? (r.totals.untagged ? `${r.totals.untagged} untagged` : 'clear') : '—'}
          </td>
        </tr>`).join('')}
    </table>
    <div style="margin-top:10px;padding:10px 12px;border-radius:8px;background:${dayView.outstanding.length ? '#fdeaec' : '#e2f5ec'};font:400 13px Arial,sans-serif;color:${dayView.outstanding.length ? '#c62f42' : '#12855b'}">
      ${dayView.outstanding.length
        ? `<strong>${dayView.outstanding.length} ${dayView.outstanding.length === 1 ? 'bed is' : 'beds are'} still wrong</strong> after the last check to look at ${dayView.outstanding.length === 1 ? 'it' : 'them'}: `
          + dayView.outstanding.slice(0, 8).map((o) => `${escapeHtml(o.room)} ${escapeHtml(o.bed)}`).join(', ')
        : `Nothing is outstanding${dayView.resolution.fixed ? ` — ${dayView.resolution.fixed} ${dayView.resolution.fixed === 1 ? 'finding was' : 'findings were'} put right during the day` : ''}.`}
    </div>
  </td></tr>` : ''}

  <tr><td style="padding:16px 24px 0">
    <div style="font:400 13px/1.6 Arial,sans-serif;color:#5b6472">
      <strong style="color:#14181f">Against the last 30 days:</strong>
      ${num(trend.untagged)} untagged and ${num(trend.unexpected)} unexpected in total,
      ${trend.tagRate == null ? 'with nothing occupied' : `${trend.tagRate}% of occupied beds labelled`}.<br>
      <strong style="color:#14181f">Walked by:</strong>
      ${report.people.length ? report.people.map((p) => `${escapeHtml(p.name)} (${p.checks})`).join(', ') : '—'}.<br>
      ${submittedBy ? `<strong style="color:#14181f">Submitted by:</strong> ${escapeHtml(submittedBy)}.` : ''}
      ${report.round?.note ? `<br><strong style="color:#14181f">Note:</strong> ${escapeHtml(report.round.note)}` : ''}
    </div>
  </td></tr>

  ${siteUrl ? `
  <tr><td style="padding:20px 24px">
    <a href="${escapeAttr(siteUrl)}/#/hk-report?from=${report.day}&to=${report.day}"
       style="display:inline-block;padding:10px 18px;background:#2f6df6;color:#ffffff;border-radius:8px;font:600 14px Arial,sans-serif;text-decoration:none">
      Open the full check
    </a>
  </td></tr>` : '<tr><td style="height:20px"></td></tr>'}

  <tr><td style="padding:14px 24px;background:#f6f7f9;font:400 11px/1.5 Arial,sans-serif;color:#8b95a5">
    Sent automatically when the ${escapeHtml(slot.label.toLowerCase())} was submitted, by ${escapeHtml(slot.by.toLowerCase())}.
    An administrator can change who receives these under Users &amp; data → Notifications.
  </td></tr>
</table>
</div>`;
}

/**
 * Build and send the notification for one round, recording the outcome either
 * way. Never throws — the caller is a background task, and a mail provider
 * having a bad morning must not surface as a failed round.
 */
export async function notifyRoundSubmitted(db, env, { day, slot = 'morning', submittedBy, resubmission }) {
  const log = (status, detail, recipients = []) => db.prepare(
    'INSERT INTO email_log (kind, day, recipients, status, detail) VALUES (?, ?, ?, ?, ?)',
  ).bind('hk_round', day, recipients.join(', '), status, detail ? String(detail).slice(0, 500) : null)
    .run()
    .catch(() => {});

  /**
   * An email that does not go is the failure nobody notices: the round was
   * submitted, the screen said so, and the person who needed telling was not.
   * The log has always recorded it — on a page almost nobody opens. So it is
   * put on the bell as well, where somebody will actually meet it.
   */
  const failed = (why) => createNotice(db, {
    kind: 'hk_email_failed',
    level: 'warn',
    title: 'The bed check email could not be sent',
    body: `${slotOf(slot).label} for ${day} was recorded, but the email did not go out: ${why} `
      + 'The check itself is safe — this is only about the message.',
    link: '#/admin',
    day,
    slot,
  });

  try {
    const settingsRows = await db.prepare('SELECT key, value FROM settings').all();
    const settings = Object.fromEntries((settingsRows.results ?? []).map((r) => [r.key, r.value]));

    if (settings.hk_notify_on_submit === '0') return;

    // Its own list, falling back to the daily list. The two audiences overlap
    // in a small property and diverge in a large one; falling back means an
    // installation that never opened the housekeeping settings still gets its
    // findings somewhere rather than nowhere.
    const recipients = parseRecipients(settings.hk_notify_recipients).length
      ? parseRecipients(settings.hk_notify_recipients)
      : parseRecipients(settings.notify_recipients);

    if (!recipients.length) {
      await log('skipped', 'No recipients configured');
      await failed('nobody is on the recipient list.');
      return;
    }
    if (!env.RESEND_API_KEY) {
      await log('failed', 'RESEND_API_KEY is not set on the Worker');
      await failed('this site has no sending key set.');
      return;
    }

    const from = settings.email_from?.trim();
    if (!from) {
      await log('failed', 'No "from" address configured in Notifications');
      await failed('no "from" address has been set.');
      return;
    }

    const ds = await loadHousekeeping(db);
    const report = dayReport(ds, day, slot);
    const dayView = dayOverview(ds, day);
    const trend = periodReport(ds, addDays(day, -29), day).current;

    const propertyName = settings.property_name || 'Hostel';
    const t = report.totals;
    const subject = `${propertyName} — ${slotOf(slot).label.toLowerCase()} ${day}: `
      + (t.untagged ? `${t.untagged} without a name tag` : 'all occupied beds labelled')
      + (t.unexpected ? `, ${t.unexpected} unexpected` : '')
      + (t.unchecked ? ` · ${t.unchecked} beds not checked` : '')
      + (resubmission ? ' (updated)' : '');

    const html = renderRoundEmail({
      report,
      day: dayView,
      trend,
      propertyName,
      siteUrl: settings.site_url?.trim() || '',
      submittedBy,
    });

    await sendEmail({ apiKey: env.RESEND_API_KEY, from, to: recipients, subject, html });
    await log('sent', null, recipients);
  } catch (err) {
    await log('failed', err?.message || String(err));
    await failed(`${err?.message || String(err)}`.slice(0, 200));
  }
}
