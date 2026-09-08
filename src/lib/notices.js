import { isMissingTable } from './http.js';

/**
 * In-app notifications.
 *
 * The same events the emails carry, kept where the app can show them: a bell
 * with a count, and a list of what has happened since you last looked. Two
 * reasons it exists alongside the mail rather than instead of it — somebody who
 * lives in the app should not have to open an inbox to find out a check landed,
 * and when the mail fails, this is what still says so.
 *
 * Nothing here ever throws at its caller. A notice is a courtesy; failing to
 * record one must not fail the round that earned it.
 */

const LEVELS = new Set(['info', 'warn', 'high']);

export async function createNotice(db, {
  kind, level = 'info', title, body, link, day, slot, actor, audience = null,
}) {
  if (!kind || !title) return null;
  try {
    const row = await db.prepare(
      `INSERT INTO app_notices (kind, level, title, body, link, day, slot, actor, audience)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING id`,
    ).bind(
      String(kind).slice(0, 40),
      LEVELS.has(level) ? level : 'info',
      String(title).slice(0, 300),
      body == null ? null : String(body).slice(0, 1000),
      link == null ? null : String(link).slice(0, 300),
      day ?? null,
      slot ?? null,
      actor == null ? null : String(actor).slice(0, 120),
      // A permission, or null for everybody. Held rather than resolved to a
      // list of people, so a notice addressed to administrators still reaches
      // somebody promoted tomorrow and stops reaching somebody demoted
      // yesterday.
      audience == null ? null : String(audience).slice(0, 40),
    ).first();
    return row?.id ?? null;
  } catch (err) {
    // A site whose database has not been upgraded yet simply has no bell. That
    // is a missing nicety, not a reason to fail a submitted check.
    if (!isMissingTable(err)) console.error('notice not recorded', err);
    return null;
  }
}

/**
 * What one person should see, and how much of it is new to them.
 *
 * "New" is everything above the last id they acknowledged, which is one integer
 * per person rather than a row per person per notice — the only question ever
 * asked is "anything since I last looked".
 */
export async function listNotices(db, userId, limit = 20, permissions = null) {
  try {
    const want = Math.min(limit, 100);
    const [rows, seen] = await Promise.all([
      // Deliberately over-fetched. The audience filter runs below rather than
      // in SQL, because `audience` may not exist yet on a database that has
      // not run the upgrade and a query naming a missing column fails outright
      // where a missing property simply reads undefined.
      //
      // That means the filter comes after the query, so the query cannot ask
      // for exactly what it needs: taking the newest twenty and then filtering
      // handed somebody nothing at all when the twenty were addressed
      // elsewhere. An approval waiting on an administrator would fall off the
      // bell behind a day of hourly tool sweeps, which is the one notice that
      // must not go quiet.
      db.prepare('SELECT * FROM app_notices ORDER BY id DESC LIMIT ?').bind(want * 10).all(),
      db.prepare('SELECT last_id FROM app_notice_reads WHERE user_id = ?').bind(userId ?? 0).first(),
    ]);

    const lastSeen = Number(seen?.last_id ?? 0);
    // An unaddressed notice is for everybody, which is what every row written
    // before this existed is.
    const mine = (rows.results ?? []).filter(
      (n) => !n.audience || !permissions || permissions.includes(n.audience),
    );
    const notices = mine.slice(0, want);

    return {
      notices: notices.map((n) => ({ ...n, unread: n.id > lastSeen })),
      // Counted over everything addressed to them rather than over the page,
      // so the badge does not disagree with the list it opens.
      unread: mine.filter((n) => n.id > lastSeen).length,
      // The newest id on the list, so marking read cannot acknowledge something
      // that arrived after the page was drawn.
      latestId: notices[0]?.id ?? lastSeen,
      lastSeen,
    };
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    return { notices: [], unread: 0, latestId: 0, lastSeen: 0, unavailable: true };
  }
}

/** Acknowledge up to a given notice. Never moves backwards. */
export async function markSeen(db, userId, lastId) {
  const id = Number(lastId);
  if (!Number.isFinite(id) || id < 0) return;
  try {
    await db.prepare(
      `INSERT INTO app_notice_reads (user_id, last_id, at) VALUES (?1, ?2, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         last_id = MAX(app_notice_reads.last_id, ?2),
         at = datetime('now')`,
    ).bind(userId ?? 0, id).run();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
}

/**
 * The notice for a submitted check.
 *
 * Written to be read at a glance from a list: which check, by whom, and the one
 * number that decides whether anybody needs to move. The detail lives in the
 * report it links to.
 */
export function roundNotice({ slotLabel, day, submittedBy, totals, findings, resubmission }) {
  const untagged = totals?.untagged ?? 0;
  const unexpected = totals?.unexpected ?? 0;

  const parts = [];
  if (untagged) parts.push(`${untagged} without a name tag`);
  if (unexpected) parts.push(`${unexpected} occupied unexpectedly`);
  if (totals?.unchecked) parts.push(`${totals.unchecked} beds not checked`);

  return {
    kind: 'hk_round',
    level: untagged ? 'high' : unexpected ? 'warn' : 'info',
    title: `${slotLabel} submitted${resubmission ? ' again' : ''}`
      + `${submittedBy ? ` by ${submittedBy}` : ''}`,
    body: parts.length
      ? `${totals.checked} beds checked — ${parts.join(', ')}.`
      : `${totals?.checked ?? 0} beds checked, nothing to deal with.`,
    link: `#/hk-report?from=${day}&to=${day}`,
    day,
    actor: submittedBy ?? null,
    findings,
  };
}
