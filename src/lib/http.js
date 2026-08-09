export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export const badRequest = (message, detail) => new HttpError(400, message, detail);
export const unauthorized = (message = 'Sign in required') => new HttpError(401, message);
export const forbidden = (message = 'Manager access required') => new HttpError(403, message);
export const notFound = (message = 'Not found') => new HttpError(404, message);

/**
 * True when a query failed because part of the schema has not been created.
 *
 * This happens in exactly one situation that matters: new code is deployed
 * before the matching database changes have been applied. Detecting it lets us
 * say so plainly instead of returning "something went wrong", which tells the
 * person nothing about the one action that would fix it.
 */
export function isMissingTable(err) {
  return /no such table|no such column/i.test(String(err?.message ?? err));
}

/**
 * Turn a database constraint failure into something a person can act on.
 *
 * SQLite reports these as ordinary errors, so an uncaught one surfaces as
 * "something went wrong on the server" — which is both alarming and useless,
 * since the cause is almost always an ordinary mistake the person could fix in
 * five seconds if only they were told what it was.
 *
 * Anything that is not a recognised constraint is re-thrown untouched: a real
 * fault should stay loud.
 */
export function rethrowConstraint(err, { unique, foreignKey, notNull } = {}) {
  const text = String(err?.message ?? err);
  if (unique && /UNIQUE constraint/i.test(text)) throw badRequest(unique);
  if (foreignKey && /FOREIGN KEY constraint/i.test(text)) throw badRequest(foreignKey);
  if (notNull && /NOT NULL constraint/i.test(text)) throw badRequest(notNull);
  throw err;
}

export async function readJson(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.includes('application/json')) throw badRequest('Expected a JSON body');
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Expected a JSON object');
    return body;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw badRequest('Malformed JSON body');
  }
}

export function str(value, field, { max = 200, required = false, fallback = null } = {}) {
  if (value == null || value === '') {
    if (required) throw badRequest(`${field} is required`);
    return fallback;
  }
  const s = String(value).trim();
  if (required && !s) throw badRequest(`${field} is required`);
  if (s.length > max) throw badRequest(`${field} must be ${max} characters or fewer`);
  return s || fallback;
}

export function num(value, field, { min = -1e9, max = 1e9, required = false, fallback = 0 } = {}) {
  if (value == null || value === '') {
    if (required) throw badRequest(`${field} is required`);
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number`);
  if (n < min || n > max) throw badRequest(`${field} must be between ${min} and ${max}`);
  return n;
}

export function int(value, field, opts = {}) {
  return Math.round(num(value, field, opts));
}

export function bool(value, fallback = false) {
  if (value == null) return fallback;
  return value === true || value === 'true' || value === 1 || value === '1';
}

export function csvResponse(filename, rows) {
  const escape = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) => r.map(escape).join(',')).join('\n');
  return new Response(`﻿${body}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
