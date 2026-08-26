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
import { renderTools } from './views/tools.js';
import { renderToolsSetup } from './views/tools-setup.js';
import { renderMxOverview, renderMxReport } from './views/mx-reports.js';
import { renderMxStock } from './views/mx-stock.js';
import { renderMxPurchases } from './views/mx-purchases.js';
import { renderMxSetup } from './views/mx-setup.js';
import { renderMxArea } from './views/mx-area.js';
import { renderMxCompare } from './views/mx-compare.js';
import { renderBakeryLink, renderProduction } from './views/bakery.js';
import { renderHkCheck } from './views/hk-check.js';
import { renderHkOverview, renderHkReport } from './views/hk-reports.js';
import { renderHkRoom } from './views/hk-room.js';
import { renderHkSetup } from './views/hk-setup.js';
import { renderHkRoster } from './views/hk-roster.js';
import { BRAND } from './brand.js';
import { noticeBell } from './views/notices.js';

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
  { path: 'entry', label: 'Daily entry', permission: 'entry', render: renderEntry, group: 'Breakfast', site: 'full' },
  { path: 'production', label: 'Bakery', permission: 'bakery', render: renderProduction, group: 'Breakfast', site: 'full' },
  { path: 'overview', label: 'Overview', permission: 'reports', render: renderOverview, group: 'Breakfast', site: 'full' },
  { path: 'daily', label: 'Day', permission: 'reports', render: renderDaily, group: 'Breakfast', site: 'full' },
  { path: 'weekly', label: 'Week', permission: 'reports', render: renderWeekly, group: 'Breakfast', site: 'full' },
  { path: 'monthly', label: 'Month', permission: 'reports', render: renderMonthly, group: 'Breakfast', site: 'full' },
  { path: 'compare', label: 'Compare', permission: 'reports', render: renderCompare, group: 'Breakfast', site: 'full' },
  { path: 'approvals', label: 'Approvals', permission: 'approvals', render: renderApprovals, group: 'Breakfast', site: 'full' },
  { path: 'stock', label: 'Stock', permission: 'stock', render: renderStock, group: 'Breakfast', site: 'full' },
  { path: 'purchases', label: 'Purchases', permission: 'purchases', render: renderPurchases, group: 'Breakfast', site: 'full' },
  { path: 'setup', label: 'Setup', permission: 'setup', render: renderSetup, group: 'Breakfast', site: 'full' },
  { path: 'admin', label: 'Users & data', permission: 'users', render: renderAdmin },
  // ------------------------------------------------------------ maintenance --
  // A second store with its own screens. Grouped in the menu so somebody who
  // works in both does not have to hunt for which "Stock" is which.
  { path: 'mx-issue', label: 'Issue parts', permission: 'mx_issue', render: renderMxIssue, group: 'Maintenance', site: 'full' },
  { path: 'mx-overview', label: 'Store', permission: 'mx_reports', render: renderMxOverview, group: 'Maintenance', site: 'full' },
  { path: 'mx-report', label: 'Report', permission: 'mx_reports', render: renderMxReport, group: 'Maintenance', site: 'full' },
  { path: 'mx-compare', label: 'Compare', permission: 'mx_reports', render: renderMxCompare, group: 'Maintenance', site: 'full' },
  { path: 'mx-stock', label: 'Parts', permission: 'mx_stock', render: renderMxStock, group: 'Maintenance', site: 'full' },
  { path: 'mx-purchases', label: 'Bought', permission: 'mx_purchases', render: renderMxPurchases, group: 'Maintenance', site: 'full' },
  { path: 'mx-setup', label: 'Setup', permission: 'mx_setup', render: renderMxSetup, group: 'Maintenance', site: 'full' },
  // Reached by clicking a room in the report rather than from the menu.
  { path: 'mx-area', label: 'Room', permission: 'mx_reports', render: renderMxArea, hidden: true, site: 'full' },

  // ------------------------------------------------------------- tool store --
  // Its own group. Tools are lent and returned; parts are used up. Somebody can
  // be given one without the other, so the menu says so too.
  { path: 'tools', label: 'Tool store', permission: 'tools_issue', render: renderTools, group: 'Tools', site: 'full' },
  { path: 'tools-setup', label: 'Register', permission: 'tools_setup', render: renderToolsSetup, group: 'Tools', site: 'full' },

  // ----------------------------------------------------------- housekeeping --
  // The bed check comes first in its section because it is the only screen a
  // housekeeper opens, and it is opened every single morning.
  { path: 'hk-check', label: 'Bed check', permission: 'hk_check', render: renderHkCheck, group: 'Housekeeping', site: 'housekeeping' },
  // The roster on its own page, for the desk that sets who is expected where
  // without being handed the screen that renames and deletes dorms.
  { path: 'hk-roster', label: 'Roster', permission: 'hk_roster', render: renderHkRoster, group: 'Housekeeping', site: 'housekeeping' },
  { path: 'hk-overview', label: 'Dorms', permission: 'hk_reports', render: renderHkOverview, group: 'Housekeeping', site: 'housekeeping' },
  { path: 'hk-report', label: 'Report', permission: 'hk_reports', render: renderHkReport, group: 'Housekeeping', site: 'housekeeping' },
  { path: 'hk-setup', label: 'Setup', permission: 'hk_setup', render: renderHkSetup, group: 'Housekeeping', site: 'housekeeping' },
  { path: 'hk-room', label: 'Dorm room', permission: 'hk_reports', render: renderHkRoom, hidden: true, site: 'housekeeping' },

  // Open to everyone: the person most likely to need it is the one with the
  // fewest permissions.
  { path: 'guide', label: 'Help', permission: null, render: renderGuide },
];

const root = document.getElementById('app');

export function can(permission) {
  return !permission || state.permissions.includes(permission);
}

/**
 * Reachable at all on this site.
 *
 * A route marked `site: 'full'` belongs to the breakfast unit or the parts
 * store, and the housekeeping deployment does not have them — not hidden behind
 * a permission, absent. The Worker refuses their API on that site too, so this
 * is the menu agreeing with the server rather than a second opinion.
 */
function onThisSite(route) {
  return !route.site || route.site === BRAND.app || (route.site === 'full' && BRAND.app !== 'housekeeping');
}

function allowed(route) {
  return onThisSite(route) && can(route.permission);
}

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROUTES.find((r) => r.path === hash && allowed(r));
}

/**
 * Land people on the most useful screen they are actually allowed to open.
 *
 * The fallback matters as much as the list. Naming a specific route here once
 * sent anybody whose permissions were not on the list — a baker, say — to a
 * screen they could not open, which loops straight back to this function and
 * leaves them staring at the sign-in page they just cleared. So the last
 * resort is the first route they can actually open, and Help is open to
 * everyone, so there is always one.
 */
function defaultRoute() {
  // Reports before the entry screens, so somebody who runs a section lands on
  // its dashboard and somebody who only fills it in lands on the form. On the
  // housekeeping address the bed check comes first whoever you are — an
  // administrator who typed housekeeping.niceoperation.com did not mean to
  // arrive at the breakfast overview.
  const preferred = BRAND.app === 'housekeeping'
    ? ['hk-overview', 'hk-check', 'hk-roster', 'hk-setup', 'overview', 'entry',
      'mx-overview', 'mx-issue', 'stock', 'purchases', 'setup', 'admin', 'guide']
    : ['overview', 'entry', 'mx-overview', 'mx-issue', 'production',
      'stock', 'purchases', 'setup', 'admin', 'guide'];

  // The fallback matters as much as the list. Naming a specific route here
  // once sent anybody whose permissions were not on it — a baker, say — to a
  // screen they could not open, which loops straight back here and leaves them
  // staring at the sign-in page they just cleared. So the last resort is the
  // first route they can actually open, and Help is open to everyone.
  const wanted = preferred.find((path) => allowed(ROUTES.find((r) => r.path === path)));
  return wanted ?? ROUTES.find((r) => allowed(r) && !r.hidden)?.path ?? 'guide';
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

function shell(content) {
  const menuButton = h('button.btn-ghost.btn-sm.nav-toggle', {
    title: 'Menu',
    onclick: () => document.querySelector('.shell')?.classList.toggle('nav-open'),
  }, '☰');

  const shellEl = h('div.shell',
    h('header.topbar',
      menuButton,
      h('div.brand',
        h('span.brand-mark', BRAND.mark),
        h('div',
          state.settings.property_name || BRAND.name,
          h('span.brand-sub', state.name ? `${state.name} · ${roleLabel(state.role)}` : roleLabel(state.role)),
        ),
      ),
      h('div.topbar-spacer'),
      noticeBell(),
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

/**
 * The bakery link: a page that exists outside the rest of the app.
 *
 * It has to be answered before the sign-in gate, because the entire point is
 * that the bakery has no account. Its token comes from the URL and goes no
 * further than the two endpoints that accept it.
 */
function bakeryToken() {
  if (location.pathname.replace(/\/+$/, '') === '/bake') {
    return new URLSearchParams(location.search).get('t') ?? '';
  }
  // The hash form works too, so a link still opens on a host that cannot serve
  // a clean path.
  if (location.hash.startsWith('#/bake')) {
    return new URLSearchParams(location.hash.split('?')[1] || '').get('t') ?? '';
  }
  return null;
}

export async function render() {
  root.classList.remove('app-loading');

  const token = bakeryToken();
  if (token !== null) {
    mount(root, h('div.card', h('div.skeleton', { style: { height: '120px' } })));
    mount(root, await renderBakeryLink(token));
    return;
  }

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

const ROLE_LABELS = {
  cook: 'Kitchen',
  manager: 'Manager',
  baker: 'Bakery',
  technician: 'Technician',
  maintenance_manager: 'Maintenance',
  receptionist: 'Reception',
  housekeeper: 'Housekeeping',
  housekeeping_manager: 'Housekeeping manager',
  admin: 'Administrator',
};
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

  // The bakery link answers itself. Asking the server who is signed in first
  // would be a wasted round trip on a page that deliberately has nobody.
  if (bakeryToken() !== null) {
    await render();
    return;
  }

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
