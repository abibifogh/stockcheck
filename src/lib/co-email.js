/**
 * Email for the practice: signing invitations, chasers, receipts, and the
 * notices the firm's own people get alongside the bell.
 *
 * Two audiences with almost nothing in common, which is why they are separate
 * functions rather than one with a flag:
 *
 *   Outside the firm.  A client, a bank, a director. They did not ask to be
 *   here, they have no account, and they are probably on a phone. One message,
 *   one button, no jargon and nothing that looks like software.
 *
 *   Inside the firm.  People who already have the bell. Email is the second
 *   channel for them — the one that works when somebody does not live in the
 *   app — so it is deliberately quieter: the things with a deadline attached,
 *   and nothing else.
 *
 * Nothing here throws at its caller. Email is a courtesy on top of work that
 * has already succeeded, and a mail outage must never undo a signature or roll
 * back an envelope. Every send is logged either way, so a firm that thinks
 * nothing is going out can look rather than guess.
 */

import { sendEmail } from './email.js';
import { effectivePermissions } from './permissions.js';
import { readSettings } from './notify.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Is there anything to send with?
 *
 * Two things have to be true, and both are the firm's to arrange: a provider
 * key in the Worker, and a from-address that their domain actually authorises.
 * Missing either is not a failure — it is a firm that has not set email up, and
 * logging that on every event would bury the real failures.
 */
export function mailConfigured(env, settings) {
  return Boolean(env?.RESEND_API_KEY && settings?.email_from?.trim());
}

/** The absolute address of something in the app, or null if nobody set one. */
export function absoluteUrl(settings, path) {
  const base = settings?.site_url?.trim().replace(/\/+$/, '');
  if (!base || !path) return null;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function senderOf(settings) {
  const address = settings.email_from.trim();
  const name = settings.co_email_sender_name?.trim();
  // "Kwame & Co <noreply@kwame.com>" reads better in an inbox than the bare
  // address, and is what stops a client deleting it as spam unread.
  return name && !address.includes('<') ? `${name} <${address}>` : address;
}

async function log(db, kind, status, recipients, detail) {
  await db.prepare(
    'INSERT INTO email_log (kind, day, recipients, status, detail) VALUES (?, ?, ?, ?, ?)',
  ).bind(
    kind, null,
    (Array.isArray(recipients) ? recipients : [recipients]).filter(Boolean).join(', '),
    status,
    detail ? String(detail).slice(0, 500) : null,
  ).run().catch(() => {});
}

/**
 * Send one message, and never let the attempt escape.
 *
 * Returns `{ sent, reason }` rather than throwing, because every caller is
 * finishing a piece of work that has already happened and none of them can do
 * anything useful with an exception.
 */
export async function deliver(db, env, settings, { kind, to, subject, html, replyTo }) {
  const addresses = (Array.isArray(to) ? to : [to])
    .map((a) => String(a ?? '').trim())
    .filter((a) => a && a.includes('@'));

  if (!addresses.length) return { sent: 0, reason: 'no address' };
  if (!mailConfigured(env, settings)) return { sent: 0, reason: 'email not configured' };

  try {
    await sendEmail({
      apiKey: env.RESEND_API_KEY,
      from: senderOf(settings),
      to: addresses,
      subject,
      html,
      // A client hitting reply should reach a person, not a mailbox nobody
      // watches. Blank falls back to the from-address, which is usually
      // exactly that mailbox — so the setting is worth filling in.
      ...(replyTo || settings.co_email_reply_to?.trim()
        ? { reply_to: replyTo || settings.co_email_reply_to.trim() }
        : {}),
    });
    await log(db, kind, 'sent', addresses, null);
    return { sent: addresses.length };
  } catch (err) {
    const reason = err?.message || String(err);
    await log(db, kind, 'failed', addresses, reason);
    return { sent: 0, reason };
  }
}

// ---------------------------------------------------------------------------
// The look of it
// ---------------------------------------------------------------------------

/**
 * The frame every message uses.
 *
 * Inline styles only, a table for layout, and a light background. Mail clients
 * strip stylesheets, ignore CSS variables and disagree about dark mode, so the
 * only reliable thing is the shape email has had since 2005.
 */
function frame({ firmName, heading, lead, body = '', button, buttonLabel, footer }) {
  return `
<div style="margin:0;padding:24px 12px;background:#eef1f5">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden">
  <tr><td style="padding:18px 22px;background:#14181f">
    <div style="font:700 16px/1.3 Arial,sans-serif;color:#ffffff">${escapeHtml(firmName)}</div>
  </td></tr>
  <tr><td style="padding:22px 22px 6px">
    <div style="font:700 19px/1.35 Arial,sans-serif;color:#14181f">${escapeHtml(heading)}</div>
    ${lead ? `<div style="font:400 15px/1.6 Arial,sans-serif;color:#3c4553;margin-top:10px">${escapeHtml(lead)}</div>` : ''}
    ${body}
  </td></tr>
  ${button ? `<tr><td style="padding:18px 22px 6px">
    <a href="${escapeHtml(button)}" style="display:inline-block;background:#14181f;color:#ffffff;font:700 15px/1 Arial,sans-serif;padding:14px 26px;border-radius:8px;text-decoration:none">${escapeHtml(buttonLabel)}</a>
  </td></tr>
  <tr><td style="padding:2px 22px 8px">
    <div style="font:400 12px/1.5 Arial,sans-serif;color:#8b95a5;word-break:break-all">Or paste this into your browser:<br>${escapeHtml(button)}</div>
  </td></tr>` : ''}
  ${footer ? `<tr><td style="padding:10px 22px 22px;border-top:1px solid #e6eaf0">
    <div style="font:400 12px/1.6 Arial,sans-serif;color:#8b95a5">${footer}</div>
  </td></tr>` : ''}
</table>
</div>`;
}

/** A definition list — "Document: TAX-2026-0007" — for the detail block. */
function facts(rows) {
  const lines = rows
    .filter(([, value]) => value != null && value !== '')
    .map(([label, value]) => `<tr>
      <td style="padding:3px 12px 3px 0;font:400 13px/1.5 Arial,sans-serif;color:#8b95a5;white-space:nowrap">${escapeHtml(label)}</td>
      <td style="padding:3px 0;font:400 13px/1.5 Arial,sans-serif;color:#14181f">${escapeHtml(value)}</td>
    </tr>`).join('');
  return lines ? `<table role="presentation" style="margin-top:14px">${lines}</table>` : '';
}

// ---------------------------------------------------------------------------
// To the person who has to sign
// ---------------------------------------------------------------------------

/**
 * The invitation, and the chaser, which are the same message in two moods.
 *
 * The access code is deliberately *not* in here even when one is set. A code
 * emailed alongside the link it protects is not a second factor, it is a longer
 * link — so the screen tells the sender to pass it on some other way, and this
 * message only mentions that they will need it.
 */
export function signingEmail({
  firmName, recipient, envelope, letterRef, url, message, chasing = false, daysWaiting = 0,
}) {
  const asked = recipient.role === 'approver' ? 'approve' : 'sign';

  return {
    subject: chasing
      ? `Reminder: ${envelope.subject}`
      : recipient.role === 'viewer'
        ? `For your records: ${envelope.subject}`
        : `Please ${asked}: ${envelope.subject}`,

    html: frame({
      firmName,
      heading: chasing
        ? 'A document is still waiting for you'
        : recipient.role === 'viewer'
          ? 'A copy for your records'
          : `Please ${asked} this document`,

      lead: chasing
        ? `We sent this ${daysWaiting === 1 ? 'yesterday' : `${daysWaiting} days ago`} and it has not been ${asked === 'approve' ? 'approved' : 'signed'} yet. `
          + 'If you have already dealt with it, please ignore this.'
        : recipient.role === 'viewer'
          ? 'You have been sent a copy of this document for information. Nothing is needed from you.'
          : `${firmName} has sent you a document to ${asked}. You do not need an account or a password — `
            + 'open it, read it, and sign on the page.',

      body: (message && !chasing ? `<div style="margin-top:14px;padding:12px 14px;background:#f5f7fa;border-radius:8px;font:400 14px/1.6 Arial,sans-serif;color:#3c4553;white-space:pre-line">${escapeHtml(message)}</div>` : '')
        + facts([
          ['Document', envelope.subject],
          ['Reference', letterRef],
          ['Sent by', envelope.created_by_name],
          ['Addressed to', recipient.name],
          recipient.access_code_hash ? ['Access code', 'You will be asked for the code we gave you separately'] : [],
          envelope.expires_at ? ['Available until', String(envelope.expires_at).slice(0, 10)] : [],
        ].filter((row) => row.length === 2)),

      button: url,
      buttonLabel: recipient.role === 'viewer'
        ? 'Read the document'
        : asked === 'approve' ? 'Read and approve' : 'Read and sign',

      footer: 'This link was sent to you alone and should not be forwarded. '
        + 'If you were not expecting it, please reply and tell us.',
    }),
  };
}

/** Their copy once everybody has signed. */
export function signedReceiptEmail({ firmName, recipient, envelope, letterRef }) {
  return {
    subject: `Signed: ${envelope.subject}`,
    html: frame({
      firmName,
      heading: 'This document is now fully signed',
      lead: 'Everybody it was sent to has signed. Keep this message — it is your record '
        + 'of what was signed and when.',
      body: facts([
        ['Document', envelope.subject],
        ['Reference', letterRef],
        ['You signed as', recipient.signed_name ?? recipient.name],
        ['On', String(recipient.completed_at ?? '').slice(0, 16).replace('T', ' ')],
        ['Request', envelope.ref],
        ['Document fingerprint', envelope.content_hash?.slice(0, 24) ?? null],
      ]),
      footer: `${escapeHtml(firmName)} holds the full record, including the exact document `
        + 'you signed and the time it was signed. Ask us if you need a copy of it.',
    }),
  };
}

// ---------------------------------------------------------------------------
// Sending them
// ---------------------------------------------------------------------------

/** True when the firm has switched off email to people outside it. */
export function recipientMailOn(settings) {
  return settings.co_email_recipients !== '0';
}

export function staffMailOn(settings) {
  return settings.co_email_staff !== '0';
}

/**
 * Send one recipient their link, and record on the row whether it left.
 *
 * `invite_sent_at` is deliberately separate from `invited_at`: the first is
 * "their turn came", the second is "we actually told them". The two differ
 * whenever email is off, misconfigured or failing, and "invited but never told"
 * is exactly the state somebody chasing a signature needs to be able to see.
 */
export async function sendSigningInvitation(db, env, {
  envelope, recipient, letterRef, token, chasing = false, daysWaiting = 0,
}) {
  const settings = await readSettings(db);
  if (!recipientMailOn(settings)) return { sent: 0, reason: 'switched off' };
  if (!recipient.email) return { sent: 0, reason: 'no address' };

  const url = absoluteUrl(settings, `/sign?t=${token}`);
  if (!url) {
    // Without a site address the link would be relative and useless. Said out
    // loud rather than sending a broken message.
    await noteFailure(db, recipient.id, 'No site address is set under Practice setup');
    return { sent: 0, reason: 'no site url' };
  }

  const { subject, html } = signingEmail({
    firmName: settings.co_firm_name || settings.property_name || 'The Practice',
    recipient,
    envelope,
    letterRef,
    url,
    message: envelope.message,
    chasing,
    daysWaiting,
  });

  const result = await deliver(db, env, settings, {
    kind: chasing ? 'co_sign_reminder' : 'co_sign_invite',
    to: recipient.email,
    subject,
    html,
  });

  if (result.sent) {
    await db.prepare(
      'UPDATE co_envelope_recipients SET invite_sent_at = ?, last_email_error = NULL WHERE id = ?',
    ).bind(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), recipient.id).run().catch(() => {});
  } else if (result.reason && result.reason !== 'email not configured') {
    await noteFailure(db, recipient.id, result.reason);
  }

  return result;
}

async function noteFailure(db, recipientId, reason) {
  await db.prepare('UPDATE co_envelope_recipients SET last_email_error = ? WHERE id = ?')
    .bind(String(reason).slice(0, 300), recipientId).run().catch(() => {});
}

export async function sendSignedReceipt(db, env, { envelope, recipient, letterRef }) {
  const settings = await readSettings(db);
  if (!recipientMailOn(settings) || !recipient.email) return { sent: 0 };

  const { subject, html } = signedReceiptEmail({
    firmName: settings.co_firm_name || settings.property_name || 'The Practice',
    recipient,
    envelope,
    letterRef,
  });

  return deliver(db, env, settings, {
    kind: 'co_sign_receipt', to: recipient.email, subject, html,
  });
}

// ---------------------------------------------------------------------------
// To the firm's own people
// ---------------------------------------------------------------------------

/**
 * Email named people rather than everybody holding a permission.
 *
 * "This letter is now with Ama" is for Ama. The existing audience helper mails
 * everybody who *could* have received it, which for `co_route` is most of the
 * firm — and an inbox full of other people's work is an inbox nobody reads.
 */
export async function emailPeople(db, env, {
  kind, userIds = [], addresses = [], subject, heading, lead, link, linkLabel = 'Open it',
}) {
  const settings = await readSettings(db);
  if (!staffMailOn(settings)) return { sent: 0, reason: 'switched off' };

  const wanted = new Set(userIds.map(Number).filter(Number.isFinite));
  const to = [...addresses];

  if (wanted.size) {
    const rows = await db.prepare(
      'SELECT id, email FROM users WHERE active = 1',
    ).all().catch(() => ({ results: [] }));
    for (const person of rows.results ?? []) {
      if (wanted.has(person.id) && person.email && !to.includes(person.email)) to.push(person.email);
    }
  }
  if (!to.length) return { sent: 0, reason: 'nobody to email' };

  const url = absoluteUrl(settings, link);
  return deliver(db, env, settings, {
    kind,
    to,
    subject,
    html: frame({
      firmName: settings.co_firm_name || settings.property_name || 'The Practice',
      heading,
      lead,
      button: url,
      buttonLabel: linkLabel,
      footer: 'You are getting this because it is with you in the correspondence register.',
    }),
  });
}

/** Everybody holding a permission — for the things the whole desk should see. */
export async function emailHolders(db, env, { permission, ...rest }) {
  const rows = await db.prepare('SELECT * FROM users WHERE active = 1').all()
    .catch(() => ({ results: [] }));
  const userIds = (rows.results ?? [])
    .filter((u) => effectivePermissions(u).includes(permission))
    .map((u) => u.id);
  return emailPeople(db, env, { ...rest, userIds });
}
