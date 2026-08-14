/**
 * Attachments: the scanned letter, the signed engagement letter, the working
 * papers somebody emailed over.
 *
 * The bytes go to R2, encrypted before they leave the Worker, so the bucket
 * holds ciphertext and a leaked object is not a leaked document. The row in D1
 * holds only what it takes to list and find it — and the plaintext SHA-256,
 * which is what the document seal folds in and what tells you two uploads are
 * the same file.
 *
 * Downloads stream back through the Worker rather than by a signed R2 URL. That
 * costs a little and buys two things: the confidentiality check runs on every
 * single fetch, and a link somebody pasted into a chat is useless to anyone who
 * cannot sign in.
 */

import { badRequest, forbidden, json, notFound } from '../lib/http.js';
import { decryptBytes, encryptBytes, newStorageKey, sha256 } from '../lib/co-crypto.js';
import { OVERSIGHT, canSeeLetter, loadLetter, recordEvent } from '../lib/correspondence.js';
import { assertNoOpenEnvelope } from '../lib/envelopes.js';

// R2 has no practical limit here; the Worker's memory does. 25 MB is a
// comfortable scanned-PDF ceiling that leaves room to encrypt a copy.
const MAX_BYTES = 25 * 1024 * 1024;

// What a practice actually attaches. An allowlist rather than a blocklist:
// listing what is safe is a finite job, listing what is not never ends.
const ALLOWED = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/tiff', 'image/webp', 'image/heic',
  'text/plain', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-outlook', 'message/rfc822',
  'application/zip',
]);

function bucketOf(env) {
  if (!env.FILES) {
    throw badRequest(
      'File storage is not configured on this deployment. '
      + 'Create an R2 bucket and bind it as FILES — see “Attachments” in the setup guide.',
    );
  }
  return env.FILES;
}

/**
 * Upload one file, sent as multipart form data.
 *
 * Attached to a letter, an engagement or a meeting — exactly one of the three,
 * because a file that belongs to two things belongs to neither when one of them
 * is deleted.
 */
export async function uploadAttachment(ctx) {
  const { db, env, session } = ctx;
  const bucket = bucketOf(env);

  let form;
  try {
    form = await ctx.request.formData();
  } catch {
    throw badRequest('That upload did not arrive as a file');
  }

  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') throw badRequest('No file was attached');

  const letterId = numberOrNull(form.get('letterId'));
  const caseId = numberOrNull(form.get('caseId'));
  const meetingId = numberOrNull(form.get('meetingId'));
  if ([letterId, caseId, meetingId].filter(Boolean).length !== 1) {
    throw badRequest('Say what this file belongs to: a letter, an engagement, or a meeting');
  }

  // Attaching to a letter you cannot see is attaching to a letter that, as far
  // as you are concerned, does not exist.
  let letter = null;
  if (letterId) {
    letter = await loadLetter(db, letterId, session);
    if (letter.sealed_at) {
      throw badRequest(
        'This document has been sealed and signed. Adding a file now would change what was signed. '
        + 'Register a follow-up letter and attach it there.',
      );
    }
    // The attachments are part of what an envelope froze, so they cannot move
    // while it is out either.
    await assertNoOpenEnvelope(db, letter);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) throw badRequest('That file is empty');
  if (bytes.length > MAX_BYTES) {
    throw badRequest(`Files must be ${Math.round(MAX_BYTES / 1024 / 1024)} MB or smaller`);
  }

  const mime = String(file.type || 'application/octet-stream').split(';')[0].trim();
  if (!ALLOWED.has(mime)) {
    throw badRequest(
      `${mime || 'That kind of file'} cannot be attached. `
      + 'PDFs, images, Office documents, emails, plain text and zip archives can.',
    );
  }

  const name = String(form.get('name') || file.name || 'attachment').slice(0, 200);
  const scope = letterId ? 'letters' : caseId ? 'cases' : 'meetings';
  const storageKey = newStorageKey(scope, letterId ?? caseId ?? meetingId, name);

  const digest = await sha256(bytes);
  const ciphertext = await encryptBytes(env, storageKey, bytes);

  await bucket.put(storageKey, ciphertext, {
    httpMetadata: { contentType: 'application/octet-stream' },
    // Enough to identify an object from the bucket alone if the database is
    // ever lost, and nothing that would be a disclosure on its own.
    customMetadata: { scope, sha256: digest, uploadedBy: String(session.user.id) },
  });

  const row = await db.prepare(
    `INSERT INTO co_attachments
       (letter_id, case_id, meeting_id, name, mime, size, sha256, storage_key, encrypted, uploaded_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)
     RETURNING id, name, mime, size, sha256, uploaded_by, at`,
  ).bind(
    letterId, caseId, meetingId, name, mime, bytes.length, digest, storageKey, session.user.name,
  ).first();

  if (letter) {
    await recordEvent(db, env, letter.id, {
      actor: session.user.name,
      actorUserId: session.user.id,
      action: 'attachment.added',
      detail: { name, size: bytes.length, sha256: digest },
    });
  }

  return json({ ok: true, attachment: row }, { status: 201 });
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Stream a file back, after checking this person may see what it hangs off. */
export async function downloadAttachment(ctx, id) {
  const { db, env, session } = ctx;
  const bucket = bucketOf(env);

  const row = await db.prepare('SELECT * FROM co_attachments WHERE id = ?').bind(Number(id)).first();
  if (!row) throw notFound('That file could not be found');

  if (row.letter_id) {
    const letter = await db.prepare('SELECT * FROM co_letters WHERE id = ?').bind(row.letter_id).first();
    if (!letter || !await canSeeLetter(db, letter, session)) throw notFound('That file could not be found');
  }

  const object = await bucket.get(row.storage_key);
  if (!object) {
    throw notFound(
      'The record of this file is here but the file itself is missing from storage. '
      + 'Nothing else has been lost — the letter and its history are intact.',
    );
  }

  const stored = new Uint8Array(await object.arrayBuffer());
  const bytes = row.encrypted ? await decryptBytes(env, row.storage_key, stored) : stored;

  return new Response(bytes, {
    headers: {
      'Content-Type': row.mime || 'application/octet-stream',
      // `inline` so a scanned PDF opens in the tab rather than landing in
      // Downloads, which is how somebody reads a letter while replying to it.
      'Content-Disposition': `inline; filename="${row.name.replace(/"/g, '')}"`,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * Remove an attachment.
 *
 * The row goes and so does the object. This is the one genuinely destructive
 * action in the system, which is why it is restricted to whoever uploaded the
 * file and to partners — and why the removal itself is written into the letter's
 * trail, where it cannot be removed.
 */
export async function removeAttachment(ctx, id) {
  const { db, env, session } = ctx;
  const bucket = bucketOf(env);

  const row = await db.prepare('SELECT * FROM co_attachments WHERE id = ?').bind(Number(id)).first();
  if (!row) throw notFound('That file could not be found');

  const isUploader = row.uploaded_by === session.user.name;
  if (!isUploader && !session.permissions.includes(OVERSIGHT)) {
    throw forbidden('Only whoever attached this, or a partner, can remove it.');
  }

  if (row.letter_id) {
    const letter = await db.prepare('SELECT * FROM co_letters WHERE id = ?').bind(row.letter_id).first();
    if (letter?.sealed_at) {
      throw badRequest('This document is sealed. Its attachments are part of what was signed.');
    }
    await recordEvent(db, env, row.letter_id, {
      actor: session.user.name,
      actorUserId: session.user.id,
      action: 'attachment.removed',
      detail: { name: row.name, sha256: row.sha256 },
    });
  }

  await db.prepare('DELETE FROM co_attachments WHERE id = ?').bind(row.id).run();
  // Deleted after the row, not before: an object with no row is invisible
  // clutter, a row with no object is an error message on somebody's screen.
  await bucket.delete(row.storage_key).catch((err) => console.error('R2 delete failed', err));

  return json({ ok: true });
}
