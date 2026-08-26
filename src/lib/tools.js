import { announce, readSettings } from './notify.js';

/**
 * Chasing a tool that has not come back.
 *
 * The rule is one line — out for longer than the grace period and not returned
 * — but the two things around it are where this kind of job goes wrong. It must
 * tell somebody once rather than once an hour until the drill reappears, and it
 * must survive being run twice in the same minute, because a cron that fires
 * twice is an ordinary Tuesday.
 *
 * Both are handled by writing the notice down: `overdue_notified_at` is set in
 * the same sweep that reads it, so a second run finds nothing to say.
 */

/** How long a tool may be out. Hours, so "still out at bedtime" is catchable. */
export function graceHours(settings) {
  const raw = Number(settings?.tool_hours);
  if (!Number.isFinite(raw) || raw <= 0) return 24;
  // A week is already absurd for a hand tool; beyond that somebody has typed
  // a year and would never be told about anything again.
  return Math.min(raw, 24 * 14);
}

/** When a tool issued now is due back, in the format SQLite compares. */
export function dueBackAt(issuedAt, hours) {
  const at = new Date(`${String(issuedAt).replace(' ', 'T')}Z`);
  if (Number.isNaN(at.getTime())) return null;
  return new Date(at.getTime() + hours * 3600 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * How late something is, in words somebody can act on.
 *
 * "2 days" beats "51 hours" for anything past a day: the person reading it is
 * deciding whether to walk down the corridor, not doing arithmetic.
 */
export function overdueBy(dueBackAt, now) {
  const due = new Date(`${String(dueBackAt).replace(' ', 'T')}Z`);
  const at = new Date(`${String(now).replace(' ', 'T')}Z`);
  if (Number.isNaN(due.getTime()) || Number.isNaN(at.getTime())) return '';
  const hours = Math.floor((at.getTime() - due.getTime()) / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Find the tools that are late, and say so once.
 *
 * Returns what it did rather than nothing, so the cron can log it and a test
 * can read it.
 */
export async function chaseOverdueTools(db, env, now) {
  const settings = await readSettings(db);
  if (settings.notify_tool_overdue === '0') return { chased: 0, tools: [] };

  const rows = await db.prepare(
    `SELECT m.id, m.tool_id, m.issued_to, m.issued_at, m.due_back_at,
            t.name AS tool_name, t.tag, a.name AS area_name
       FROM tool_movements m
       JOIN tools t ON t.id = m.tool_id
       LEFT JOIN mx_areas a ON a.id = m.area_id
      WHERE m.returned_at IS NULL
        AND m.overdue_notified_at IS NULL
        AND m.due_back_at <= ?
      ORDER BY m.due_back_at
      LIMIT 50`,
  ).bind(now).all().catch(() => ({ results: [] }));

  const late = rows.results ?? [];
  if (!late.length) return { chased: 0, tools: [] };

  // Marked before the telling, not after. A notification that throws must not
  // leave the row unmarked, or the next sweep chases it again — and being told
  // twice about the same drill is how people learn to ignore the bell.
  await db.batch(late.map((row) => db.prepare(
    "UPDATE tool_movements SET overdue_notified_at = ? WHERE id = ? AND overdue_notified_at IS NULL",
  ).bind(now, row.id)));

  for (const row of late) {
    const where = row.area_name ? ` at ${row.area_name}` : '';
    const task = announce(db, env, {
      kind: 'tool_overdue',
      audience: 'tools_setup',
      title: `${row.tool_name} has not come back`,
      body: `${row.issued_to} took it${where} on ${String(row.issued_at).slice(0, 16)}. `
        + `It was due back ${overdueBy(row.due_back_at, now)} ago.`
        + (row.tag ? ` Tag ${row.tag}.` : ''),
      link: '#/tools',
      linkLabel: 'See what is out',
    });
    await task.catch(() => {});
  }

  return {
    chased: late.length,
    tools: late.map((r) => ({ id: r.tool_id, name: r.tool_name, issuedTo: r.issued_to })),
  };
}
