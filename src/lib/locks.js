import { HttpError } from './http.js';

/**
 * Closed periods.
 *
 * Once a month has been reported on, its numbers should stop moving. A lock
 * makes that a rule rather than a convention: every write that touches a day
 * inside a locked range is refused, whoever is asking. Only an administrator
 * can lift a lock, and lifting one is recorded.
 */

export async function locksFor(db) {
  const rows = await db.prepare('SELECT * FROM period_locks ORDER BY from_day').all();
  return rows.results ?? [];
}

/** The lock covering a day, or null. */
export function lockCovering(locks, day) {
  return locks.find((l) => day >= l.from_day && day <= l.to_day) ?? null;
}

/** Every lock overlapping a range. */
export function locksOverlapping(locks, from, to) {
  return locks.filter((l) => !(l.to_day < from || l.from_day > to));
}

function describe(lock) {
  const range = lock.from_day === lock.to_day
    ? lock.from_day
    : `${lock.from_day} to ${lock.to_day}`;
  return lock.reason ? `${range} (${lock.reason})` : range;
}

/**
 * Refuse a write that falls inside a closed period. Throws 409 rather than 403:
 * the person may well have permission, it is the date that is closed.
 */
export async function assertDayWritable(db, day) {
  const lock = lockCovering(await locksFor(db), day);
  if (lock) {
    throw new HttpError(
      409,
      `${day} is inside a closed period — ${describe(lock)}. An administrator must unlock it first.`,
      { lock },
    );
  }
}

/** The same check for an operation spanning several days. */
export async function assertRangeWritable(db, from, to) {
  const overlapping = locksOverlapping(await locksFor(db), from, to);
  if (overlapping.length) {
    throw new HttpError(
      409,
      `That range overlaps a closed period — ${describe(overlapping[0])}. An administrator must unlock it first.`,
      { locks: overlapping },
    );
  }
}

/** Filter a list of days down to the ones that may still be written. */
export async function partitionByLock(db, days) {
  const locks = await locksFor(db);
  const writable = [];
  const blocked = [];
  for (const day of days) {
    const lock = lockCovering(locks, day);
    if (lock) blocked.push({ day, lock: describe(lock) });
    else writable.push(day);
  }
  return { writable, blocked };
}
