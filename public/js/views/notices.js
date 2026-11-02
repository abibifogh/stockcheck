import { api } from '../api.js';
import { h, mount } from '../util.js';

/**
 * The bell.
 *
 * Every submitted check already sends an email. This is the same events kept
 * where somebody who lives in the app will meet them — and, more usefully, the
 * one channel that still works when the email does not. A wrong sending domain
 * or an empty recipient list is invisible until somebody asks why they never
 * heard about Tuesday; here it shows up as a warning the moment it happens.
 *
 * Deliberately not a live feed. It refreshes when the page is opened, when the
 * tab comes back to the front, and every couple of minutes — often enough that
 * a manager sees a round land while looking at the screen, rarely enough that a
 * phone left on the counter all day is not making a request a second.
 */

const REFRESH_MS = 120000;

// Line drawings in currentColor, like every other icon in the frame, so they
// take the theme's colour rather than a phone's emoji set.
const svg = (paths, size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" `
  + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + `${paths}</svg>`;
const BELL = svg('<path d="M6 9a6 6 0 0 1 12 0c0 6.5 2.5 8 2.5 8h-17S6 15.5 6 9z"/><path d="M10.2 20.5a2 2 0 0 0 3.6 0"/>', 19);
const LEVEL_ICON = {
  high: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>', 16),
  warn: svg('<path d="M12 3.5 2.5 20h19L12 3.5z"/><path d="M12 10v4.5M12 17.5h.01"/>', 16),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5h.01"/>', 16),
};

let timer = null;

export function noticeBell() {
  const count = h('span.bell-count');
  const panel = h('div.bell-panel');
  const list = h('div.bell-list');

  let open = false;
  let state = { notices: [], unread: 0, latestId: 0 };

  const button = h('button.btn-ghost.btn-sm.bell', {
    title: 'What has happened',
    'aria-label': 'Notifications',
    onclick: (event) => {
      event.stopPropagation();
      open = !open;
      panel.classList.toggle('open', open);
      if (open) {
        draw();
        // Opening the panel is the acknowledgement. Anything that arrives
        // while it is open stays unread until the next time, which is the
        // behaviour that cannot lose something.
        if (state.latestId) {
          api.markNoticesSeen(state.latestId).then(() => {
            state.unread = 0;
            paintCount();
          }).catch(() => {});
        }
      }
    },
  }, h('span.bell-glyph', { html: BELL }), count);

  const paintCount = () => {
    count.textContent = state.unread > 9 ? '9+' : String(state.unread || '');
    count.classList.toggle('on', state.unread > 0);
    button.classList.toggle('has-unread', state.unread > 0);
  };

  const draw = () => {
    mount(list, state.notices.length
      ? state.notices.map((n) => h('a.bell-item', {
        class: `bell-item ${n.unread ? 'unread' : ''} level-${n.level || 'info'}`,
        href: n.link || '#/',
        onclick: () => { open = false; panel.classList.remove('open'); },
      },
        h('span.bell-icon', { html: LEVEL_ICON[n.level] ?? LEVEL_ICON.info }),
        h('div.bell-text',
          h('div.bell-title', n.title),
          n.body ? h('div.bell-body', n.body) : null,
          h('div.bell-when', when(n.at)),
        ),
      ))
      : h('p.muted', { style: { margin: '.5rem .2rem', fontSize: '.86rem' } },
        state.unavailable
          ? 'Notifications need the latest database update before they can be recorded.'
          : 'Nothing yet. Requests, submitted days and checks appear here.'));
  };

  const refresh = async () => {
    try {
      const data = await api.notices(20);
      state = data;
      paintCount();
      if (open) draw();
    } catch {
      // A bell that cannot count is not worth an error message on somebody's
      // screen. It simply shows nothing until the next attempt.
    }
  };

  // One timer for the app's lifetime, pointed at whichever bell is on screen.
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  // Clicking anywhere else closes it, which is what every menu on every phone
  // already does.
  document.addEventListener('click', () => {
    if (!open) return;
    open = false;
    panel.classList.remove('open');
  });
  panel.addEventListener('click', (event) => event.stopPropagation());

  mount(panel,
    h('div.bell-head', h('strong', 'Notifications')),
    list,
  );

  refresh();

  return h('div.bell-wrap', button, panel);
}

/** "12 minutes ago" beats a timestamp for anything from the last day or so. */
function when(at) {
  if (!at) return '';
  const stamp = new Date(`${String(at).replace(' ', 'T')}Z`);
  if (Number.isNaN(stamp.getTime())) return String(at);

  const seconds = Math.max(0, Math.round((Date.now() - stamp.getTime()) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return stamp.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
