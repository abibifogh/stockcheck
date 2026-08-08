import { badRequest, bool, csvResponse, json, readJson, str } from '../lib/http.js';
import { partitionByLock } from '../lib/locks.js';
import { isDay } from '../util/dates.js';

/**
 * Bulk entry of day sheets from a spreadsheet.
 *
 * For catching up on a backlog, or for a property that kept paper records
 * before this existed. The flow is deliberately two-step: an import always
 * previews first and only writes when the person has seen exactly what it is
 * about to do. Bulk operations that write on the first click are how a month
 * of good data gets overwritten by a mis-aligned column.
 */

const FIXED_COLUMNS = ['Date', 'In-house guests', 'Outside guests', 'Note'];

/** A spreadsheet template with one column per everyday ingredient. */
export async function importTemplate(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT i.name, i.unit, c.name AS category
     FROM ingredients i JOIN categories c ON c.id = i.category_id
     WHERE i.active = 1
     ORDER BY c.sort_order, c.name, i.sort_order, i.name`,
  ).all();

  const ingredients = rows.results ?? [];
  const header = [...FIXED_COLUMNS, ...ingredients.map((i) => `${i.name} (${i.unit})`)];

  // Two example rows, clearly marked, so the shape is obvious at a glance.
  const example = ['2026-08-01', '48', '6', 'example row — delete before importing'];
  for (const ing of ingredients) example.push(ing.unit === 'pcs' ? '80' : '2.5');

  const blank = ['2026-08-02', '', '', ''];
  for (const _ of ingredients) blank.push('');

  return csvResponse('breakfast-import-template.csv', [header, example, blank]);
}

/**
 * A small CSV reader. Handles quoted fields, embedded commas and newlines, and
 * both CRLF and LF — which covers what Excel, Numbers and Google Sheets emit.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const source = String(text ?? '').replace(/^﻿/, '');

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }

  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

/** Match a spreadsheet heading back to an ingredient, tolerantly. */
function normaliseHeading(value) {
  return String(value ?? '')
    .replace(/\(.*?\)/g, '')     // drop the "(kg)" the template adds
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

function parseDate(value) {
  const raw = String(value ?? '').trim();
  if (isDay(raw)) return raw;

  // Spreadsheets love to reformat dates. Accept the common variants rather
  // than rejecting a file over punctuation.
  const slash = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (slash) {
    const [, a, b, year] = slash;
    // Day-first, which is the convention everywhere this will be used.
    const day = String(a).padStart(2, '0');
    const month = String(b).padStart(2, '0');
    const candidate = `${year}-${month}-${day}`;
    if (isDay(candidate)) return candidate;
  }

  const iso = raw.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
  if (iso) {
    const candidate = `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
    if (isDay(candidate)) return candidate;
  }

  return null;
}

/**
 * Validate an uploaded sheet and report exactly what would happen. With
 * `apply: true` the same validated plan is written.
 */
export async function importDays(ctx) {
  const body = await readJson(ctx.request);
  const csv = str(body.csv, 'File contents', { required: true, max: 2_000_000 });
  const apply = bool(body.apply, false);
  const markSubmitted = bool(body.submit, true);
  const overwrite = bool(body.overwrite, false);

  const rows = parseCsv(csv);
  if (rows.length < 2) throw badRequest('That file has no data rows.');

  const header = rows[0].map((h) => String(h).trim());
  const dateIndex = header.findIndex((h) => normaliseHeading(h) === 'date');
  if (dateIndex === -1) throw badRequest('No "Date" column found. Start from the template.');

  const inhouseIndex = header.findIndex((h) => normaliseHeading(h).startsWith('inhouse'));
  const outsideIndex = header.findIndex((h) => normaliseHeading(h).startsWith('outside'));
  const noteIndex = header.findIndex((h) => normaliseHeading(h) === 'note');

  const ingredientRows = await ctx.db.prepare(
    'SELECT id, name, unit, is_core, active FROM ingredients WHERE active = 1',
  ).all();
  const ingredients = ingredientRows.results ?? [];
  const byNormalised = new Map(ingredients.map((i) => [normaliseHeading(i.name), i]));

  // Map each spreadsheet column onto an ingredient.
  const columnMap = [];
  const unknownColumns = [];
  header.forEach((heading, index) => {
    if ([dateIndex, inhouseIndex, outsideIndex, noteIndex].includes(index)) return;
    const key = normaliseHeading(heading);
    if (!key) return;
    const ing = byNormalised.get(key);
    if (ing) columnMap.push({ index, ingredient: ing });
    else unknownColumns.push(heading);
  });

  const existingRows = await ctx.db.prepare('SELECT day, submitted_at FROM service_days').all();
  const existing = new Map((existingRows.results ?? []).map((r) => [r.day, r]));

  const plan = [];
  const errors = [];
  const seen = new Set();

  rows.slice(1).forEach((cells, offset) => {
    const lineNumber = offset + 2; // 1-based, and the header is line 1
    const day = parseDate(cells[dateIndex]);

    if (!day) {
      errors.push({ line: lineNumber, message: `"${cells[dateIndex] ?? ''}" is not a date the importer recognises` });
      return;
    }
    if (seen.has(day)) {
      errors.push({ line: lineNumber, message: `${day} appears more than once in this file` });
      return;
    }
    seen.add(day);

    const readNumber = (index, label) => {
      if (index === -1) return null;
      const raw = String(cells[index] ?? '').trim().replace(/,/g, '');
      if (raw === '') return null;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        errors.push({ line: lineNumber, message: `${label} is "${cells[index]}", which is not a number` });
        return null;
      }
      return value;
    };

    const inhouse = readNumber(inhouseIndex, 'In-house guests') ?? 0;
    const outside = readNumber(outsideIndex, 'Outside guests') ?? 0;

    const usage = {};
    let filled = 0;
    for (const { index, ingredient } of columnMap) {
      const value = readNumber(index, ingredient.name);
      if (value == null) continue;
      usage[ingredient.id] = value;
      filled += 1;
    }

    const missingCore = ingredients.filter((i) => i.is_core && usage[i.id] == null);

    plan.push({
      line: lineNumber,
      day,
      inhouse,
      outside,
      note: noteIndex === -1 ? null : (String(cells[noteIndex] ?? '').trim() || null),
      usage,
      filled,
      exists: existing.has(day),
      wasSubmitted: Boolean(existing.get(day)?.submitted_at),
      missingCore: missingCore.map((i) => i.name),
    });
  });

  const { writable, blocked } = await partitionByLock(ctx.db, plan.map((p) => p.day));
  const writableSet = new Set(writable);
  const lockedByDay = new Map(blocked.map((b) => [b.day, b.lock]));

  for (const row of plan) {
    row.locked = lockedByDay.get(row.day) ?? null;
    row.skipped = Boolean(row.locked) || (row.exists && !overwrite);
    if (row.exists && !overwrite && !row.locked) row.skipReason = 'already recorded';
    else if (row.locked) row.skipReason = `closed period (${row.locked})`;
  }

  const toWrite = plan.filter((p) => !p.skipped);

  const summary = {
    rowsRead: plan.length,
    willWrite: toWrite.length,
    willSkip: plan.length - toWrite.length,
    alreadyRecorded: plan.filter((p) => p.exists).length,
    lockedOut: blocked.length,
    unknownColumns,
    matchedColumns: columnMap.length,
    dateRange: plan.length
      ? { from: plan.map((p) => p.day).sort()[0], to: plan.map((p) => p.day).sort().at(-1) }
      : null,
    incompleteRows: toWrite.filter((p) => p.missingCore.length).length,
    errors,
  };

  if (!apply) {
    return json({
      preview: true,
      summary,
      rows: plan.slice(0, 200),
      canApply: toWrite.length > 0 && errors.length === 0,
    });
  }

  if (errors.length) {
    throw badRequest(`Fix the ${errors.length} problem${errors.length === 1 ? '' : 's'} in the file first.`, errors.slice(0, 20));
  }
  if (!toWrite.length) throw badRequest('There is nothing to import — every row was skipped.');

  const feeRow = await ctx.db.prepare("SELECT value FROM settings WHERE key = 'outsider_fee'").first();
  const currentFee = Number(feeRow?.value) || 0;
  const actor = `${ctx.session.user.name} (${ctx.session.user.role})`;

  const statements = [];
  for (const row of toWrite) {
    if (!writableSet.has(row.day)) continue;
    statements.push(
      ctx.db.prepare(
        `INSERT INTO service_days (day, inhouse_guests, outside_guests, outsider_fee, note, submitted_at, submitted_by, updated_at)
         VALUES (?1, ?2, ?3, COALESCE((SELECT outsider_fee FROM service_days WHERE day = ?1), ?4), ?5,
                 CASE WHEN ?6 = 1 THEN datetime('now') ELSE NULL END, ?7, datetime('now'))
         ON CONFLICT(day) DO UPDATE SET
           inhouse_guests = ?2,
           outside_guests = ?3,
           note           = ?5,
           submitted_at   = CASE WHEN ?6 = 1 THEN datetime('now') ELSE service_days.submitted_at END,
           submitted_by   = ?7,
           updated_at     = datetime('now')`,
      ).bind(row.day, row.inhouse, row.outside, currentFee, row.note, markSubmitted ? 1 : 0, `${actor} · import`),
    );

    for (const [ingredientId, qty] of Object.entries(row.usage)) {
      statements.push(
        ctx.db.prepare(
          `INSERT INTO usage (day, ingredient_id, qty, updated_at)
           VALUES (?1, ?2, ?3, datetime('now'))
           ON CONFLICT(day, ingredient_id) DO UPDATE SET qty = ?3, updated_at = datetime('now')`,
        ).bind(row.day, Number(ingredientId), qty),
      );
    }
  }

  statements.push(
    ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)').bind(
      actor,
      'days.import',
      summary.dateRange ? `${summary.dateRange.from}..${summary.dateRange.to}` : null,
      JSON.stringify({ written: toWrite.length, skipped: summary.willSkip, overwrite }),
    ),
  );

  // D1 caps how much goes into one batch; chunk so a large backlog still lands.
  const CHUNK = 200;
  for (let i = 0; i < statements.length; i += CHUNK) {
    await ctx.db.batch(statements.slice(i, i + CHUNK));
  }

  return json({
    preview: false,
    applied: true,
    summary,
    written: toWrite.length,
  });
}
