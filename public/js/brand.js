/**
 * Which of the two sites this is.
 *
 * The same files are served by two separate Workers on two hostnames: the
 * breakfast site and the housekeeping site. Each has its own database and its
 * own people, and each carries its own sections and only its own — the bed
 * check is not on the breakfast site, and the kitchen is not on this one.
 *
 * What this decides is only the name and the mark: a housekeeper who put "Bed
 * Check" on their home screen should not be greeted by a frying pan, and a cook
 * should not be greeted by a bed.
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
