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

const LEVEL_ICON = { high: '⛔', warn: '⚠️', info: '🛏' };

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
  }, '🔔', count);

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
        h('span.bell-icon', LEVEL_ICON[n.level] ?? LEVEL_ICON.info),
        h('div.bell-text',
          h('div.bell-title', n.title),
          n.body ? h('div.bell-body', n.body) : null,
          h('div.bell-when', when(n.at)),
        ),
      ))
      : h('p.muted', { style: { margin: '.5rem .2rem', fontSize: '.86rem' } },
        state.unavailable
          ? 'Notifications need the latest database update before they can be recorded.'
          : 'Nothing yet. Submitted checks appear here.'));
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
    h('div.bell-head', h('strong', 'What has happened')),
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
