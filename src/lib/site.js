/**
 * Which site this Worker is running as.
 *
 * One codebase serves two deployments, and each carries its own work and only
 * its own. The breakfast site has the morning sheet and the parts store; the
 * housekeeping site has the bed check. Neither carries the other.
 *
 * The bed check was briefly on both. It reads its own database on its own
 * address, so a hotel manager opening the breakfast site was offered dorm rooms
 * that were never going to have anything in them — a menu item that could only
 * ever disappoint. A section belongs to one site now.
 *
 * Set by `APP_SITE` in the Worker's configuration rather than read from the
 * hostname: a preview address, a custom domain and a workers.dev URL all point
 * at the same deployment, and which sections exist should not depend on which
 * of them somebody typed.
 */
export function siteOf(env) {
  return env?.APP_SITE === 'housekeeping' ? 'housekeeping' : 'full';
}

/**
 * The API belonging to the breakfast unit and the parts store.
 *
 * Listed as prefixes, so `/api/purchases/last-costs` travels with
 * `/api/purchases`. A housekeeping deployment answers 404 to all of it — not
 * because it would do any harm (that site reads its own database, where those
 * tables are empty) but because an endpoint that exists is a promise, and this
 * one is not being kept.
 */
export const FULL_SITE_PATHS = [
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
  // The tool store is the hotel's; a hostel dorm has no artisans borrowing
  // drills, and an endpoint that exists is a promise.
  '/api/tools',
  // The bakery and its public link. Same reasoning: a hostel deployment has no
  // oven, and an endpoint that exists is a promise.
  '/api/bakery',
  '/api/production',
];

/**
 * The bed check's API, which belongs to the housekeeping site.
 *
 * The mirror of the list above, and there for the same reason: the breakfast
 * site has no dorms, so `/api/hk/rooms` there would answer about a database
 * nobody fills in.
 */
export const HOUSEKEEPING_SITE_PATHS = [
  '/api/hk',
];

/**
 * A prefix matches the path itself or anything below it, and nothing else.
 *
 * Matching on the bare characters would make `/api/import` swallow a future
 * `/api/importantthing` — an endpoint that exists everywhere except here, for
 * no reason anybody would ever guess.
 */
export function servesPath(site, pathname) {
  const absent = site === 'housekeeping' ? FULL_SITE_PATHS : HOUSEKEEPING_SITE_PATHS;
  return !absent.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
