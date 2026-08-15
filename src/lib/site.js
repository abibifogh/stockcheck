/**
 * Which site this Worker is running as.
 *
 * One codebase serves two deployments. The breakfast site carries everything —
 * the morning sheet, the parts store and the bed check — because the people who
 * run a hotel move between all three. The housekeeping site carries only the bed
 * check, because the people who run a hostel dorm have no use for the other two
 * and every extra menu item is one more thing to explain to somebody on their
 * first morning.
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
  // The bakery and its public link. Same reasoning: a hostel deployment has no
  // oven, and an endpoint that exists is a promise.
  '/api/bakery',
  '/api/production',
];

/**
 * A prefix matches the path itself or anything below it, and nothing else.
 *
 * Matching on the bare characters would make `/api/import` swallow a future
 * `/api/importantthing` — an endpoint that exists everywhere except here, for
 * no reason anybody would ever guess.
 */
export function servesPath(site, pathname) {
  if (site !== 'housekeeping') return true;
  return !FULL_SITE_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
