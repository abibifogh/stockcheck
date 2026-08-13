import { api, flushQueue, readQueue, setUnauthorizedHandler } from './api.js';
import { h, mount, setCurrency, toast } from './util.js';
import { renderLogin } from './views/login.js';
import { renderEntry } from './views/entry.js';
import { renderOverview } from './views/overview.js';
import { renderDaily } from './views/daily.js';
import { renderWeekly } from './views/weekly.js';
import { renderMonthly } from './views/monthly.js';
import { renderStock } from './views/stock.js';
import { renderPurchases } from './views/purchases.js';
import { renderSetup } from './views/setup.js';
import { renderAdmin } from './views/admin.js';
import { renderApprovals } from './views/approvals.js';
import { openAccountDialog } from './views/account.js';
import { renderGuide } from './views/guide.js';
import { renderCompare } from './views/compare.js';
import { renderMxIssue } from './views/mx-issue.js';
import { renderMxOverview, renderMxReport } from './views/mx-reports.js';
import { renderMxStock } from './views/mx-stock.js';
import { renderMxPurchases } from './views/mx-purchases.js';
import { renderMxSetup } from './views/mx-setup.js';
import { renderMxArea } from './views/mx-area.js';
import { renderMxCompare } from './views/mx-compare.js';

export const state = {
  role: null,
  name: null,
  email: null,
  isRecovery: false,
  permissions: [],
  settings: {},
  catalog: null, // { categories, ingredients, suppliers, units }
};

const ROUTES = [
  { path: 'entry', label: 'Daily entry', permission: 'entry', render: renderEntry, group: 'Breakfast' },
  { path: 'overview', label: 'Overview', permission: 'reports', render: renderOverview, group: 'Breakfast' },
  { path: 'daily', label: 'Day', permission: 'reports', render: renderDaily, group: 'Breakfast' },
  { path: 'weekly', label: 'Week', permission: 'reports', render: renderWeekly, group: 'Breakfast' },
  { path: 'monthly', label: 'Month', permission: 'reports', render: renderMonthly, group: 'Breakfast' },
  { path: 'compare', label: 'Compare', permission: 'reports', render: renderCompare, group: 'Breakfast' },
  { path: 'approvals', label: 'Approvals', permission: 'approvals', render: renderApprovals, group: 'Breakfast' },
  { path: 'stock', label: 'Stock', permission: 'stock', render: renderStock, group: 'Breakfast' },
  { path: 'purchases', label: 'Purchases', permission: 'purchases', render: renderPurchases, group: 'Breakfast' },
  { path: 'setup', label: 'Setup', permission: 'setup', render: renderSetup, group: 'Breakfast' },
  { path: 'admin', label: 'Users & data', permission: 'users', render: renderAdmin },
  // ------------------------------------------------------------ maintenance --
  // A second store with its own screens. Grouped in the menu so somebody who
  // works in both does not have to hunt for which "Stock" is which.
  { path: 'mx-issue', label: 'Issue parts', permission: 'mx_issue', render: renderMxIssue, group: 'Maintenance' },
  { path: 'mx-overview', label: 'Store', permission: 'mx_reports', render: renderMxOverview, group: 'Maintenance' },
  { path: 'mx-report', label: 'Report', permission: 'mx_reports', render: renderMxReport, group: 'Maintenance' },
  { path: 'mx-compare', label: 'Compare', permission: 'mx_reports', render: renderMxCompare, group: 'Maintenance' },
  { path: 'mx-stock', label: 'Parts', permission: 'mx_stock', render: renderMxStock, group: 'Maintenance' },
  { path: 'mx-purchases', label: 'Bought', permission: 'mx_purchases', render: renderMxPurchases, group: 'Maintenance' },
  { path: 'mx-setup', label: 'Setup', permission: 'mx_setup', render: renderMxSetup, group: 'Maintenance' },
  // Reached by clicking a room in the report rather than from the menu.
  { path: 'mx-area', label: 'Room', permission: 'mx_reports', render: renderMxArea, hidden: true },

  // Open to everyone: the person most likely to need it is the one with the
  // fewest permissions.
  { path: 'guide', label: 'Help', permission: null, render: renderGuide },
];

const root = document.getElementById('app');

export function can(permission) {
  return !permission || state.permissions.includes(permission);
}

function allowed(route) {
  return can(route.permission);
}

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROUTES.find((r) => r.path === hash && allowed(r));
}

/** Land people on the most useful screen they are actually allowed to open. */
function defaultRoute() {
  const preferred = ['overview', 'entry', 'mx-overview', 'mx-issue', 'stock', 'purchases', 'setup', 'admin'];
  return preferred.find((path) => allowed(ROUTES.find((r) => r.path === path))) ?? 'entry';
}

/** Query params live after the route: #/daily?day=2026-08-08 */
export function routeParams() {
  const query = location.hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(query));
}

export function navigate(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  location.hash = `#/${path}${query ? `?${query}` : ''}`;
}

/** Update the URL without re-rendering — used by in-view date pickers. */
export function replaceParams(path, params) {
  const query = new URLSearchParams(params).toString();
  history.replaceState(null, '', `#/${path}${query ? `?${query}` : ''}`);
}

export async function ensureCatalog(force = false) {
  if (!state.catalog || force) {
    const data = await api.bootstrap();
    setCurrency(data.settings.currency);
    state.catalog = data;
    state.settings = data.settings;
    state.permissions = data.permissions ?? state.permissions;
    state.role = data.user?.role ?? state.role;
    state.name = data.user?.name ?? state.name;
  }
  return state.catalog;
}

/**
 * The side navigation.
 *
 * A single row of tabs stopped working the moment there were two stores: an
 * administrator had nineteen of them, wrapping onto three lines and burying
 * "Users & data" at the end. Down the side there is room for the sections to be
 * named, so "Stock" under Breakfast and "Parts" under Maintenance can never be
 * mistaken for each other.
 *
 * Sections collapse, and the one you are in is always open — closing the
 * section you are reading would hide the page you are on.
 */
const collapsed = new Set(JSON.parse(localStorage.getItem('bf.navClosed') || '[]'));

function saveCollapsed() {
  localStorage.setItem('bf.navClosed', JSON.stringify([...collapsed]));
}

function sidebar() {
  const visible = ROUTES.filter((r) => allowed(r) && !r.hidden);
  const here = currentRoute()?.path;

  const link = (route) => h('a.side-link', {
    href: `#/${route.path}`,
    class: here === route.path ? 'side-link active' : 'side-link',
    onclick: () => closeDrawer(),
  }, route.label);

  // Preserve the order routes are declared in rather than sorting: it runs
  // from "what you do every morning" to "what you set up once".
  const groups = [];
  for (const route of visible) {
    const name = route.group ?? null;
    let group = groups.find((g) => g.name === name);
    if (!group) { group = { name, routes: [] }; groups.push(group); }
    group.routes.push(route);
  }
  // Whatever order the routes happen to be declared in, the odds and ends —
  // Users & data, Help — sit at the foot rather than between two sections.
  groups.sort((a, b) => (a.name ? 0 : 1) - (b.name ? 0 : 1));

  return h('nav.sidebar', groups.map((group) => {
    if (!group.name) return h('div.side-group', group.routes.map(link));

    const holdsCurrent = group.routes.some((r) => r.path === here);
    // A section with only one thing in it is a link, not a section.
    if (group.routes.length === 1) return h('div.side-group', group.routes.map(link));

    const isOpen = holdsCurrent || !collapsed.has(group.name);
    const body = h('div.side-items', group.routes.map(link));

    const header = h('button.side-head', {
      class: isOpen ? 'side-head open' : 'side-head',
      onclick: (event) => {
        // Always toggles, even for the section holding the current page: a
        // header that visibly does nothing when clicked reads as broken. The
        // page itself is still on screen either way.
        const open = collapsed.has(group.name);
        if (open) collapsed.delete(group.name);
        else collapsed.add(group.name);
        saveCollapsed();
        body.style.display = open ? '' : 'none';
        event.currentTarget.classList.toggle('open', open);
      },
    }, h('span', group.name), h('span.side-caret', '▾'));

    if (!isOpen) body.style.display = 'none';
    return h('div.side-group', header, body);
  }));
}

function closeDrawer() {
  document.querySelector('.shell')?.classList.remove('nav-open');
}

/**
 * The bell.
 *
 * Email is the channel that reaches somebody who is not looking at the system;
 * this is the one that reaches somebody who is. It is deliberately quiet: a
 * count, a list, and nothing that interrupts what you were doing.
 */
const inbox = { notifications: [], unread: 0, loadedAt: 0 };
let inboxTimer = null;

function bellButton() {
  const badge = h('span.bell-badge', { style: { display: 'none' } }, '');
  const button = h('button.btn-ghost.btn-sm.bell', {
    title: 'Notifications',
    onclick: (event) => {
      event.stopPropagation();
      toggleInboxPanel(button);
    },
  }, '🔔', badge);

  const paint = () => {
    badge.textContent = inbox.unread > 9 ? '9+' : String(inbox.unread);
    badge.style.display = inbox.unread ? '' : 'none';
    button.classList.toggle('has-unread', inbox.unread > 0);
  };
  paint();

  const refresh = async () => {
    try {
      const data = await api.inbox(30);
      inbox.notifications = data.notifications ?? [];
      inbox.unread = data.unread ?? 0;
      inbox.loadedAt = Date.now();
      paint();
    } catch { /* a bell that cannot load is not worth an error message */ }
  };

  refresh();
  clearInterval(inboxTimer);
  // Two minutes: often enough that a manager notices a report while it still
  // matters, rare enough to be invisible on the free plan's request budget.
  inboxTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, 120000);

  return button;
}

function closeInboxPanel() {
  document.querySelector('.inbox-panel')?.remove();
}

function toggleInboxPanel(anchor) {
  if (document.querySelector('.inbox-panel')) {
    closeInboxPanel();
    return;
  }

  const openOne = async (note) => {
    closeInboxPanel();
    if (!note.read) {
      note.read = true;
      inbox.unread = Math.max(0, inbox.unread - 1);
      api.markInboxRead([note.id]).catch(() => {});
    }
    if (note.link) location.hash = note.link.replace(/^#/, '#');
    render();
  };

  const items = inbox.notifications.length
    ? inbox.notifications.map((note) => h(`div.inbox-item${note.read ? '' : '.unread'}`, {
      onclick: () => openOne(note),
    },
    h('div.inbox-title', note.title),
    note.body ? h('div.inbox-body', note.body) : null,
    h('div.inbox-when', whenLabel(note.at)),
    ))
    : [h('div.inbox-empty', h('p.muted', 'Nothing new. Submitted reports and counts waiting for approval show up here.'))];

  const panel = h('div.inbox-panel', { onclick: (e) => e.stopPropagation() },
    h('div.inbox-head',
      h('strong', 'Notifications'),
      inbox.unread
        ? h('button.btn-ghost.btn-sm', {
          onclick: async () => {
            inbox.notifications.forEach((n) => { n.read = true; });
            inbox.unread = 0;
            closeInboxPanel();
            document.querySelector('.bell')?.classList.remove('has-unread');
            const badge = document.querySelector('.bell-badge');
            if (badge) badge.style.display = 'none';
            await api.markInboxRead().catch(() => {});
          },
        }, 'Mark all read')
        : null,
    ),
    h('div.inbox-list', ...items),
  );

  anchor.parentElement.appendChild(panel);
  // Clicking anywhere else puts it away, which is what a dropdown is expected
  // to do and saves needing a close button on a phone.
  setTimeout(() => document.addEventListener('click', closeInboxPanel, { once: true }), 0);
}

/** "3 minutes ago", without pulling in a date library. */
function whenLabel(at) {
  if (!at) return '';
  const then = new Date(String(at).replace(' ', 'T') + (String(at).endsWith('Z') ? '' : 'Z'));
  const seconds = Math.max(0, (Date.now() - then.getTime()) / 1000);
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days < 8) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function shell(content) {
  const menuButton = h('button.btn-ghost.btn-sm.nav-toggle', {
    title: 'Menu',
    onclick: () => document.querySelector('.shell')?.classList.toggle('nav-open'),
  }, '☰');

  const shellEl = h('div.shell',
    h('header.topbar',
      menuButton,
      h('div.brand',
        h('span.brand-mark', '🍳'),
        h('div',
          state.settings.property_name || 'Breakfast Control',
          h('span.brand-sub', state.name ? `${state.name} · ${roleLabel(state.role)}` : roleLabel(state.role)),
        ),
      ),
      h('div.topbar-spacer'),
      bellButton(),
      h('button.btn-ghost.btn-sm', {
        title: 'Switch light / dark',
        onclick: toggleTheme,
      }, '🌗'),
      h('button.btn-ghost.btn-sm', {
        title: state.role === 'admin' ? 'Change my password' : 'Change my PIN',
        onclick: () => openAccountDialog({
          role: state.role,
          name: state.name || 'you',
          email: state.email,
          isRecovery: state.isRecovery,
          canAlert: can('reports'),
        }),
      }, 'My account'),
      h('button.btn-ghost.btn-sm', {
        onclick: async () => {
          await api.logout().catch(() => {});
          resetSession();
          render();
        },
      }, 'Sign out'),
    ),
    h('div.body-row',
      sidebar(),
      // Tapping the page behind an open drawer closes it, which is what every
      // phone user already expects to happen.
      h('div.nav-scrim', { onclick: closeDrawer }),
      h('main.main', content),
    ),
  );

  return shellEl;
}

/**
 * Publish the header's real height as --topbar-h.
 *
 * Anything sticky below the header — the sidebar, the guest counts on the entry
 * sheet, the guide's contents list — measures from this rather than a guessed
 * constant, so a header that changes height cannot hide them.
 */
let topbarWatcher = null;
function trackTopbarHeight() {
  const bar = document.querySelector('.topbar');
  if (!bar || typeof ResizeObserver !== 'function') return;
  topbarWatcher?.disconnect();
  topbarWatcher = new ResizeObserver(() => {
    document.documentElement.style.setProperty('--topbar-h', `${Math.round(bar.getBoundingClientRect().height)}px`);
  });
  topbarWatcher.observe(bar);
}

function toggleTheme() {
  const explicit = document.documentElement.getAttribute('data-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = explicit ? (explicit === 'dark' ? 'light' : 'dark') : (prefersDark ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('bf.theme', next);
}

export async function render() {
  root.classList.remove('app-loading');

  if (!state.role) {
    mount(root, renderLogin(async ({ role, name, email, permissions, isRecovery }) => {
      state.role = role;
      state.name = name;
      state.email = email ?? null;
      state.isRecovery = Boolean(isRecovery);
      state.permissions = permissions ?? [];
      state.catalog = null;
      if (!location.hash || !currentRoute()) navigate(defaultRoute());
      await render();
      syncPending();
    }));
    return;
  }

  const route = currentRoute();
  if (!route) {
    navigate(defaultRoute());
    return;
  }

  const container = h('div');
  mount(root, shell(container));
  trackTopbarHeight();
  mount(container, h('div.card', h('div.skeleton', { style: { height: '120px' } })));

  try {
    await ensureCatalog();
    const view = await route.render(routeParams());
    mount(container, view);
  } catch (err) {
    if (err.status === 401) return; // the unauthorized handler already reset us
    mount(container, h('div.card.empty',
      h('h3', 'Could not load this view'),
      h('p.muted', err.message || String(err)),
      h('button.btn-primary', { onclick: () => render() }, 'Try again'),
    ));
  }
}

async function syncPending() {
  if (!Object.keys(readQueue()).length) return;
  try {
    const synced = await flushQueue();
    if (synced) toast(`Synced ${synced} saved ${synced === 1 ? 'day' : 'days'} from this device`, 'good');
  } catch { /* still offline; the queue keeps waiting */ }
}

function resetSession() {
  state.role = null;
  state.name = null;
  state.email = null;
  state.isRecovery = false;
  state.permissions = [];
  state.catalog = null;
}

const ROLE_LABELS = { cook: 'Kitchen', manager: 'Manager', admin: 'Administrator' };
function roleLabel(role) {
  return ROLE_LABELS[role] || 'Signed in';
}

setUnauthorizedHandler(() => {
  resetSession();
  render();
});

window.addEventListener('hashchange', render);
window.addEventListener('online', syncPending);

(async function boot() {
  const savedTheme = localStorage.getItem('bf.theme');
  if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

  try {
    const me = await api.me();
    if (me.authenticated) {
      state.role = me.role;
      state.name = me.name;
      state.email = me.email ?? null;
      state.isRecovery = Boolean(me.isRecovery);
      state.permissions = me.permissions || [];
      state.settings = me.settings || {};
      setCurrency(me.settings?.currency);
    }
  } catch { /* fall through to the login screen */ }

  if (state.role && !currentRoute()) navigate(defaultRoute());
  await render();
  syncPending();
})();
