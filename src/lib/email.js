import { dailyInsights, loadDataset } from './analytics.js';

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
    <div style="font:700 17px/1.3 Arial,sans-serif;color:#ffffff">🍳 ${escapeHtml(propertyName)}</div>
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
      return;
    }
    if (!env.RESEND_API_KEY) {
      await log('failed', 'RESEND_API_KEY is not set on the Worker');
      return;
    }

    const from = settings.email_from?.trim();
    if (!from) {
      await log('failed', 'No "from" address configured in Notifications');
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
  }
}
