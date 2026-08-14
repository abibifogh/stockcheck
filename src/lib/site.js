/**
 * Which site this Worker is running as.
 *
 * One codebase serves three deployments, each its own Worker on its own
 * hostname with its own database:
 *
 *   full            the hotel: the morning sheet, the parts store, the craft
 *                   shop, the bakery and the bed check. Everything, because the
 *                   people who run a hotel move between all of it.
 *   housekeeping    the bed check alone, for a hostel dorm.
 *   correspondence  the accounting practice: the register, engagements, action
 *                   points and meetings. Nothing to do with a hotel, and it
 *                   shares only what every deployment needs — signing in,
 *                   people, notifications.
 *
 * Set by `APP_SITE` in the Worker's configuration rather than read from the
 * hostname: a preview address, a custom domain and a workers.dev URL all point
 * at the same deployment, and which sections exist should not depend on which
 * of them somebody typed.
 */

const SITES = new Set(['housekeeping', 'correspondence']);

export function siteOf(env) {
  return SITES.has(env?.APP_SITE) ? env.APP_SITE : 'full';
}

/**
 * The API belonging to the hotel: the breakfast unit, the parts store, the
 * craft shop, the bakery.
 *
 * Listed as prefixes, so `/api/purchases/last-costs` travels with
 * `/api/purchases`. A single-purpose deployment answers 404 to all of it — not
 * because it would do any harm (that site reads its own database, where those
 * tables are empty) but because an endpoint that exists is a promise, and this
 * one is not being kept.
 */
export const HOTEL_PATHS = [
  '/api/days',
  '/api/revisions',
  '/api/import',
  '/api/insights',
  '/api/export',
  '/api/stock-counts',
  '/api/purchases',
  '/api/deliveries',
  '/api/categories',
  '/api/ingredients',
  '/api/suppliers',
  '/api/mx',
  '/api/shop',
  '/api/bakery',
  '/api/production',
];

/** Kept under its old name: `FULL_SITE_PATHS` is what the tests import. */
export const FULL_SITE_PATHS = HOTEL_PATHS;

export const HOUSEKEEPING_PATHS = ['/api/hk'];
export const CORRESPONDENCE_PATHS = ['/api/co'];

/**
 * Shared endpoints that are nonetheless about the hotel.
 *
 * "Erase a period" counts and deletes day sheets, bed checks and stock — a
 * vocabulary the practice does not have. Its equivalent is retention review,
 * which lists what is past its keeping period and lets a person decide, because
 * an accounting file is not something a date range should be able to sweep away.
 */
const HOTEL_SHARED_PATHS = ['/api/data'];

/**
 * What each site does *not* serve.
 *
 * Written as "everything except mine" rather than an allowlist, because the
 * shared endpoints — signing in, people, the bell, push — have no prefix in
 * common and listing them per site would mean adding a new one in three places
 * and forgetting the third.
 */
const HIDDEN = {
  // The hotel keeps all of its own sections and does not carry the practice.
  // Its database has no correspondence tables, so those endpoints would answer
  // "the schema has not been applied" — which reads as a broken deployment
  // rather than what it is: an address that was never meant to have them.
  full: [...CORRESPONDENCE_PATHS],
  housekeeping: [...HOTEL_PATHS, ...CORRESPONDENCE_PATHS],
  correspondence: [...HOTEL_PATHS, ...HOUSEKEEPING_PATHS, ...HOTEL_SHARED_PATHS],
};

/**
 * A prefix matches the path itself or anything below it, and nothing else.
 *
 * Matching on the bare characters would make `/api/import` swallow a future
 * `/api/importantthing` — an endpoint that exists everywhere except here, for
 * no reason anybody would ever guess.
 */
export function servesPath(site, pathname) {
  const hidden = HIDDEN[site];
  if (!hidden) return true;
  return !hidden.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
