// Tiny DOM + formatting helpers. No framework: the whole app is a handful of
// views, and staying dependency-free means nothing to build and nothing to
// break in CI.

/** Build an element. `h('div.card', {onclick}, child, child)` */
export function h(spec, props = null, ...children) {
  const [tag, ...classes] = String(spec).split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');

  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }

  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = `${el.className} ${value}`.trim();
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key in el && key !== 'list' && typeof value !== 'object') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }

  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

// ------------------------------------------------------------ formatting --

let CURRENCY = 'GHS';
export function setCurrency(code) { CURRENCY = code || 'GHS'; }
export function currency() { return CURRENCY; }

const numberFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

export function fmtNum(value, places = 2) {
  if (value == null || value === '' || Number.isNaN(Number(value))) return '—';
  if (places === 0) return intFmt.format(Number(value));
  return new Intl.NumberFormat('en-GB', { maximumFractionDigits: places }).format(Number(value));
}

export function fmtMoney(value, { compact = false, withSymbol = true } = {}) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  let text;
  if (compact && Math.abs(n) >= 10000) {
    text = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  } else {
    text = numberFmt.format(n);
  }
  return withSymbol ? `${CURRENCY} ${text}` : text;
}

export function fmtPct(value, places = 1) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${Number(value) > 0 ? '+' : ''}${fmtNum(value, places)}%`;
}

export function fmtQty(value, unit, places = 2) {
  if (value == null) return '—';
  return `${fmtNum(value, places)}${unit ? ` ${unit}` : ''}`;
}

/** 'Mon 12 Aug' */
export function fmtDay(day, { withYear = false } = {}) {
  if (!day) return '—';
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

export function fmtDayShort(day) {
  if (!day) return '';
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function shiftDay(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function monthOf(day) { return String(day).slice(0, 7); }

export function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * A signed change, coloured by whether the movement is good news.
 * Cost going up is bad; guests going up is good — hence `higherIsBetter`.
 */
export function deltaBadge(value, { higherIsBetter = false, suffix = '%', places = 1 } = {}) {
  if (value == null || Number.isNaN(Number(value))) {
    return h('span.delta.flat', '—');
  }
  const n = Number(value);
  const flat = Math.abs(n) < 0.05;
  const good = higherIsBetter ? n > 0 : n < 0;
  const cls = flat ? 'flat' : good ? 'down' : 'up';
  const arrow = flat ? '→' : n > 0 ? '↑' : '↓';
  return h(`span.delta.${cls}`, `${arrow} ${fmtNum(Math.abs(n), places)}${suffix}`);
}

export const PALETTE = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'];
export function paletteColor(index) {
  return `var(${PALETTE[index % PALETTE.length]})`;
}

export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function toast(message, kind = '') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h(`div.toast${kind ? `.${kind}` : ''}`, message);
  host.append(el);

  // A modal <dialog> lives in the browser's top layer, above any z-index.
  // Promoting the toast host to a popover puts it in that same layer, so a
  // message can never end up hidden behind an open form.
  try {
    if (host.showPopover && !host.matches(':popover-open')) host.showPopover();
  } catch { /* older browser: the toast still shows, just below a modal */ }
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => {
      el.remove();
      if (!host.children.length) {
        try { host.hidePopover?.(); } catch { /* nothing open to hide */ }
      }
    }, 250);
  }, kind === 'bad' ? 5000 : 2600);
}

export function confirmAction(message) {
  return window.confirm(message);
}
