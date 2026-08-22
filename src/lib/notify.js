import { effectivePermissions } from './permissions.js';
import { parseRecipients, sendEmail } from './email.js';
import { createNotice } from './notices.js';

/**
 * Telling people things.
 *
 * Two channels, one call. The in-app half goes to the same bell the bed check
 * writes to — one bell, one table, one place to look. It lands whether or not
 * anybody has set up email, which matters because email needs an account, a
 * verified domain and a key, and until all three exist a system that only
 * emails is a system that tells nobody anything.
 *
 * What is added here on top of the bell is the audience. A bed check concerns
 * everybody on shift; a count waiting for approval concerns administrators,
 * and a housekeeper has no use for it.
 *
 * Nothing here throws. A notification is a courtesy on top of work that has
 * already succeeded; a failure to mention it must never undo the thing it was
 * mentioning.
 */

export async function readSettings(db) {
  try {
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

/** Who a broadcast reaches: everyone holding this permission. */
async function usersWith(db, permission) {
  const rows = await db.prepare('SELECT * FROM users WHERE active = 1').all();
  return (rows.results ?? []).filter((u) => effectivePermissions(u).includes(permission));
}

/**
 * Record something worth knowing.
 *
 * `audience` is a permission rather than a list of people, so a notification
 * addressed to administrators still reaches somebody promoted tomorrow, and
 * stops reaching somebody demoted yesterday.
 */
export async function notify(db, {
  kind, title, body = null, link = null, audience = null, level = 'info', actor = null,
}) {
  const settings = await readSettings(db);
  if (settings.notify_in_app === '0') return null;
  return createNotice(db, { kind, level, title, body, link, audience, actor });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A short, plain message. Inline styles only — mail clients strip the rest. */
function shell({ propertyName, title, body, link, linkLabel }) {
  return `
<div style="margin:0;padding:24px 12px;background:#eef1f5">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden">
  <tr><td style="padding:18px 22px;background:#14181f">
    <div style="font:700 16px/1.3 Arial,sans-serif;color:#ffffff">${escapeHtml(propertyName)}</div>
  </td></tr>
  <tr><td style="padding:20px 22px 4px">
    <div style="font:700 18px/1.35 Arial,sans-serif;color:#14181f">${escapeHtml(title)}</div>
    ${body ? `<div style="font:400 14px/1.6 Arial,sans-serif;color:#5b6472;margin-top:8px;white-space:pre-line">${escapeHtml(body)}</div>` : ''}
  </td></tr>
  ${link ? `<tr><td style="padding:18px 22px">
    <a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#2f6df6;color:#ffffff;border-radius:8px;font:600 14px Arial,sans-serif;text-decoration:none">${escapeHtml(linkLabel || 'Open the system')}</a>
  </td></tr>` : '<tr><td style="height:18px"></td></tr>'}
  <tr><td style="padding:14px 22px;background:#f6f7f9;font:400 11px/1.5 Arial,sans-serif;color:#8b95a5">
    Sent automatically. An administrator can change who receives these under Users &amp; data → Notifications.
  </td></tr>
</table>
</div>`;
}

/**
 * Send one message to everybody holding a permission.
 *
 * Falls silently back to doing nothing when email is not connected — which is
 * the normal state until somebody sets it up, and not an error worth throwing
 * at a cook pressing Submit.
 */
export async function emailAudience(db, env, {
  kind, audience, subject, title, body, link, linkLabel, alsoUserIds = [],
}) {
  const log = (status, detail, recipients = []) => db.prepare(
    'INSERT INTO email_log (kind, day, recipients, status, detail) VALUES (?, ?, ?, ?, ?)',
  ).bind(kind ?? 'notification', null, recipients.join(', '), status, detail ? String(detail).slice(0, 500) : null)
    .run()
    .catch(() => {});

  try {
    const settings = await readSettings(db);
    const from = settings.email_from?.trim();

    if (!env?.RESEND_API_KEY || !from) {
      // Not configured is not a failure, and logging it on every event would
      // bury the real failures under noise.
      return { sent: 0, reason: 'email not configured' };
    }

    // Everyone holding the permission, plus anyone named outright — somebody
    // asked to count is told whether or not they can open the stock screen.
    const named = new Set((alsoUserIds ?? []).map(Number).filter(Number.isFinite));
    const rows = await db.prepare('SELECT * FROM users WHERE active = 1').all();
    const people = (rows.results ?? []).filter(
      (u) => named.has(u.id) || effectivePermissions(u).includes(audience),
    );

    const addresses = [];
    for (const person of people) {
      const address = person.email?.trim();
      if (address && address.includes('@') && !addresses.includes(address)) addresses.push(address);
    }

    // Anybody explicitly listed for the daily email is presumed to want the
    // rest of it too — that list is "who watches this hotel".
    for (const extra of parseRecipients(settings.notify_recipients)) {
      if (!addresses.includes(extra)) addresses.push(extra);
    }
    if (!addresses.length) {
      await log('skipped', 'Nobody holding this permission has an email address');
      return { sent: 0, reason: 'nobody to email' };
    }

    const siteUrl = settings.site_url?.trim().replace(/\/+$/, '') ?? '';
    await sendEmail({
      apiKey: env.RESEND_API_KEY,
      from,
      to: addresses,
      subject: subject ?? title,
      html: shell({
        propertyName: settings.property_name || 'Nice Operation',
        title,
        body,
        link: link && siteUrl ? `${siteUrl}${link}` : null,
        linkLabel,
      }),
    });
    await log('sent', null, addresses);
    return { sent: addresses.length };
  } catch (err) {
    await log('failed', err?.message || String(err));
    return { sent: 0, reason: String(err?.message ?? err).slice(0, 200) };
  }
}

/** Both channels at once, for the things that want both. */
export async function announce(db, env, {
  kind, audience, title, body, link, linkLabel, subject, alsoUserIds = [],
}) {
  await notify(db, { kind, title, body, link, audience });
  return emailAudience(db, env, {
    kind, audience, subject: subject ?? title, title, body, link, linkLabel, alsoUserIds,
  });
}
