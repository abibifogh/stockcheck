/**
 * Which of the three sites this is.
 *
 * The same files are served by three separate Workers on three hostnames: the
 * breakfast site, the housekeeping site, and the accounting practice's
 * correspondence register. What differs is only what a person expects when they
 * open it. A housekeeper who put "Bed Check" on their home screen should not be
 * greeted by a frying pan, an audit senior should not be greeted by either, and
 * a cook should not be greeted by a filing cabinet.
 *
 * Matched loosely on the hostname so a *.workers.dev preview brands itself the
 * same way as the real address. The practice matches on `correspondence` or the
 * shorter `cms`, because that is what a firm actually puts in front of its own
 * domain.
 *
 * `index.html` makes the same decision, inline and by the same rule, because
 * the tab title and the installed icon are settled before any module runs.
 */
export const BRAND = /housekeeping/.test(location.hostname)
  ? { app: 'housekeeping', mark: '🛏', name: 'Bed Check' }
  : /correspondence|(^|\.)cms\./.test(location.hostname)
    ? { app: 'correspondence', mark: '🗂', name: 'Correspondence' }
    : { app: 'breakfast', mark: '🍳', name: 'Breakfast Control' };
