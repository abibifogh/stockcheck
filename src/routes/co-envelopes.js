/**
 * Envelopes: the API for sending a document out for signature, and the public
 * endpoints the recipient uses.
 *
 * The public half is the unusual part of this file. Four endpoints answer
 * without a session, and the token in the body is the entire gate. They are
 * written defensively for that reason: throttled, uniform in what they refuse,
 * and incapable of doing anything except to the one envelope the token names.
 */

import {
  badRequest, bool, forbidden, int, json, notFound, readJson, str,
} from '../lib/http.js';
import {
  ROUTINGS, SIGNATURE_METHODS, activeRecipients, assertLive, checkAccessCode,
  closeEnvelope, documentFor, envelopeOutcome, hashAccessCode, hashToken,
  inDays, isTheirTurn, newToken, prepareRecipients, recipientForToken,
  recordEnvelopeEvent, sealExternal, signingBlockedReason, throttleSigning,
} from '../lib/envelopes.js';
import {
  OVERSIGHT, coSettings, currentDigest, loadLetter, nextRef, nowStamp,
  recordEvent, safeParse,
} from '../lib/correspondence.js';
import { decryptBytes, openSecret, sealSecret } from '../lib/co-crypto.js';
import { notify } from '../lib/notify.js';
import { emailHolders, sendSignedReceipt, sendSigningInvitation } from '../lib/co-email.js';

// ---------------------------------------------------------------------------
// Inside the firm
// ---------------------------------------------------------------------------

/** Every envelope raised against one letter, with its people and its history. */
export async function listEnvelopes(ctx, letterId) {
  const { db, session } = ctx;
  const letter = await loadLetter(db, Number(letterId), session);

  const envelopes = await db.prepare(
    'SELECT * FROM co_envelopes WHERE letter_id = ? ORDER BY id DESC',
  ).bind(letter.id).all();

  const rows = envelopes.results ?? [];
  if (!rows.length) return json({ envelopes: [] });

  const recipients = await db.prepare(
    `SELECT r.id, r.envelope_id, r.seq, r.role, r.name, r.email, r.title, r.status,
            r.invited_at, r.first_viewed_at, r.completed_at, r.decline_reason,
            r.signed_name, r.method, r.signature_image, r.ip, r.reminded_at,
            r.invite_sent_at, r.last_email_error,
            r.access_code_hash IS NOT NULL AS has_access_code
       FROM co_envelope_recipients r
      WHERE r.envelope_id IN (SELECT id FROM co_envelopes WHERE letter_id = ?)
      ORDER BY r.envelope_id, r.seq`,
  ).bind(letter.id).all();

  return json({
    envelopes: rows.map((envelope) => {
      const mine = (recipients.results ?? []).filter((r) => r.envelope_id === envelope.id);
      return {
        ...envelope,
        recipients: mine,
        // Whose turn it is, which is the one thing somebody chasing an envelope
        // actually wants to know.
        waitingOn: activeRecipients(envelope, mine)
          .filter((r) => r.role !== 'viewer')
          .map((r) => r.name),
      };
    }),
  });
}

/**
 * Create an envelope and send it.
 *
 * Created and sent in one call on purpose. A draft envelope is a thing somebody
 * has to remember to come back to, and an engagement letter sitting unsent for
 * a fortnight because a dialog was closed is the failure this whole feature
 * exists to remove.
 *
 * The links come back in this response and nowhere else — only their hashes are
 * stored. A firm with email configured never needs them; one without copies
 * them out and sends them itself.
 */
export async function createEnvelope(ctx, letterId) {
  const { db, env, session } = ctx;
  const letter = await loadLetter(db, Number(letterId), session);
  const body = await readJson(ctx.request);
  const settings = await coSettings(db);

  if (['closed', 'cancelled'].includes(letter.status)) {
    throw badRequest('This correspondence is closed. Reopen it before sending it for signature.');
  }

  const existing = await db.prepare(
    "SELECT ref FROM co_envelopes WHERE letter_id = ? AND status IN ('draft','sent') LIMIT 1",
  ).bind(letter.id).first();
  if (existing) {
    throw badRequest(
      `${existing.ref} is already out for signature against this document. `
      + 'Void it first if you need to send a different version — two live envelopes against one '
      + 'document means two groups of people signing two different things.',
    );
  }

  const routing = str(body.routing, 'Order', { max: 20, fallback: 'sequential' });
  if (!ROUTINGS.includes(routing)) throw badRequest('That is not a signing order');

  const recipients = await prepareRecipients(env, body.recipients);
  if (!recipients.some((r) => r.role === 'signer' || r.role === 'approver')) {
    throw badRequest('Somebody has to be asked to sign or approve. An envelope of viewers asks nothing of anybody.');
  }

  // The document is frozen here. Everything signed afterwards is signed against
  // this exact digest.
  const contentHash = await currentDigest(db, env, letter);
  const ref = await nextRef(db, 'ENV', { digits: settings.refDigits });
  const expiresAt = inDays(
    body.expiryDays === undefined
      ? Number(settings.raw.co_envelope_expiry_days ?? 30)
      : int(body.expiryDays, 'Expires in', { min: 0, max: 3650 }),
  );

  const envelope = await db.prepare(
    `INSERT INTO co_envelopes
       (ref, letter_id, subject, message, routing, status, content_hash, expires_at,
        reminder_days, created_by, created_by_name, sent_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'sent', ?6, ?7, ?8, ?9, ?10, ?11)
     RETURNING *`,
  ).bind(
    ref,
    letter.id,
    str(body.subject, 'Subject', { max: 300 }) ?? letter.subject,
    str(body.message, 'Message', { max: 4000 }),
    routing,
    contentHash,
    expiresAt,
    body.reminderDays === undefined
      ? Number(settings.raw.co_envelope_reminder_days ?? 3)
      : int(body.reminderDays, 'Remind every', { min: 0, max: 90 }),
    session.user.id,
    session.user.name,
    nowStamp(),
  ).first();

  const now = nowStamp();
  // Hashed up front rather than inside the batch: `db.batch` wants statements,
  // and a map with an `await` in it hands it promises instead.
  const tokenHashes = await Promise.all(recipients.map((r) => hashToken(r.token)));
  // A second, encrypted copy of the link, so a reminder three days on can carry
  // the same one the first email did. See `sealSecret` for what that trades.
  const sealedTokens = await Promise.all(recipients.map((r) => sealSecret(env, r.token)));

  await db.batch(recipients.map((person, i) => db.prepare(
    `INSERT INTO co_envelope_recipients
       (envelope_id, seq, role, name, email, title, party_id, token_hash, token_sealed,
        access_code_hash, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending')`,
  ).bind(
    envelope.id, person.seq, person.role, person.name, person.email, person.title,
    person.partyId, tokenHashes[i], sealedTokens[i], person.accessCodeHash,
  )));

  const saved = await db.prepare(
    'SELECT * FROM co_envelope_recipients WHERE envelope_id = ? ORDER BY seq',
  ).bind(envelope.id).all();

  // Invite whoever is up first. On a parallel envelope that is everybody; on a
  // sequential one it is the first actor plus anybody merely copied in.
  const invited = activeRecipients(envelope, saved.results ?? []);
  await db.batch(invited.map((r) => db.prepare(
    "UPDATE co_envelope_recipients SET status = 'invited', invited_at = ? WHERE id = ?",
  ).bind(now, r.id)));

  // Post the invitations. Done here rather than left to the sweep because an
  // engagement letter that goes out "within the hour" is one nobody chases.
  const posted = await inviteByEmail(db, env, envelope, letter, invited);

  await recordEnvelopeEvent(db, envelope.id, {
    actor: session.user.name,
    action: 'envelope.sent',
    detail: {
      routing,
      recipients: recipients.length,
      invited: invited.map((r) => r.name),
      emailed: posted.sent,
      expiresAt,
    },
    ip: ctx.request.headers.get('CF-Connecting-IP'),
  });

  await recordEvent(db, env, letter.id, {
    actor: session.user.name,
    actorUserId: session.user.id,
    action: 'envelope.sent',
    detail: { envelope: ref, to: recipients.map((r) => r.name), routing, contentHash },
  });

  await notify(db, {
    kind: 'co_envelope',
    title: `${ref} sent for signature`,
    body: `“${letter.subject}” went to ${recipients.map((r) => r.name).join(', ')}.`,
    link: `#/co-letter?id=${letter.id}`,
    audience: 'co_register',
    actor: session.user.name,
  });

  const invitedIds = new Set(invited.map((r) => r.id));
  const bySeq = new Map((saved.results ?? []).map((r) => [r.seq, r]));

  return json({
    ok: true,
    envelope: { ...envelope, status: 'sent' },
    // What email did, so the screen can say "two sent, one has no address"
    // rather than leaving somebody to wonder.
    email: posted,
    links: recipients.map((person) => ({
      name: person.name,
      email: person.email,
      role: person.role,
      seq: person.seq,
      accessCode: person.accessCode,
      // Only the people whose turn it is have a live link. The rest are shown
      // as waiting, because handing somebody a link that will not open yet is
      // worse than telling them one is coming.
      invited: invitedIds.has(bySeq.get(person.seq)?.id),
      path: `/sign?t=${person.token}`,
    })),
  }, { status: 201 });
}

/**
 * Post the link to everybody whose turn it is.
 *
 * Reads each recipient's sealed token back rather than being handed one, so the
 * same function serves the first invitation, the next person's turn, and the
 * chaser three days later — three places that must not drift apart in what they
 * actually send.
 *
 * A recipient whose sealed token will not open — sealed under a `DOC_SECRET`
 * that has since been rotated — is reported rather than skipped silently. There
 * is a real answer for that case and it is "reissue the link".
 */
export async function inviteByEmail(db, env, envelope, letter, recipients, options = {}) {
  const result = { sent: 0, noAddress: 0, failed: 0, needsReissue: 0 };

  for (const recipient of recipients) {
    if (recipient.role === 'viewer' && options.chasing) continue;
    if (!recipient.email) { result.noAddress += 1; continue; }

    const token = await openSecret(env, recipient.token_sealed);
    if (!token) {
      result.needsReissue += 1;
      await db.prepare(
        'UPDATE co_envelope_recipients SET last_email_error = ? WHERE id = ?',
      ).bind('The stored link could not be read. Press “New link” to send a fresh one.', recipient.id)
        .run().catch(() => {});
      continue;
    }

    const outcome = await sendSigningInvitation(db, env, {
      envelope, recipient, letterRef: letter.ref, token, ...options,
    });
    if (outcome.sent) result.sent += 1;
    else if (outcome.reason && outcome.reason !== 'email not configured' && outcome.reason !== 'switched off') {
      result.failed += 1;
    }
  }

  return result;
}

/**
 * Reissue one recipient's link.
 *
 * Not "resend": the old token stops working. A link that has gone astray — sent
 * to the wrong address, forwarded, lost in a mailbox somebody else can read —
 * is a link that has to die, and a system that could re-show the original would
 * be a system where a stolen database is a stolen set of signatures.
 */
export async function reissueLink(ctx, recipientId) {
  const { db, env, session } = ctx;
  const found = await loadRecipient(db, session, Number(recipientId));
  const { recipient, envelope } = found;
  assertLive(envelope);

  if (recipient.status === 'signed' || recipient.status === 'declined') {
    throw badRequest(`${recipient.name} has already responded. There is nothing left for a link to do.`);
  }

  const body = await readJson(ctx.request).catch(() => ({}));
  const token = newToken();
  const accessCode = body.accessCode
    ? String(body.accessCode).trim().toUpperCase().slice(0, 24)
    : null;

  await db.prepare(
    `UPDATE co_envelope_recipients
        SET token_hash = ?1,
            token_sealed = ?2,
            access_code_hash = COALESCE(?3, access_code_hash),
            status = CASE WHEN status = 'pending' THEN 'pending' ELSE 'invited' END,
            invited_at = COALESCE(invited_at, ?4),
            reminded_at = NULL,
            last_email_error = NULL
      WHERE id = ?5`,
  ).bind(
    await hashToken(token),
    await sealSecret(env, token),
    await hashAccessCode(env, accessCode),
    nowStamp(),
    recipient.id,
  ).run();

  const letter = found.letter;
  const posted = await sendSigningInvitation(db, env, {
    envelope, recipient: { ...recipient, email: recipient.email }, letterRef: letter.ref, token,
  });

  await recordEnvelopeEvent(db, envelope.id, {
    recipientId: recipient.id,
    actor: session.user.name,
    action: 'link.reissued',
    detail: { to: recipient.name, previousInvalidated: true, emailed: Boolean(posted.sent) },
    ip: ctx.request.headers.get('CF-Connecting-IP'),
  });

  return json({
    ok: true,
    emailed: Boolean(posted.sent),
    link: {
      name: recipient.name,
      email: recipient.email,
      accessCode,
      path: `/sign?t=${token}`,
    },
  });
}

/**
 * Withdraw an envelope.
 *
 * Every outstanding link stops working immediately, and the reason is shown to
 * anybody who tries one — somebody who was asked to sign an engagement letter
 * on Monday deserves better than a link that silently stops opening.
 */
export async function voidEnvelope(ctx, envelopeId) {
  const { db, env, session } = ctx;
  const envelope = await db.prepare('SELECT * FROM co_envelopes WHERE id = ?')
    .bind(Number(envelopeId)).first();
  if (!envelope) throw notFound('That envelope could not be found');

  const letter = await loadLetter(db, envelope.letter_id, session);
  assertLive(envelope);

  const isSender = envelope.created_by === session.user.id;
  if (!isSender && !session.permissions.includes(OVERSIGHT)) {
    throw forbidden('Only whoever sent it, or a partner, can withdraw it.');
  }

  const body = await readJson(ctx.request).catch(() => ({}));
  const reason = str(body.reason, 'Reason', { max: 500 })
    ?? 'The firm withdrew this request.';

  await closeEnvelope(db, env, envelope, letter, 'voided', reason);
  await recordEnvelopeEvent(db, envelope.id, {
    actor: session.user.name,
    action: 'envelope.voided',
    detail: { reason },
    ip: ctx.request.headers.get('CF-Connecting-IP'),
  });

  return json({ ok: true });
}

/** The certificate: every recipient, everything that happened, and the digest. */
export async function certificate(ctx, envelopeId) {
  const { db, session } = ctx;
  const envelope = await db.prepare('SELECT * FROM co_envelopes WHERE id = ?')
    .bind(Number(envelopeId)).first();
  if (!envelope) throw notFound('That envelope could not be found');

  const letter = await loadLetter(db, envelope.letter_id, session);

  const [recipients, events, signatures] = await Promise.all([
    db.prepare('SELECT * FROM co_envelope_recipients WHERE envelope_id = ? ORDER BY seq')
      .bind(envelope.id).all(),
    db.prepare('SELECT * FROM co_envelope_events WHERE envelope_id = ? ORDER BY id')
      .bind(envelope.id).all(),
    db.prepare('SELECT * FROM co_signatures WHERE envelope_id = ? ORDER BY id')
      .bind(envelope.id).all(),
  ]);

  return json({
    envelope,
    letter: { id: letter.id, ref: letter.ref, subject: letter.subject },
    recipients: (recipients.results ?? []).map(({ token_hash: _t, access_code_hash: code, ...rest }) => ({
      ...rest,
      // Whether a code was required is part of the evidence; the code is not.
      requiredAccessCode: Boolean(code),
    })),
    events: (events.results ?? []).map((e) => ({ ...e, detail: safeParse(e.detail) })),
    signatures: signatures.results ?? [],
  });
}

async function loadRecipient(db, session, id) {
  const recipient = await db.prepare('SELECT * FROM co_envelope_recipients WHERE id = ?')
    .bind(id).first();
  if (!recipient) throw notFound('That recipient could not be found');

  const envelope = await db.prepare('SELECT * FROM co_envelopes WHERE id = ?')
    .bind(recipient.envelope_id).first();
  if (!envelope) throw notFound('That envelope could not be found');

  // Loading the letter is the access check: somebody who cannot see the
  // document cannot see who was asked to sign it either.
  const letter = await loadLetter(db, envelope.letter_id, session);
  return { recipient, envelope, letter };
}

// ---------------------------------------------------------------------------
// Outside the firm — no session, the token is the gate
// ---------------------------------------------------------------------------

/**
 * The uniform refusal.
 *
 * "Never existed", "already used" and "withdrawn last week" must look identical
 * from outside until the token itself has checked out, or these endpoints
 * become a way of discovering which links exist.
 */
async function refuse(message = 'This link is not valid. Please contact the firm for a new one.') {
  await new Promise((resolve) => setTimeout(resolve, 250));
  return forbidden(message);
}

function client(request) {
  return {
    ip: request.headers.get('CF-Connecting-IP') || 'unknown',
    userAgent: request.headers.get('User-Agent') || null,
  };
}

/**
 * Open a signing link.
 *
 * POST rather than GET so the token travels in a body instead of a URL that
 * ends up in server logs, browser history and whatever sits in between.
 */
export async function openForSigning(ctx) {
  const { db, env, request } = ctx;
  const { ip, userAgent } = client(request);
  if (!throttleSigning(ip, 60, 'open')) {
    return json({ error: 'Too many attempts. Wait a minute and try again.' }, { status: 429 });
  }

  const body = await readJson(request);
  const found = await recipientForToken(db, body.token);
  if (!found) throw await refuse();

  const { recipient, envelope, letter } = found;
  const blocked = signingBlockedReason(envelope, recipient, new Date());
  if (blocked) throw await refuse(blocked);

  const settings = await coSettings(db);

  // An access code is asked for before anything is shown. The envelope's
  // subject alone can be sensitive — "Settlement of the disputed assessment"
  // tells a reader plenty.
  if (recipient.access_code_hash && !await checkAccessCode(env, recipient, body.accessCode)) {
    if (body.accessCode) {
      await recordEnvelopeEvent(db, envelope.id, {
        recipientId: recipient.id,
        actor: recipient.name,
        action: 'access_code.rejected',
        ip,
        userAgent,
      });
    }
    return json({
      needsAccessCode: true,
      wrong: Boolean(body.accessCode),
      firmName: settings.firmName,
    }, { status: 200 });
  }

  const recipients = await db.prepare(
    'SELECT * FROM co_envelope_recipients WHERE envelope_id = ? ORDER BY seq',
  ).bind(envelope.id).all();

  const theirTurn = isTheirTurn(envelope, recipients.results ?? [], recipient);

  if (recipient.status === 'invited' || recipient.status === 'pending') {
    await db.prepare(
      `UPDATE co_envelope_recipients
          SET status = CASE WHEN ?1 = 1 THEN 'viewed' ELSE status END,
              first_viewed_at = COALESCE(first_viewed_at, ?2)
        WHERE id = ?3`,
    ).bind(theirTurn ? 1 : 0, nowStamp(), recipient.id).run();

    if (!recipient.first_viewed_at) {
      await recordEnvelopeEvent(db, envelope.id, {
        recipientId: recipient.id,
        actor: recipient.name,
        action: 'envelope.opened',
        ip,
        userAgent,
      });
    }
  }

  const document = await documentFor(db, env, envelope, letter);

  return json({
    firmName: settings.firmName,
    disclosure: settings.raw.co_signing_disclosure ?? '',
    envelope: {
      ref: envelope.ref,
      subject: envelope.subject,
      message: envelope.message,
      status: envelope.status,
      expiresAt: envelope.expires_at,
      sentBy: envelope.created_by_name,
      sentAt: envelope.sent_at,
      routing: envelope.routing,
    },
    you: {
      name: recipient.name,
      email: recipient.email,
      title: recipient.title,
      role: recipient.role,
      status: recipient.status,
      signedName: recipient.signed_name,
      completedAt: recipient.completed_at,
    },
    // Names only. A recipient is entitled to know who else is signing; their
    // addresses are the firm's business.
    others: (recipients.results ?? [])
      .filter((r) => r.id !== recipient.id)
      .map((r) => ({ name: r.name, role: r.role, status: r.status, seq: r.seq })),
    theirTurn,
    document,
  });
}

/** A file attached to the document, for somebody holding a link. */
export async function signingFile(ctx) {
  const { db, env, request } = ctx;
  const { ip } = client(request);
  if (!throttleSigning(ip, 120, 'file')) {
    return json({ error: 'Too many attempts. Wait a minute and try again.' }, { status: 429 });
  }

  const body = await readJson(request);
  const found = await recipientForToken(db, body.token);
  if (!found) throw await refuse();

  const { recipient, envelope, letter } = found;
  if (signingBlockedReason(envelope, recipient, new Date())) throw await refuse();
  if (!await checkAccessCode(env, recipient, body.accessCode)) throw await refuse();

  const attachment = await db.prepare(
    'SELECT * FROM co_attachments WHERE id = ? AND letter_id = ?',
  ).bind(int(body.id, 'File', { required: true }), letter.id).first();
  if (!attachment) throw notFound('That file is not part of this document');

  if (!env.FILES) throw badRequest('File storage is not configured on this deployment.');
  const object = await env.FILES.get(attachment.storage_key);
  if (!object) throw notFound('That file is missing from storage.');

  const stored = new Uint8Array(await object.arrayBuffer());
  const bytes = attachment.encrypted
    ? await decryptBytes(env, attachment.storage_key, stored)
    : stored;

  await recordEnvelopeEvent(db, envelope.id, {
    recipientId: recipient.id,
    actor: recipient.name,
    action: 'file.opened',
    detail: { name: attachment.name },
    ip,
    userAgent: request.headers.get('User-Agent'),
  });

  return new Response(bytes, {
    headers: {
      'Content-Type': attachment.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${attachment.name.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * Sign.
 *
 * The one endpoint here that writes a signature, and the checks read in the
 * order that matters: is the link real, is it still live, is it their turn, did
 * they agree to sign electronically, and only then what they actually put on it.
 */
export async function submitSignature(ctx) {
  const { db, env, request } = ctx;
  const { ip, userAgent } = client(request);
  if (!throttleSigning(ip, 20, 'sign')) {
    return json({ error: 'Too many attempts. Wait a minute and try again.' }, { status: 429 });
  }

  const body = await readJson(request);
  const found = await recipientForToken(db, body.token);
  if (!found) throw await refuse();

  const { recipient, envelope, letter } = found;
  const blocked = signingBlockedReason(envelope, recipient, new Date());
  if (blocked) throw await refuse(blocked);
  if (!await checkAccessCode(env, recipient, body.accessCode)) throw await refuse();

  if (recipient.status === 'signed') {
    throw badRequest('You have already signed this. Nothing further is needed from you.');
  }
  if (recipient.role === 'viewer') {
    throw badRequest('You were sent a copy of this for information. There is nothing to sign.');
  }

  const all = await db.prepare(
    'SELECT * FROM co_envelope_recipients WHERE envelope_id = ? ORDER BY seq',
  ).bind(envelope.id).all();
  if (!isTheirTurn(envelope, all.results ?? [], recipient)) {
    throw badRequest('It is not your turn yet. You will be told when the document reaches you.');
  }

  if (!bool(body.consent, false)) {
    throw badRequest('Please confirm you agree to sign electronically before signing.');
  }

  const name = str(body.name, 'Name', { required: true, max: 200 });
  const method = str(body.method, 'Method', { max: 20, fallback: 'typed' });
  if (!SIGNATURE_METHODS.includes(method)) throw badRequest('Unknown way of signing');

  const image = method === 'typed' ? null : str(body.image, 'Signature', { max: 400_000 });
  if (method !== 'typed' && !image) {
    throw badRequest('The signature image did not reach the server. Try again, or type your name instead.');
  }
  if (image && !/^data:image\/(png|jpeg|webp);base64,/.test(image)) {
    throw badRequest('That signature is not an image the system can store.');
  }

  const at = nowStamp();
  const seal = await sealExternal(env, envelope, recipient, { name, at });

  await db.prepare(
    `UPDATE co_envelope_recipients
        SET status = 'signed', completed_at = ?1, signed_name = ?2, method = ?3,
            signature_image = ?4, content_hash = ?5, seal = ?6, ip = ?7,
            user_agent = ?8, consented_at = ?1,
            title = COALESCE(?9, title)
      WHERE id = ?10`,
  ).bind(
    at, name, method, image, envelope.content_hash, seal, ip,
    userAgent, str(body.title, 'Title', { max: 120 }), recipient.id,
  ).run();

  // The signature also joins the letter's own list, so a letter signed by a
  // partner and a client shows both in one place rather than in two.
  await db.prepare(
    `INSERT INTO co_signatures
       (letter_id, user_id, name, title, method, image, content_hash, seal, at, ip,
        envelope_id, recipient_id, email, external)
     VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1)`,
  ).bind(
    letter.id, name, str(body.title, 'Title', { max: 120 }) ?? recipient.title,
    method, image, envelope.content_hash, seal, at, ip,
    envelope.id, recipient.id, recipient.email,
  ).run();

  await recordEnvelopeEvent(db, envelope.id, {
    recipientId: recipient.id,
    actor: name,
    action: recipient.role === 'approver' ? 'envelope.approved' : 'envelope.signed',
    detail: { method, consented: true, as: recipient.name },
    ip,
    userAgent,
  });

  await recordEvent(db, env, letter.id, {
    actor: `${name} (external)`,
    action: 'envelope.signed',
    detail: { envelope: envelope.ref, recipient: recipient.name, method },
  });

  // Whose turn is it now?
  const after = await db.prepare(
    'SELECT * FROM co_envelope_recipients WHERE envelope_id = ? ORDER BY seq',
  ).bind(envelope.id).all();
  const rows = after.results ?? [];

  const outcome = envelopeOutcome(rows);
  if (outcome) {
    await closeEnvelope(db, env, envelope, letter, outcome);

    // Everybody who signed gets their own copy of what they signed and when.
    // It is the only record they hold, and asking a client to keep the
    // invitation email instead is asking them to lose it.
    for (const person of rows.filter((r) => r.status === 'signed')) {
      await sendSignedReceipt(db, env, { envelope, recipient: person, letterRef: letter.ref });
    }

    await notify(db, {
      kind: 'co_envelope',
      level: 'info',
      title: `${envelope.ref} is fully signed`,
      body: `“${letter.subject}” has been signed by everybody it was sent to.`,
      link: `#/co-letter?id=${letter.id}`,
      audience: 'co_register',
    });
    await emailHolders(db, env, {
      kind: 'co_envelope_done',
      permission: 'co_register',
      subject: `Fully signed: ${letter.ref}`,
      heading: `${envelope.ref} is fully signed`,
      lead: `“${letter.subject}” has been signed by everybody it was sent to. `
        + 'The document is now sealed.',
      link: `/#/co-letter?id=${letter.id}`,
      linkLabel: 'Open the letter',
    });
  } else {
    const next = activeRecipients(envelope, rows).filter((r) => r.status === 'pending');
    if (next.length) {
      await db.batch(next.map((r) => db.prepare(
        "UPDATE co_envelope_recipients SET status = 'invited', invited_at = ? WHERE id = ?",
      ).bind(at, r.id)));

      // Their turn has come, so now they are told. Re-read rather than reusing
      // the rows above, which still say `pending`.
      const reread = await db.prepare(
        `SELECT * FROM co_envelope_recipients WHERE envelope_id = ? AND id IN (${next.map(() => '?').join(',')})`,
      ).bind(envelope.id, ...next.map((r) => r.id)).all();
      await inviteByEmail(db, env, envelope, letter, reread.results ?? []);

      await recordEnvelopeEvent(db, envelope.id, {
        actor: 'Signing',
        action: 'envelope.advanced',
        detail: { to: next.map((r) => r.name) },
      });
    }

    await notify(db, {
      kind: 'co_envelope',
      title: `${recipient.name} signed ${envelope.ref}`,
      body: next.length
        ? `Now with ${next.map((r) => r.name).join(', ')}.`
        : 'Waiting on the others.',
      link: `#/co-letter?id=${letter.id}`,
      audience: 'co_register',
    });
  }

  return json({
    ok: true,
    signedAt: at,
    complete: outcome === 'completed',
    // Returned so the recipient's own page can show what they signed and when,
    // which is the closest thing they get to a receipt.
    receipt: {
      envelope: envelope.ref,
      document: letter.ref,
      name,
      at,
      fingerprint: envelope.content_hash?.slice(0, 16) ?? null,
    },
  });
}

/** Decline. Ends the envelope for everybody, because the answer was no. */
export async function declineSignature(ctx) {
  const { db, env, request } = ctx;
  const { ip, userAgent } = client(request);
  if (!throttleSigning(ip, 20, 'sign')) {
    return json({ error: 'Too many attempts. Wait a minute and try again.' }, { status: 429 });
  }

  const body = await readJson(request);
  const found = await recipientForToken(db, body.token);
  if (!found) throw await refuse();

  const { recipient, envelope, letter } = found;
  const blocked = signingBlockedReason(envelope, recipient, new Date());
  if (blocked) throw await refuse(blocked);
  if (!await checkAccessCode(env, recipient, body.accessCode)) throw await refuse();

  if (recipient.status === 'signed') {
    throw badRequest('You have already signed this. Contact the firm if that was a mistake.');
  }

  const reason = str(body.reason, 'Reason', { required: true, max: 1000 });

  await db.prepare(
    `UPDATE co_envelope_recipients
        SET status = 'declined', completed_at = ?1, decline_reason = ?2, ip = ?3, user_agent = ?4
      WHERE id = ?5`,
  ).bind(nowStamp(), reason, ip, userAgent, recipient.id).run();

  await recordEnvelopeEvent(db, envelope.id, {
    recipientId: recipient.id,
    actor: recipient.name,
    action: 'envelope.declined',
    detail: { reason },
    ip,
    userAgent,
  });

  await closeEnvelope(db, env, envelope, letter, 'declined', `${recipient.name}: ${reason}`);

  await notify(db, {
    kind: 'co_envelope',
    level: 'high',
    title: `${recipient.name} declined to sign ${envelope.ref}`,
    body: reason,
    link: `#/co-letter?id=${letter.id}`,
    audience: 'co_register',
  });
  // The one envelope outcome that always wants somebody's attention today.
  await emailHolders(db, env, {
    kind: 'co_envelope_declined',
    permission: 'co_register',
    subject: `Declined: ${letter.ref}`,
    heading: `${recipient.name} declined to sign ${envelope.ref}`,
    lead: `“${letter.subject}” — ${reason}`,
    link: `/#/co-letter?id=${letter.id}`,
    linkLabel: 'Open the letter',
  });

  return json({ ok: true, reason });
}

// ---------------------------------------------------------------------------
// My own signature
// ---------------------------------------------------------------------------

/**
 * Save, replace or clear the signature this person signs with.
 *
 * Open to anybody signed in, because it is theirs. Held on the person rather
 * than copied into each signature, so replacing it changes what they sign with
 * next time and changes nothing they have already signed.
 */
export async function saveMySignature(ctx) {
  const { db, session } = ctx;
  const body = await readJson(ctx.request);

  const clear = bool(body.clear, false);
  const method = clear ? null : str(body.method, 'Method', { max: 20, fallback: 'drawn' });
  if (!clear && !['drawn', 'uploaded'].includes(method)) {
    throw badRequest('A saved signature is either drawn or an uploaded image');
  }

  const image = clear ? null : str(body.image, 'Signature', { max: 400_000, required: true });
  if (image && !/^data:image\/(png|jpeg|webp);base64,/.test(image)) {
    throw badRequest('That is not an image the system can store. PNG, JPEG or WebP.');
  }

  await db.prepare(
    `INSERT INTO co_staff (user_id, signature_image, signature_method)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(user_id) DO UPDATE SET
       signature_image = excluded.signature_image,
       signature_method = excluded.signature_method`,
  ).bind(session.user.id, image, method).run();

  await db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(
    `${session.user.name} (${session.user.role})`,
    clear ? 'account.signature_cleared' : 'account.signature_saved',
    String(session.user.id),
    null,
  ).run().catch(() => {});

  return json({ ok: true, saved: !clear });
}

/** What this person signs with, if they have set anything up. */
export async function mySignature(ctx) {
  const row = await ctx.db.prepare(
    'SELECT signature_image, signature_method, signature_name, title FROM co_staff WHERE user_id = ?',
  ).bind(ctx.session.user.id).first().catch(() => null);

  return json({
    image: row?.signature_image ?? null,
    method: row?.signature_method ?? null,
    signatureName: row?.signature_name ?? ctx.session.user.name,
    title: row?.title ?? null,
  });
}
