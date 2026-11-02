import {
  HttpError, badRequest, isMissingTable, json, notFound, num, readJson, str,
} from '../lib/http.js';
import { assertDayWritable } from '../lib/locks.js';
import { notify, readSettings } from '../lib/notify.js';
import { pushToPeople } from '../lib/push.js';
import {
  NEEDED, autoReceive, departmentsOf, lastCosts, storeStock,
} from '../lib/store.js';
import { addDays, isDay, todayIn } from '../util/dates.js';

/**
 * The storeroom: departments ask, the storekeeper issues, the department
 * confirms what arrived.
 *
 * Who sees money: whoever issues (`store_issue`) or reads the reports. Somebody
 * who can only ask sees quantities and nothing else — the same line the rest
 * of the system draws for cooks.
 */

const MIGRATION_NEEDED = 'The storeroom needs a database update that has not been run yet: '
  + 'migration 0024_storeroom.sql. Run it in the D1 console, then try again.';

async function guarded(work) {
  try {
    return await work();
  } catch (err) {
    if (isMissingTable(err)) throw new HttpError(409, MIGRATION_NEEDED);
    throw err;
  }
}

/** R-0143: short enough to say across a kitchen. */
export const refOf = (id) => `R-${String(id).padStart(4, '0')}`;

const seesCosts = (ctx) => ['store_issue', 'reports'].some((p) => ctx.session.permissions.includes(p));
const actor = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;
const money = (n) => Math.round(Number(n) * 100) / 100;
const qty = (n) => Math.round(Number(n) * 10000) / 10000;

/** SQLite's datetime('now') is UTC without saying so. Say so. */
const iso = (t) => (t ? `${String(t).replace(' ', 'T')}Z` : null);

function minutesBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((Date.parse(iso(b)) - Date.parse(iso(a))) / 60000);
}

function audit(ctx, action, entity, detail) {
  return ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
    .bind(actor(ctx), action, entity, JSON.stringify(detail));
}

/**
 * Tell people after answering, without making the person wait for it.
 *
 * In the Worker the send carries on after the response; anywhere else (a
 * test) it is simply awaited. Either way a failure to tell somebody never
 * fails the thing they were being told about.
 */
async function later(ctx, task) {
  const safe = task.catch(() => {});
  if (ctx.executionContext?.waitUntil) ctx.executionContext.waitUntil(safe);
  else await safe;
}

/**
 * Requests with their lines, items named.
 *
 * `costs` false strips every money figure before anything leaves the server.
 */
async function loadRequests(db, where, binds, { costs }) {
  const rows = await db.prepare(
    `SELECT * FROM store_requests ${where}`,
  ).bind(...binds).all();
  const requests = rows.results ?? [];
  if (!requests.length) return [];

  const ids = requests.map((r) => r.id);
  const lines = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    // eslint-disable-next-line no-await-in-loop
    const got = await db.prepare(
      `SELECT l.*, i.name, i.unit, i.kind
         FROM store_request_lines l JOIN ingredients i ON i.id = l.ingredient_id
        WHERE l.request_id IN (${chunk.map(() => '?').join(',')})
        ORDER BY l.id`,
    ).bind(...chunk).all();
    lines.push(...(got.results ?? []));
  }
  const byRequest = new Map(ids.map((id) => [id, []]));
  for (const l of lines) byRequest.get(l.request_id)?.push(l);

  return requests.map((r) => {
    const own = byRequest.get(r.id) ?? [];
    const value = own.reduce((sum, l) => sum + (Number(l.issued) || 0) * (Number(l.unit_cost) || 0), 0);
    const issuedLines = own.filter((l) => l.issued != null);
    return {
      id: r.id,
      ref: refOf(r.id),
      department: r.department,
      needed: r.needed,
      neededText: NEEDED[r.needed] ?? r.needed,
      note: r.note,
      status: r.status,
      follows: r.follows ? refOf(r.follows) : null,
      requestedBy: r.requested_by,
      requestedById: r.requested_by_id,
      createdAt: iso(r.created_at),
      issuedBy: r.issued_by,
      issuedAt: iso(r.issued_at),
      day: r.day,
      issueNote: r.issue_note,
      receivedBy: r.received_by,
      receivedAt: iso(r.received_at),
      receivedAuto: Boolean(r.received_auto),
      difference: Boolean(r.difference),
      receiptNote: r.receipt_note,
      closedBy: r.closed_by,
      minutesToIssue: minutesBetween(r.created_at, r.issued_at),
      short: issuedLines.some((l) => Number(l.issued) < Number(l.asked)),
      value: costs && issuedLines.length ? money(value) : undefined,
      lines: own.map((l) => ({
        id: l.id,
        ingredientId: l.ingredient_id,
        name: l.name,
        unit: l.unit,
        kind: l.kind ?? 'food',
        asked: Number(l.asked),
        issued: l.issued == null ? null : Number(l.issued),
        received: l.received == null ? null : Number(l.received),
        shortReason: l.short_reason,
        unitCost: costs ? (l.unit_cost == null ? null : Number(l.unit_cost)) : undefined,
      })),
    };
  });
}

async function oneRequest(ctx, id) {
  const [request] = await loadRequests(ctx.db, 'WHERE id = ?', [Number(id)], { costs: seesCosts(ctx) });
  if (!request) throw notFound('That request no longer exists.');
  return request;
}

// ------------------------------------------------------------- catalogue --

/**
 * What can be asked for, with how much the storeroom holds.
 *
 * Quantities only. "Usual" is what this person asked for most in their last
 * ten requests, so the screen opens on the handful of things they actually
 * order rather than the whole catalogue.
 */
export async function catalog(ctx) {
  return guarded(async () => {
    const settings = await readSettings(ctx.db);
    const [stock, recent] = await Promise.all([
      storeStock(ctx.db),
      ctx.db.prepare(
        `SELECT l.ingredient_id, COUNT(*) AS times
           FROM store_request_lines l
          WHERE l.request_id IN (
            SELECT id FROM store_requests WHERE requested_by_id = ? ORDER BY id DESC LIMIT 10)
          GROUP BY l.ingredient_id ORDER BY times DESC, l.ingredient_id`,
      ).bind(ctx.session.user.id ?? -1).all(),
    ]);
    const costs = seesCosts(ctx);
    const items = stock
      .filter((i) => i.active && i.requestable)
      .map((i) => ({
        id: i.id,
        name: i.name,
        unit: i.unit,
        kind: i.kind,
        category: i.category,
        stock: i.stock,
        low: i.low,
        unitCost: costs ? i.unitCost : undefined,
      }));
    const available = new Set(items.map((i) => i.id));
    return json({
      departments: departmentsOf(settings),
      needed: Object.entries(NEEDED).map(([key, label]) => ({ key, label })),
      items,
      usual: (recent.results ?? []).map((r) => r.ingredient_id).filter((id) => available.has(id)).slice(0, 8),
    });
  });
}

// --------------------------------------------------------------- asking --

export async function createRequest(ctx) {
  const body = await readJson(ctx.request);
  return guarded(async () => {
    const settings = await readSettings(ctx.db);
    const departments = departmentsOf(settings);
    const department = str(body.department, 'Department', { max: 60, fallback: departments[0] }) || departments[0];
    if (!departments.includes(department)) {
      throw badRequest(`“${department}” is not a department here. An administrator sets them under Setup.`);
    }
    const needed = String(body.needed || 'now');
    if (!NEEDED[needed]) throw badRequest('When is it needed: now, today or tomorrow morning?');
    const note = str(body.note, 'Note', { max: 300 });

    const raw = Array.isArray(body.lines) ? body.lines : [];
    // The same item twice is one line asking for both amounts.
    const wanted = new Map();
    raw.forEach((line, i) => {
      const id = Number(line?.ingredient_id);
      if (!Number.isInteger(id) || id < 1) throw badRequest(`Line ${i + 1} has no item.`);
      const amount = num(line.qty, `Line ${i + 1} quantity`, { min: 0, max: 1e5, fallback: 0 });
      if (amount > 0) wanted.set(id, (wanted.get(id) ?? 0) + amount);
    });
    if (!wanted.size) throw badRequest('Add at least one item, with how many.');
    if (wanted.size > 100) throw badRequest('That is a very long request. Split it into two.');

    const allowed = await ctx.db.prepare(
      'SELECT id, name FROM ingredients WHERE active = 1 AND requestable = 1',
    ).all();
    const names = new Map((allowed.results ?? []).map((r) => [r.id, r.name]));
    for (const id of wanted.keys()) {
      if (!names.has(id)) throw badRequest('One of those items can no longer be asked for. Reload and try again.');
    }

    const row = await ctx.db.prepare(
      `INSERT INTO store_requests (department, needed, note, requested_by, requested_by_id)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
    ).bind(department, needed, note, ctx.session.user.name, ctx.session.user.id ?? null).first();

    await ctx.db.batch([
      ...[...wanted].map(([id, amount]) => ctx.db.prepare(
        'INSERT INTO store_request_lines (request_id, ingredient_id, asked) VALUES (?, ?, ?)',
      ).bind(row.id, id, qty(amount))),
      audit(ctx, 'store.request', refOf(row.id), { department, needed, lines: wanted.size }),
    ]);

    // The storekeeper is told now, not when they next look.
    const summary = [...wanted].slice(0, 4).map(([id, amount]) => `${names.get(id)} ${qty(amount)}`).join(', ')
      + (wanted.size > 4 ? ` and ${wanted.size - 4} more` : '');
    const title = `${refOf(row.id)}: ${department} needs ${NEEDED[needed].toLowerCase()}`;
    await later(ctx, Promise.all([
      notify(ctx.db, {
        kind: 'store_request', audience: 'store_issue', level: needed === 'now' ? 'warn' : 'info',
        title, body: `${ctx.session.user.name} asked for ${summary}.`, link: '#/store', actor: ctx.session.user.name,
      }),
      pushToPeople(ctx.db, {
        permission: 'store_issue', title, body: `${ctx.session.user.name}: ${summary}`, url: '#/store', tag: `store-${row.id}`,
      }),
    ]));

    return json({ request: await oneRequest(ctx, row.id) }, { status: 201 });
  });
}

/**
 * Requests, for whichever screen is asking.
 *
 *   view=queue — the storeroom's list: everything waiting, the most urgent
 *                first, and what was issued in the last day.
 *   view=mine  — the departments' list: the last few weeks, newest first.
 */
export async function listRequests(ctx) {
  return guarded(async () => {
    await autoReceive(ctx.db);
    const costs = seesCosts(ctx);
    const view = ctx.url.searchParams.get('view') || 'mine';

    if (view === 'queue') {
      const waiting = await loadRequests(ctx.db,
        `WHERE status = 'waiting'
         ORDER BY CASE needed WHEN 'now' THEN 0 WHEN 'today' THEN 1 ELSE 2 END, created_at, id`, [], { costs });
      const done = await loadRequests(ctx.db,
        `WHERE status IN ('issued', 'received', 'declined') AND issued_at >= datetime('now', '-1 day')
         ORDER BY issued_at DESC LIMIT 50`, [], { costs });
      return json({ waiting, done });
    }

    const requests = await loadRequests(ctx.db,
      "WHERE created_at >= datetime('now', '-30 days') ORDER BY id DESC LIMIT 60", [], { costs });
    return json({ requests });
  });
}

export async function getRequest(ctx, id) {
  return guarded(async () => {
    await autoReceive(ctx.db);
    return json({ request: await oneRequest(ctx, id) });
  });
}

/** Withdraw a request nobody has issued yet. */
export async function cancelRequest(ctx, id) {
  const body = await readJson(ctx.request).catch(() => ({}));
  return guarded(async () => {
    const note = str(body.note, 'Note', { max: 300 });
    const result = await ctx.db.prepare(
      `UPDATE store_requests SET status = 'cancelled', closed_by = ?, closed_at = datetime('now'),
              issue_note = COALESCE(?, issue_note)
        WHERE id = ? AND status = 'waiting'`,
    ).bind(ctx.session.user.name, note, Number(id)).run();
    if (!result.meta?.changes) {
      const request = await oneRequest(ctx, id);
      throw new HttpError(409, `${request.ref} has already been ${request.status}, so it cannot be cancelled.`);
    }
    await audit(ctx, 'store.cancel', refOf(id), { note }).run().catch(() => {});
    return json({ request: await oneRequest(ctx, id) });
  });
}

// -------------------------------------------------------------- issuing --

/**
 * Hand a request over.
 *
 * Body: { lines: [{ id, issued, reason }], note }
 *
 * Every line must be answered. Whatever falls short of what was asked becomes
 * a new waiting request for the rest, so nothing owed is forgotten and the
 * storeroom's list stays "what is still owed". Issuing nothing at all is a
 * decline, and needs a reason.
 *
 * The request is claimed with a conditional update first, so two people
 * pressing Issue at once cannot both issue it.
 */
export async function issueRequest(ctx, id) {
  const body = await readJson(ctx.request);
  return guarded(async () => {
    const request = await oneRequest(ctx, id);
    if (request.status !== 'waiting') {
      throw new HttpError(409, `${request.ref} has already been ${request.status}.`);
    }

    const given = new Map((Array.isArray(body.lines) ? body.lines : []).map((l) => [Number(l?.id), l]));
    const answers = request.lines.map((line) => {
      const answer = given.get(line.id);
      if (!answer) throw badRequest(`Say how much ${line.name} you are issuing — 0 if none.`);
      const issued = qty(num(answer.issued, `${line.name} issued`, { min: 0, max: 1e5, required: true }));
      const reason = str(answer.reason, `${line.name} reason`, { max: 120 });
      if (issued < line.asked && !reason) throw badRequest(`Say why ${line.name} is short.`);
      return { line, issued, reason: issued < line.asked ? reason : null };
    });
    const note = str(body.note, 'Note', { max: 300 });
    const total = answers.reduce((n, a) => n + a.issued, 0);
    if (total <= 0) throw badRequest('Nothing is being issued. To turn the request down, decline it instead.');

    const settings = await readSettings(ctx.db);
    const day = todayIn(settings.timezone || 'UTC');
    await assertDayWritable(ctx.db, day);

    const claimed = await ctx.db.prepare(
      `UPDATE store_requests
          SET status = 'issued', issued_by = ?, issued_at = datetime('now'), day = ?, issue_note = ?
        WHERE id = ? AND status = 'waiting'`,
    ).bind(ctx.session.user.name, day, note, request.id).run();
    if (!claimed.meta?.changes) throw new HttpError(409, `${request.ref} was issued by somebody else a moment ago.`);

    const costs = await lastCosts(ctx.db);
    const fallback = new Map(((await ctx.db.prepare('SELECT id, default_unit_cost FROM ingredients').all()).results ?? [])
      .map((r) => [r.id, Number(r.default_unit_cost) || 0]));
    const value = answers.reduce((sum, a) => {
      const cost = costs.get(a.line.ingredientId) ?? fallback.get(a.line.ingredientId) ?? 0;
      a.unitCost = cost;
      return sum + a.issued * cost;
    }, 0);

    try {
      await ctx.db.batch([
        ...answers.map((a) => ctx.db.prepare(
          'UPDATE store_request_lines SET issued = ?, unit_cost = ?, short_reason = ? WHERE id = ?',
        ).bind(a.issued, a.unitCost, a.reason, a.line.id)),
        audit(ctx, 'store.issue', request.ref, {
          day, value: money(value), lines: answers.map((a) => ({ item: a.line.name, asked: a.line.asked, issued: a.issued })),
        }),
      ]);
    } catch (err) {
      // Put it back, so the storekeeper can try again rather than find it
      // marked issued with nothing on it.
      await ctx.db.prepare(
        "UPDATE store_requests SET status = 'waiting', issued_by = NULL, issued_at = NULL, day = NULL WHERE id = ?",
      ).bind(request.id).run().catch(() => {});
      throw err;
    }

    // What is still owed becomes its own request.
    const owed = answers.filter((a) => a.issued < a.line.asked);
    let followUp = null;
    if (owed.length) {
      const row = await ctx.db.prepare(
        `INSERT INTO store_requests (department, needed, note, follows, requested_by, requested_by_id)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      ).bind(
        request.department, request.needed, `The rest of ${request.ref}`, request.id,
        request.requestedBy, request.requestedById,
      ).first();
      await ctx.db.batch(owed.map((a) => ctx.db.prepare(
        'INSERT INTO store_request_lines (request_id, ingredient_id, asked) VALUES (?, ?, ?)',
      ).bind(row.id, a.line.ingredientId, qty(a.line.asked - a.issued))));
      followUp = refOf(row.id);
    }

    const issuedCount = answers.filter((a) => a.issued > 0).length;
    const title = owed.length
      ? `${request.ref} partly issued: ${issuedCount} of ${answers.length} items`
      : `${request.ref} issued: ${issuedCount} item${issuedCount === 1 ? '' : 's'} ready`;
    const body2 = owed.length
      ? `${ctx.session.user.name} issued it. Still owed (${followUp}): ${owed.map((a) => a.line.name).join(', ')}.`
      : `${ctx.session.user.name} issued it. Please confirm when it arrives.`;
    await later(ctx, Promise.all([
      notify(ctx.db, {
        kind: 'store_issued', audience: 'store_request', title, body: body2, link: '#/ask', actor: ctx.session.user.name,
      }),
      pushToPeople(ctx.db, {
        userIds: request.requestedById ? [request.requestedById] : [], title, body: body2, url: '#/ask', tag: `store-${request.id}`,
      }),
    ]));

    return json({ request: await oneRequest(ctx, request.id), followUp });
  });
}

/** Turn a request down, with the reason. Nothing leaves the shelf. */
export async function declineRequest(ctx, id) {
  const body = await readJson(ctx.request);
  return guarded(async () => {
    const note = str(body.note, 'Reason', { max: 300, required: true });
    const result = await ctx.db.prepare(
      `UPDATE store_requests SET status = 'declined', issued_by = ?, issued_at = datetime('now'), issue_note = ?
        WHERE id = ? AND status = 'waiting'`,
    ).bind(ctx.session.user.name, note, Number(id)).run();
    const request = await oneRequest(ctx, id);
    if (!result.meta?.changes) throw new HttpError(409, `${request.ref} has already been ${request.status}.`);
    await audit(ctx, 'store.decline', request.ref, { note }).run().catch(() => {});

    const title = `${request.ref} declined by the storeroom`;
    await later(ctx, Promise.all([
      notify(ctx.db, { kind: 'store_declined', audience: 'store_request', title, body: note, link: '#/ask' }),
      pushToPeople(ctx.db, {
        userIds: request.requestedById ? [request.requestedById] : [], title, body: note, url: '#/ask', tag: `store-${request.id}`,
      }),
    ]));
    return json({ request });
  });
}

// ------------------------------------------------------------ receiving --

/**
 * The department says what arrived.
 *
 * Body: { lines?: [{ id, received }], note }
 *
 * No lines: everything issued arrived. With lines: any that differ from what
 * was issued are recorded as received, and the request is flagged for the
 * manager. The kitchen's stock follows what it says it received.
 *
 * Also accepted on a request taken as received automatically, so a kitchen
 * that only noticed the next day can still say so.
 */
export async function receiveRequest(ctx, id) {
  const body = await readJson(ctx.request).catch(() => ({}));
  return guarded(async () => {
    const request = await oneRequest(ctx, id);
    const late = request.status === 'received' && request.receivedAuto;
    if (request.status !== 'issued' && !late) {
      throw new HttpError(409, request.status === 'received'
        ? `${request.ref} has already been confirmed by ${request.receivedBy}.`
        : `${request.ref} is ${request.status}, so there is nothing to confirm.`);
    }

    const given = new Map((Array.isArray(body.lines) ? body.lines : []).map((l) => [Number(l?.id), l]));
    const changes = [];
    for (const line of request.lines) {
      const answer = given.get(line.id);
      if (!answer || line.issued == null) continue;
      const received = qty(num(answer.received, `${line.name} received`, { min: 0, max: 1e5, required: true }));
      if (received !== line.issued) changes.push({ line, received });
    }
    const note = str(body.note, 'Note', { max: 300 });
    if (changes.length && !note) throw badRequest('Say what was wrong, so the storeroom can check.');

    await ctx.db.batch([
      ...changes.map((c) => ctx.db.prepare('UPDATE store_request_lines SET received = ? WHERE id = ?')
        .bind(c.received, c.line.id)),
      ctx.db.prepare(
        `UPDATE store_requests
            SET status = 'received', received_by = ?, received_at = datetime('now'), received_auto = 0,
                difference = ?, receipt_note = ?
          WHERE id = ?`,
      ).bind(ctx.session.user.name, changes.length ? 1 : 0, note, request.id),
      audit(ctx, changes.length ? 'store.difference' : 'store.receive', request.ref, {
        note, differences: changes.map((c) => ({ item: c.line.name, issued: c.line.issued, received: c.received })),
      }),
    ]);

    if (changes.length) {
      const title = `${request.ref}: ${request.department} reports a difference`;
      const text = changes.map((c) => `${c.line.name}: issued ${c.line.issued}, received ${c.received}`).join('; ');
      await later(ctx, Promise.all([
        notify(ctx.db, {
          kind: 'store_difference', audience: 'reports', level: 'warn', title, body: `${text}. “${note}”`, link: '#/store-report',
        }),
        pushToPeople(ctx.db, { permission: 'store_issue', title, body: text, url: '#/store', tag: `store-${request.id}` }),
      ]));
    }
    return json({ request: await oneRequest(ctx, request.id) });
  });
}

// ----------------------------------------------------------- the report --

export async function stock(ctx) {
  return guarded(async () => json({ items: await storeStock(ctx.db) }));
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

/**
 * The manager's view of a period: what was asked, issued and used, and what
 * needs a look.
 */
export async function report(ctx) {
  return guarded(async () => {
    await autoReceive(ctx.db);
    const settings = await readSettings(ctx.db);
    const today = todayIn(settings.timezone || 'UTC');
    const to = isDay(ctx.url.searchParams.get('to')) ? ctx.url.searchParams.get('to') : today;
    const from = isDay(ctx.url.searchParams.get('from')) ? ctx.url.searchParams.get('from') : addDays(to, -6);
    if (from > to) throw badRequest('The start of the period is after its end.');

    const requests = await loadRequests(ctx.db,
      `WHERE date(created_at) BETWEEN ? AND ? ORDER BY id DESC`, [from, to], { costs: true });
    const stockRows = await storeStock(ctx.db);

    const handed = requests.filter((r) => r.status === 'issued' || r.status === 'received');
    const minutes = handed.map((r) => r.minutesToIssue).filter((m) => m != null && m >= 0);

    const byItem = new Map();
    const byDepartment = new Map();
    for (const r of handed) {
      for (const l of r.lines) {
        if (!(l.issued > 0)) continue;
        const v = l.issued * (l.unitCost || 0);
        const item = byItem.get(l.ingredientId) ?? { id: l.ingredientId, name: l.name, unit: l.unit, kind: l.kind, qty: 0, value: 0 };
        item.qty = qty(item.qty + l.issued);
        item.value = money(item.value + v);
        byItem.set(l.ingredientId, item);
        byDepartment.set(r.department, money((byDepartment.get(r.department) ?? 0) + v));
      }
    }

    // Short because the shelf was empty, by item: the reorder conversation.
    const shortages = new Map();
    for (const r of requests) {
      for (const l of r.lines) {
        if (l.issued != null && l.issued < l.asked) {
          const s = shortages.get(l.ingredientId) ?? { name: l.name, times: 0, reasons: new Set() };
          s.times += 1;
          if (l.shortReason) s.reasons.add(l.shortReason);
          shortages.set(l.ingredientId, s);
        }
      }
    }

    const now = Date.now();
    const attention = [
      ...requests.filter((r) => r.difference).map((r) => ({
        level: 'high',
        title: `Difference reported on ${r.ref}`,
        detail: `${r.department}: ${r.lines.filter((l) => l.received != null && l.received !== l.issued)
          .map((l) => `${l.name} issued ${l.issued}, received ${l.received}`).join('; ')}`
          + (r.receiptNote ? `. “${r.receiptNote}”` : ''),
        ref: r.ref,
      })),
      ...requests.filter((r) => r.status === 'waiting' && now - Date.parse(r.createdAt) > 60 * 60000).map((r) => ({
        level: 'warn',
        title: `${r.ref} waiting ${Math.round((now - Date.parse(r.createdAt)) / 60000)} minutes`,
        detail: `${r.department} asked, needed ${r.neededText.toLowerCase()}.`,
        ref: r.ref,
      })),
      ...requests.filter((r) => r.receivedAuto).map((r) => ({
        level: 'info',
        title: `${r.ref} was never confirmed`,
        detail: `Issued by ${r.issuedBy}; nobody in ${r.department} confirmed it, so it was taken as received.`,
        ref: r.ref,
      })),
      ...[...shortages.values()].filter((s) => s.times >= 2).map((s) => ({
        level: 'warn',
        title: `${s.name}: short ${s.times} times`,
        detail: [...s.reasons].join(', ') || 'Issued less than asked.',
      })),
    ];

    const counts = {
      requests: requests.filter((r) => r.status !== 'cancelled').length,
      waiting: requests.filter((r) => r.status === 'waiting').length,
      full: handed.filter((r) => !r.short).length,
      partly: handed.filter((r) => r.short).length,
      declined: requests.filter((r) => r.status === 'declined').length,
      cancelled: requests.filter((r) => r.status === 'cancelled').length,
    };

    return json({
      from,
      to,
      currency: settings.currency || 'GHS',
      kitchen: departmentsOf(settings)[0],
      counts,
      minutes: { typical: median(minutes), longest: minutes.length ? Math.max(...minutes) : null },
      value: money([...byItem.values()].reduce((n, i) => n + i.value, 0)),
      byItem: [...byItem.values()].sort((a, b) => b.value - a.value),
      byDepartment: [...byDepartment].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
      attention,
      // Below its par, or out entirely: anything the departments can ask for
      // and the storeroom could not give them today.
      low: stockRows.filter((i) => i.active && i.requestable && i.low),
      requests,
    });
  });
}
