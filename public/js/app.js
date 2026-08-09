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
  { path: 'entry', label: 'Daily entry', permission: 'entry', render: renderEntry },
  { path: 'overview', label: 'Overview', permission: 'reports', render: renderOverview },
  { path: 'daily', label: 'Day', permission: 'reports', render: renderDaily },
  { path: 'weekly', label: 'Week', permission: 'reports', render: renderWeekly },
  { path: 'monthly', label: 'Month', permission: 'reports', render: renderMonthly },
  { path: 'compare', label: 'Compare', permission: 'reports', render: renderCompare },
  { path: 'approvals', label: 'Approvals', permission: 'approvals', render: renderApprovals },
  { path: 'stock', label: 'Stock', permission: 'stock', render: renderStock },
  { path: 'purchases', label: 'Purchases', permission: 'purchases', render: renderPurchases },
  { path: 'setup', label: 'Setup', permission: 'setup', render: renderSetup },
  { path: 'admin', label: 'Users & data', permission: 'users', render: renderAdmin },
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
  const preferred = ['overview', 'entry', 'stock', 'purchases', 'setup', 'admin'];
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

function shell(content) {
  const nav = h('nav.nav', ROUTES.filter(allowed).map((route) => h('a', {
    href: `#/${route.path}`,
    class: currentRoute()?.path === route.path ? 'active' : '',
  }, route.label)));

  return h('div.shell',
    h('header.topbar',
      h('div.brand',
        h('span.brand-mark', '🍳'),
        h('div',
          state.settings.property_name || 'Breakfast Control',
          h('span.brand-sub', state.name ? `${state.name} · ${roleLabel(state.role)}` : roleLabel(state.role)),
        ),
      ),
      h('div.topbar-spacer'),
      nav,
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
    h('main.main', content),
  );
}

/**
 * Publish the header's real height as --topbar-h.
 *
 * The tab bar wraps onto a second row when it cannot fit, and how many tabs
 * somebody has depends on what they are allowed to see. Anything sticky below
 * the header — the guest counts on the entry sheet, the guide's contents list —
 * measures from this rather than from a guessed constant.
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
