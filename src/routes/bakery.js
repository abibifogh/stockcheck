import {
  badRequest, forbidden, json, notFound, num, readJson, str,
} from '../lib/http.js';
import { isDay, todayIn } from '../util/dates.js';
import { announce, readSettings } from '../lib/notify.js';

/**
 * Bread produced in-house.
 *
 * Two ways in, and they land in the same place. A named baker can sign in like
 * anybody else; more usefully, an administrator can hand the bakery a link and
 * the bakery never needs an account at all — which is the difference between a
 * report after every cycle and a report when somebody remembers the PIN.
 *
 * The link is deliberately narrow. It opens one form, listing only the items
 * marked as produced, and the only thing it can do is add stock. It cannot
 * read a cost, a guest count or anything else in the system.
 */

const encoder = new TextEncoder();

function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Tokens are stored hashed, never in the clear.
 *
 * A link that leaks can be revoked and reissued; a link kept in plain text in
 * the database would be readable by anybody who ever gets a look at a backup.
 * No salt and no stretching: this is a 192-bit random string, not a password,
 * so there is nothing to guess and nothing to look up in a rainbow table.
 */
async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(token)));
  return b64url(new Uint8Array(digest));
}

function newToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(24)));
}

async function audit(db, actor, action, entity, detail) {
  await db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(actor, action, entity == null ? null : String(entity), detail ? JSON.stringify(detail) : null)
    .run().catch(() => {});
}

/**
 * Resolve a link token to the link it belongs to.
 *
 * Returns null for anything unknown, revoked or malformed — the caller must
 * not be able to tell those apart, or the endpoint becomes a way to find out
 * which tokens exist.
 */
async function linkFor(db, token) {
  const value = String(token ?? '').trim();
  if (!value || value.length > 128) return null;

  const row = await db.prepare(
    'SELECT * FROM bakery_links WHERE token_hash = ? AND active = 1',
  ).bind(await hashToken(value)).first();
  return row ?? null;
}

/** The items a bakery reports on, and nothing else. */
async function producedItems(db) {
  const rows = await db.prepare(
    `SELECT id, name, unit, step, default_unit_cost, is_bistro
       FROM ingredients WHERE is_produced = 1 AND active = 1
      ORDER BY sort_order, name`,
  ).all();
  return rows.results ?? [];
}

/**
 * A gentle throttle on the public endpoints.
 *
 * Not a security boundary — the token is the boundary. This exists so a
 * mistyped link in a loop, or somebody idly guessing, cannot fill the
 * production table or burn through the day's request budget.
 */
const attempts = new Map();
function throttle(ip, limit = 40) {
  const now = Date.now();
  const window = 60_000;
  const record = attempts.get(ip);
  if (!record || now - record.since > window) {
    attempts.set(ip, { since: now, count: 1 });
    return true;
  }
  record.count += 1;
  if (attempts.size > 500) attempts.clear();
  return record.count <= limit;
}

// ---------------------------------------------------------------------------
// The public link
// ---------------------------------------------------------------------------

/**
 * Open the form behind a link.
 *
 * POST rather than GET so the token travels in a body instead of a URL that
 * ends up in server logs and browser history.
 */
export async function open(ctx) {
  const ip = ctx.request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!throttle(ip)) {
    return json({ error: 'Too many attempts. Wait a minute and try again.' }, { status: 429 });
  }

  const body = await readJson(ctx.request);
  const link = await linkFor(ctx.db, body.token);
  if (!link) {
    // Deliberately vague and deliberately identical for "never existed" and
    // "revoked": the bakery needs to ask for a new link either way.
    await new Promise((resolve) => setTimeout(resolve, 250));
    throw forbidden('This link is not valid any more. Ask for a new one.');
  }

  const settings = await readSettings(ctx.db);
  const today = todayIn(settings.timezone || 'Africa/Accra');
  const items = await producedItems(ctx.db);

  // What this link has already sent today, so a baker can see at a glance
  // whether the last cycle went in — the commonest question they will have.
  const recent = await ctx.db.prepare(
    `SELECT p.day, p.at, p.cycle, p.qty, p.destination, i.name, i.unit
       FROM production p JOIN ingredients i ON i.id = p.ingredient_id
      WHERE p.link_id = ? AND p.day >= ?
      ORDER BY p.id DESC LIMIT 30`,
  ).bind(link.id, today).all().catch(() => ({ results: [] }));

  return json({
    ok: true,
    label: link.label,
    propertyName: settings.property_name || 'Breakfast',
    today,
    items: items.map((i) => ({
      id: i.id, name: i.name, unit: i.unit, step: Number(i.step) || 1,
      bistro: Boolean(i.is_bistro),
    })),
    recent: (recent.results ?? []).map((r) => ({
      day: r.day, at: r.at, cycle: r.cycle, name: r.name, unit: r.unit,
      qty: Number(r.qty), destination: r.destination ?? 'breakfast',
    })),
  });
}

/**
 * Record one production cycle.
 *
 * Everything in one request, and nothing partially written: a half-recorded
 * run puts bread on the shelf that the morning sheet will then fail to find.
 */
export async function submit(ctx) {
  const ip = ctx.request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!throttle(ip)) {
    return json({ error: 'Too many attempts. Wait a minute and try again.' }, { status: 429 });
  }

  const body = await readJson(ctx.request);
  const link = await linkFor(ctx.db, body.token);
  if (!link) throw forbidden('This link is not valid any more. Ask for a new one.');

  const result = await record(ctx, {
    body,
    producedBy: body.baker ? str(body.baker, 'Name', { max: 60 }) : link.label,
    linkId: link.id,
  });

  await ctx.db.prepare(
    "UPDATE bakery_links SET last_used_at = datetime('now'), use_count = use_count + 1 WHERE id = ?",
  ).bind(link.id).run().catch(() => {});

  return result;
}

// ---------------------------------------------------------------------------
// Signed-in bakers
// ---------------------------------------------------------------------------

/** The same form, for somebody who has an account. */
export async function form(ctx) {
  const settings = await readSettings(ctx.db);
  const today = todayIn(settings.timezone || 'Africa/Accra');
  const items = await producedItems(ctx.db);

  const recent = await ctx.db.prepare(
    `SELECT p.id, p.day, p.at, p.cycle, p.qty, p.produced_by, i.name, i.unit
       FROM production p JOIN ingredients i ON i.id = p.ingredient_id
      ORDER BY p.id DESC LIMIT 40`,
  ).all();

  return json({
    today,
    propertyName: settings.property_name || 'Breakfast',
    items: items.map((i) => ({
      id: i.id, name: i.name, unit: i.unit, step: Number(i.step) || 1,
      bistro: Boolean(i.is_bistro),
    })),
    recent: (recent.results ?? []).map((r) => ({
      id: r.id, day: r.day, at: r.at, cycle: r.cycle, name: r.name,
      unit: r.unit, qty: Number(r.qty), producedBy: r.produced_by,
    })),
  });
}

export async function create(ctx) {
  return record(ctx, { body: await readJson(ctx.request), producedBy: ctx.session.user.name });
}

/**
 * The shared write path.
 *
 * One place decides what a valid production run is, so a link and a signed-in
 * baker cannot drift into meaning different things.
 */
async function record(ctx, { body, producedBy, linkId = null }) {
  const settings = await readSettings(ctx.db);
  const today = todayIn(settings.timezone || 'Africa/Accra');

  const day = body.day && isDay(body.day) ? body.day : today;
  if (day > today) throw badRequest('A production run cannot be dated in the future.');

  const cycle = str(body.cycle, 'Cycle', { max: 40, fallback: '' }) || null;
  const note = str(body.note, 'Note', { max: 300, fallback: '' }) || null;

  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw badRequest('Enter how many of at least one thing came out.');
  if (lines.length > 50) throw badRequest('That is more lines than this form takes.');

  // id -> { breakfast, bistro }. One oven, two destinations: what the kitchen
  // can draw against in the morning, and what left for the bistro.
  const wanted = new Map();
  for (const line of lines) {
    const id = Number(line.ingredientId ?? line.itemId);
    if (!Number.isFinite(id) || id <= 0) throw badRequest('An item was not recognised.');
    const breakfast = num(line.qty, 'Quantity', { min: 0, max: 1000000 });
    const bistro = num(line.bistroQty, 'Bistro quantity', { min: 0, max: 1000000 });
    // Zero is a real answer — "we baked none of that" — and simply has nothing
    // to record.
    if (breakfast <= 0 && bistro <= 0) continue;
    const row = wanted.get(id) ?? { breakfast: 0, bistro: 0 };
    row.breakfast += breakfast;
    row.bistro += bistro;
    wanted.set(id, row);
  }
  if (!wanted.size) throw badRequest('Every quantity was zero. Nothing to record.');

  // Costs come from the item, not from the form. The baker knows how many came
  // out of the oven; what a loaf costs to make is a standing figure a manager
  // sets, and asking a bakery for it would get a guess.
  const holes = [...wanted.keys()].map(() => '?').join(',');
  const rows = await ctx.db.prepare(
    `SELECT id, name, default_unit_cost, is_bistro FROM ingredients
      WHERE id IN (${holes}) AND is_produced = 1 AND active = 1`,
  ).bind(...wanted.keys()).all();

  const known = new Map((rows.results ?? []).map((r) => [r.id, r]));
  if (known.size !== wanted.size) {
    throw badRequest('Something on this form is no longer on the bakery list. Reload and try again.');
  }

  // The form only shows a Bistro box against the items the bistro takes. This
  // says the same thing where it counts: a stale page open since before
  // somebody unticked one must not be able to file against it.
  for (const [id, qty] of wanted) {
    if (qty.bistro > 0 && !known.get(id).is_bistro) {
      throw badRequest(`${known.get(id).name} is not one of the bistro's. Reload and try again.`);
    }
  }

  const inserts = [];
  for (const [id, qty] of wanted) {
    for (const [destination, amount] of [['breakfast', qty.breakfast], ['bistro', qty.bistro]]) {
      if (amount <= 0) continue;
      inserts.push(ctx.db.prepare(
        `INSERT INTO production (day, cycle, ingredient_id, qty, unit_cost, note, produced_by, link_id, destination)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(
        day, cycle, id, amount, Number(known.get(id).default_unit_cost) || 0,
        note, producedBy, linkId, destination,
      ));
    }
  }

  // A second report for the same day replaces the first rather than adding to
  // it. With one bake a day, a second send is somebody correcting a number or
  // wondering whether the first went through — and adding would put bread on
  // the shelf that never existed, which the kitchen finds a week later as a
  // shortfall it cannot explain.
  //
  // Scoped to whoever is reporting, not to the day: two bakeries with their own
  // links each replace their own report, and neither can wipe the other's.
  const clear = linkId
    ? ctx.db.prepare('DELETE FROM production WHERE day = ? AND link_id = ?').bind(day, linkId)
    : ctx.db.prepare('DELETE FROM production WHERE day = ? AND link_id IS NULL').bind(day);

  const written = await ctx.db.batch([clear, ...inserts]);
  const replaced = Number(written?.[0]?.meta?.changes) || 0;

  await audit(ctx.db, producedBy ?? 'Bakery link', 'production.record', null, {
    day, cycle, lines: wanted.size, viaLink: Boolean(linkId), replaced,
  });

  const part = (pick) => [...wanted.entries()]
    .filter(([, qty]) => qty[pick] > 0)
    .map(([id, qty]) => `${qty[pick]} ${known.get(id).name}`)
    .join(', ');

  const summary = part('breakfast') || 'nothing for breakfast';
  const bistroSummary = part('bistro');

  if (settings.notify_production !== '0') {
    const task = announce(ctx.db, ctx.env, {
      kind: 'production',
      audience: 'stock',
      title: `Bakery: ${summary}`,
      body: `${producedBy || 'The bakery'} reported a bake on ${day}`
        + `${replaced ? ', replacing what was sent earlier that day' : ''}.`
        + ' It is on the breakfast shelf now.'
        + (bistroSummary ? ` A further ${bistroSummary} went to the bistro, which breakfast does not carry.` : ''),
      link: '#/production',
      linkLabel: 'See the bakery log',
    });
    if (ctx.executionContext?.waitUntil) ctx.executionContext.waitUntil(task);
    else await task.catch(() => {});
  }

  return json({
    ok: true,
    day,
    cycle,
    recorded: wanted.size,
    replaced,
    summary,
    bistroSummary: bistroSummary || null,
    lines: [...wanted.entries()].map(([id, qty]) => ({
      name: known.get(id).name, qty: qty.breakfast, bistroQty: qty.bistro,
    })),
  }, { status: 201 });
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

/** What the bakery has sent, and what it added to the shelf. */
export async function log(ctx) {
  const from = ctx.url.searchParams.get('from');
  const to = ctx.url.searchParams.get('to');
  const where = [];
  const binds = [];
  if (from && isDay(from)) { where.push('p.day >= ?'); binds.push(from); }
  if (to && isDay(to)) { where.push('p.day <= ?'); binds.push(to); }

  const rows = await ctx.db.prepare(
    `SELECT p.*, i.name, i.unit, l.label AS link_label
       FROM production p
       JOIN ingredients i ON i.id = p.ingredient_id
       LEFT JOIN bakery_links l ON l.id = p.link_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.day DESC, p.id DESC LIMIT 300`,
  ).bind(...binds).all();

  const runs = (rows.results ?? []).map((r) => ({
    id: r.id,
    day: r.day,
    at: r.at,
    cycle: r.cycle,
    ingredientId: r.ingredient_id,
    name: r.name,
    unit: r.unit,
    qty: Number(r.qty),
    destination: r.destination ?? 'breakfast',
    unitCost: Number(r.unit_cost) || 0,
    value: Math.round(Number(r.qty) * (Number(r.unit_cost) || 0) * 100) / 100,
    note: r.note,
    producedBy: r.produced_by,
    viaLink: Boolean(r.link_id),
    linkLabel: r.link_label,
  }));

  // Grouped by day and cycle, which is how a manager reads it: "did the night
  // run go in?" rather than "what happened to item 7".
  const byCycle = new Map();
  for (const run of runs) {
    const key = `${run.day}|${run.cycle ?? ''}`;
    if (!byCycle.has(key)) {
      byCycle.set(key, {
        day: run.day, cycle: run.cycle, at: run.at, producedBy: run.producedBy,
        items: 0, qty: 0, value: 0,
      });
    }
    const group = byCycle.get(key);
    group.items += 1;
    group.qty = Math.round((group.qty + run.qty) * 1000) / 1000;
    group.value = Math.round((group.value + run.value) * 100) / 100;
  }

  return json({ runs, cycles: [...byCycle.values()] });
}

/**
 * Take a line back out.
 *
 * Deleting rather than voiding, unlike a shop sale: nobody paid for this and
 * there is no drawer to reconcile. The audit log keeps the record, and leaving
 * a wrong figure in would mean the morning sheet deducting from bread that was
 * never baked.
 */
export async function remove(ctx, id) {
  const row = await ctx.db.prepare('SELECT * FROM production WHERE id = ?').bind(Number(id)).first();
  if (!row) throw notFound('That entry has already gone.');

  await ctx.db.prepare('DELETE FROM production WHERE id = ?').bind(row.id).run();
  await audit(ctx.db, `${ctx.session.user.name} (${ctx.session.user.role})`, 'production.delete', id, {
    day: row.day, cycle: row.cycle, ingredientId: row.ingredient_id, qty: row.qty,
  });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export async function listLinks(ctx) {
  const rows = await ctx.db.prepare(
    'SELECT * FROM bakery_links ORDER BY active DESC, id DESC',
  ).all();

  const settings = await readSettings(ctx.db);

  return json({
    // Where a link points. Falls back to whatever the browser is on, so the
    // link is still copyable before anybody fills in the site address.
    siteUrl: settings.site_url?.trim().replace(/\/+$/, '') || null,
    links: (rows.results ?? []).map((r) => ({
      id: r.id,
      label: r.label,
      hint: r.token_hint,
      active: Number(r.active) === 1,
      createdBy: r.created_by,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      useCount: Number(r.use_count) || 0,
    })),
  });
}

/**
 * Issue a link.
 *
 * The token is returned exactly once, here. It is never stored in a form that
 * could be read back, so if it is lost the answer is to issue another one and
 * revoke this — which takes ten seconds and is the right habit anyway.
 */
export async function createLink(ctx) {
  const body = await readJson(ctx.request);
  const label = str(body.label, 'Name', { required: true, max: 60 });

  const token = newToken();
  const row = await ctx.db.prepare(
    `INSERT INTO bakery_links (label, token_hash, token_hint, created_by)
     VALUES (?1, ?2, ?3, ?4) RETURNING id`,
  ).bind(label, await hashToken(token), token.slice(-4), ctx.session.user.name).first();

  await audit(ctx.db, `${ctx.session.user.name} (${ctx.session.user.role})`, 'bakery.link.create', row.id, { label });

  const settings = await readSettings(ctx.db);
  const site = settings.site_url?.trim().replace(/\/+$/, '') || '';

  return json({
    ok: true,
    id: row.id,
    label,
    token,
    // The whole point of the feature: something to send the bakery.
    url: `${site || new URL(ctx.request.url).origin}/bake?t=${token}`,
  }, { status: 201 });
}

/** Revoke a link. The production it already sent stays exactly where it is. */
export async function revokeLink(ctx, id) {
  const result = await ctx.db.prepare(
    'UPDATE bakery_links SET active = 0 WHERE id = ? AND active = 1',
  ).bind(Number(id)).run();
  if (!result.meta?.changes) throw notFound('That link is already revoked.');

  await audit(ctx.db, `${ctx.session.user.name} (${ctx.session.user.role})`, 'bakery.link.revoke', id, null);
  return json({ ok: true });
}
