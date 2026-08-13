import { json, readJson } from '../lib/http.js';
import { inboxFor, markRead } from '../lib/notify.js';
import { openDueTasks } from '../lib/stocktakes.js';
import { todayIn } from '../util/dates.js';

/**
 * The bell.
 *
 * Anybody signed in can read their own; there is nothing to gate, because what
 * a person can see is already decided by which permissions they hold.
 */

export async function list(ctx) {
  // A hotel on the free plan may not have cron configured, and a task nobody
  // is told about is worse than no task at all — so the first person to look
  // at their bell after a count falls due is what opens it. Cheap: it only
  // touches rows when something is actually overdue.
  const timezone = await siteTimezone(ctx.db);
  ctx.executionContext?.waitUntil?.(
    openDueTasks(ctx.db, ctx.env, todayIn(timezone)).catch(() => {}),
  );

  const inbox = await inboxFor(ctx.db, ctx.session.user, {
    limit: Number(ctx.url.searchParams.get('limit')) || 30,
  });
  return json(inbox);
}

export async function read(ctx) {
  const body = await readJson(ctx.request).catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : null;
  const marked = await markRead(ctx.db, ctx.session.user, ids);
  return json({ ok: true, marked });
}

async function siteTimezone(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .first()
    .catch(() => null);
  return row?.value || 'UTC';
}
