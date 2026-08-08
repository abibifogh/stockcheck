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

export const state = {
  role: null,
  settings: {},
  catalog: null, // { categories, ingredients, units }
};

const ROUTES = [
  { path: 'entry', label: 'Daily entry', role: 'cook', render: renderEntry },
  { path: 'overview', label: 'Overview', role: 'manager', render: renderOverview },
  { path: 'daily', label: 'Day', role: 'manager', render: renderDaily },
  { path: 'weekly', label: 'Week', role: 'manager', render: renderWeekly },
  { path: 'monthly', label: 'Month', role: 'manager', render: renderMonthly },
  { path: 'stock', label: 'Stock', role: 'manager', render: renderStock },
  { path: 'purchases', label: 'Purchases', role: 'manager', render: renderPurchases },
  { path: 'setup', label: 'Setup', role: 'manager', render: renderSetup },
];

const root = document.getElementById('app');

function allowed(route) {
  return route.role === 'cook' || state.role === 'manager';
}

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROUTES.find((r) => r.path === hash && allowed(r));
}

function defaultRoute() {
  return state.role === 'manager' ? 'overview' : 'entry';
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
          h('span.brand-sub', state.role === 'manager' ? 'Manager' : 'Kitchen'),
        ),
      ),
      h('div.topbar-spacer'),
      nav,
      h('button.btn-ghost.btn-sm', {
        title: 'Switch light / dark',
        onclick: toggleTheme,
      }, '🌗'),
      h('button.btn-ghost.btn-sm', {
        onclick: async () => {
          await api.logout().catch(() => {});
          state.role = null;
          state.catalog = null;
          render();
        },
      }, 'Sign out'),
    ),
    h('main.main', content),
  );
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
    mount(root, renderLogin(async (role) => {
      state.role = role;
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

setUnauthorizedHandler(() => {
  state.role = null;
  state.catalog = null;
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
      state.settings = me.settings || {};
      setCurrency(me.settings?.currency);
    }
  } catch { /* fall through to the login screen */ }

  if (state.role && !currentRoute()) navigate(defaultRoute());
  await render();
  syncPending();
})();
