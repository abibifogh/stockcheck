import { deltaBadge, fmtMoney, fmtNum, h } from '../util.js';
import { sparkline } from '../charts.js';

export function statTile({ label, value, sub, delta, higherIsBetter = false, spark, accent }) {
  return h('div.stat',
    h('div.stat-label', label),
    h('div.stat-value', { style: accent ? { color: accent } : null }, value),
    (sub || delta != null) && h('div.stat-sub',
      delta != null ? deltaBadge(delta, { higherIsBetter }) : null,
      sub ? h('span', sub) : null,
    ),
    spark?.length ? sparkline(spark, { color: accent || 'var(--accent)' }) : null,
  );
}

const ALERT_ICON = { high: '⛔', warn: '⚠️', info: 'ℹ️' };

export function alertList(alerts, { empty = 'Nothing needs attention.' } = {}) {
  if (!alerts?.length) {
    return h('div.alert.info',
      h('span.alert-icon', '✓'),
      h('div', h('div.alert-title', 'All clear'), h('div.alert-detail', empty)),
    );
  }
  return h('div', alerts.map((a) => h(`div.alert.${a.level || 'info'}`,
    h('span.alert-icon', ALERT_ICON[a.level] || 'ℹ️'),
    h('div',
      h('div.alert-title', a.title),
      a.detail ? h('div.alert-detail', a.detail) : null,
    ),
  )));
}

export function card(title, { note, actions, wide } = {}, ...children) {
  return h('section.card', { style: wide ? { gridColumn: '1 / -1' } : null },
    (title || note || actions) && h('div.card-head',
      h('h2', title || ''),
      note ? h('span.card-note', note) : null,
      actions || null,
    ),
    ...children,
  );
}

/**
 * columns: [{ key, label, align, format, cls }]
 * Rows are plain objects; `format` receives (value, row).
 *
 * `groupBy` turns the flat list into banded sections — one heading row per
 * group, the rows under it in the order they arrived. It stays one table
 * rather than a table per group so the columns still line up down the page,
 * which is the whole point of reading a stock list. `groupSummary` gets the
 * rows of a group and returns whatever is worth putting on its heading, such
 * as what that group is worth.
 */
export function table(columns, rows, {
  rowClass = null, empty = 'No data yet.', groupBy = null, groupSummary = null,
} = {}) {
  if (!rows?.length) return h('div.empty', h('p', empty));

  const rowEl = (row) => h('tr', { class: rowClass ? rowClass(row) : '' },
    columns.map((c) => {
      const value = row[c.key];
      const content = c.format ? c.format(value, row) : (value ?? '—');
      return h(`td${c.align === 'right' ? '.num' : ''}${c.cls ? `.${c.cls}` : ''}`, content);
    }));

  return h('div.table-wrap',
    h('table',
      h('thead', h('tr', columns.map((c) =>
        h(`th${c.align === 'right' ? '.num' : ''}`, c.label)))),
      h('tbody', groupBy ? groupedBody(rows, groupBy, groupSummary, columns.length, rowEl)
        : rows.map(rowEl)),
    ),
  );
}

function groupedBody(rows, groupBy, groupSummary, span, rowEl) {
  const groups = new Map();
  for (const row of rows) {
    const label = groupBy(row) || UNGROUPED;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(row);
  }

  const out = [];
  for (const label of sortGroups([...groups.keys()])) {
    const group = groups.get(label);
    out.push(h('tr.row-group', h('td', { colspan: span },
      h('span.row-group-name', label),
      h('span.row-group-meta', `${group.length} ${group.length === 1 ? 'item' : 'items'}`),
      groupSummary ? h('span.row-group-meta', groupSummary(group)) : null,
    )));
    out.push(...group.map(rowEl));
  }
  return out;
}

const UNGROUPED = 'Uncategorised';

/** Alphabetical, but whatever has no category sits at the bottom where it belongs. */
function sortGroups(labels) {
  return labels.sort((a, b) => {
    if (a === UNGROUPED) return 1;
    if (b === UNGROUPED) return -1;
    return a.localeCompare(b);
  });
}

/**
 * The category chips above a stock list, and the switch that bands it.
 *
 * Returns null when there is nothing to choose between — a store with one
 * category does not need a filter, and an empty control is worse than none.
 *
 * The counts are on the chips deliberately: "Cleaning (14)" tells you whether
 * it is worth pressing before you press it.
 */
export function categoryBar({
  rows, key = 'categoryName', selected = null, grouped = false, onSelect, onGroup,
}) {
  const counts = new Map();
  for (const row of rows ?? []) {
    const name = row[key] || UNGROUPED;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size < 2) return null;

  const chip = (label, value, n) => h('button', {
    class: selected === value ? 'active' : '',
    onclick: () => onSelect(value),
  }, label, h('span.seg-count', n));

  return h('div.toolbar.filter-bar',
    h('div.seg.seg-wrap',
      chip('All', null, rows.length),
      ...sortGroups([...counts.keys()]).map((name) => chip(name, name, counts.get(name))),
    ),
    h('label.inline-check',
      h('input', { type: 'checkbox', checked: grouped, onchange: (e) => onGroup(e.target.checked) }),
      h('span', 'Group by category'),
    ),
  );
}

/** The rows a chip selection leaves behind. `null` means all of them. */
export function inCategory(rows, selected, key = 'categoryName') {
  if (!selected) return rows ?? [];
  return (rows ?? []).filter((row) => (row[key] || UNGROUPED) === selected);
}

/** A signed money figure that reads red when it costs you more. */
export function moneyDelta(value, { invert = false } = {}) {
  if (value == null) return h('span.muted', '—');
  const n = Number(value);
  const bad = invert ? n < 0 : n > 0;
  const cls = Math.abs(n) < 0.005 ? 'flat' : bad ? 'up' : 'down';
  return h(`span.delta.${cls}`, `${n > 0 ? '+' : ''}${fmtMoney(n, { withSymbol: false })}`);
}

export function pctCell(value) {
  if (value == null) return h('span.muted', '—');
  return deltaBadge(value);
}

export function unitCell(value, unit, places = 2) {
  if (value == null) return h('span.muted', '—');
  return h('span', fmtNum(value, places), h('span.muted', ` ${unit}`));
}

/** Date navigator shared by the day / week / month views. */
export function periodNav({ label, onPrev, onNext, onToday, nextDisabled, input }) {
  return h('div.toolbar',
    h('button.btn-sm', { onclick: onPrev }, '‹'),
    input || null,
    h('button.btn-sm', { onclick: onNext, disabled: nextDisabled }, '›'),
    onToday ? h('button.btn-sm', { onclick: onToday }, 'Latest') : null,
    label ? h('strong', { style: { marginLeft: '.4rem' } }, label) : null,
  );
}

export function exportButton(href, label = 'Export CSV') {
  return h('a.btn.btn-sm', { href, download: '' }, '⬇ ', label);
}

export function emptyState(title, detail) {
  return h('div.card.empty', h('h3', title), h('p', detail));
}
