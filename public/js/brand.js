/**
 * Which of the two sites this is.
 *
 * The same files are served by two separate Workers on two hostnames: the
 * breakfast site and the housekeeping site. The data behind them is identical —
 * one database, one set of people — and permissions decide what anybody can
 * reach either way. What differs is only what a person expects when they open
 * it. A housekeeper who put "Bed Check" on their home screen should not be
 * greeted by a frying pan, and a cook should not be greeted by a bed.
 *
 * Matched loosely on the hostname so a *.workers.dev preview of the
 * housekeeping Worker brands itself the same way as the real address.
 *
 * `index.html` makes the same decision, inline and by the same rule, because
 * the tab title and the installed icon are settled before any module runs.
 */
export const BRAND = /housekeeping/.test(location.hostname)
  ? { app: 'housekeeping', mark: '🛏', name: 'Bed Check' }
  : { app: 'breakfast', mark: '🍳', name: 'Breakfast Control' };
