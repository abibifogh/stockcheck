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
