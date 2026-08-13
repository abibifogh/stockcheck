import { deltaBadge, fmtMoney, fmtNum, h, mount } from '../util.js';
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
 */
export function table(columns, rows, { rowClass = null, empty = 'No data yet.' } = {}) {
  if (!rows?.length) return h('div.empty', h('p', empty));

  return h('div.table-wrap',
    h('table',
      h('thead', h('tr', columns.map((c) =>
        h(`th${c.align === 'right' ? '.num' : ''}${c.cls ? `.${c.cls}` : ''}`, c.label)))),
      h('tbody', rows.map((row) => h('tr', { class: rowClass ? rowClass(row) : '' },
        columns.map((c) => {
          const value = row[c.key];
          const content = c.format ? c.format(value, row) : (value ?? '—');
          return h(`td${c.align === 'right' ? '.num' : ''}${c.cls ? `.${c.cls}` : ''}`, content);
        })))),
    ),
  );
}

/**
 * The same table, with a row of category chips above it and an option to
 * break it into groups.
 *
 * A stock list of forty items is a list nobody reads to the bottom. Two
 * questions get asked of it — "show me only the dairy" and "what is each
 * section worth" — and this answers both without either screen inventing its
 * own version.
 *
 * One table with a <tbody> per group rather than a table per group, so the
 * columns line up down the whole page. Separate tables size their columns
 * independently and the result reads as several unrelated lists.
 *
 * columns:   as `table`
 * groupOf:   row => the group's name
 * summarise: rows => a short line beside each group heading
 * storageKey: remembers whether this screen is grouped. The filter is
 *             deliberately not remembered — coming back tomorrow to a screen
 *             that silently hides most of the stock is how somebody concludes
 *             the data is gone.
 */
export function groupedTable(columns, rows, {
  groupOf = (r) => r.categoryName || 'Uncategorised',
  summarise = null,
  rowClass = null,
  empty = 'No data yet.',
  storageKey = null,
  label = 'item',
} = {}) {
  if (!rows?.length) return h('div.empty', h('p', empty));

  const groups = [...new Set(rows.map(groupOf))].sort((a, b) => a.localeCompare(b));
  let chosen = null; // null means everything
  let grouped = storageKey ? localStorage.getItem(`bf.group.${storageKey}`) === '1' : false;

  const chipRow = h('div.filter-chips');
  const body = h('div');

  const visible = () => (chosen == null ? rows : rows.filter((r) => groupOf(r) === chosen));

  const drawChips = () => {
    const count = (name) => rows.filter((r) => groupOf(r) === name).length;

    mount(chipRow,
      h('button.mx-chip', {
        class: chosen == null ? 'mx-chip on' : 'mx-chip',
        onclick: () => { chosen = null; draw(); },
      }, `All ${rows.length}`),
      ...groups.map((name) => h('button.mx-chip', {
        class: chosen === name ? 'mx-chip on' : 'mx-chip',
        onclick: () => { chosen = chosen === name ? null : name; draw(); },
      }, `${name} ${count(name)}`)),
      // Grouping a list that is already down to one category would draw a
      // single heading over the whole thing, which is just noise.
      groups.length > 1 && chosen == null
        ? h('button.mx-chip.filter-toggle', {
          class: grouped ? 'mx-chip filter-toggle on' : 'mx-chip filter-toggle',
          onclick: () => {
            grouped = !grouped;
            if (storageKey) localStorage.setItem(`bf.group.${storageKey}`, grouped ? '1' : '0');
            draw();
          },
        }, grouped ? '▾ Grouped' : '▸ Group by category')
        : null,
    );
  };

  const headRow = () => h('tr', columns.map((c) =>
    h(`th${c.align === 'right' ? '.num' : ''}${c.cls ? `.${c.cls}` : ''}`, c.label)));

  const cells = (row) => columns.map((c) => {
    const value = row[c.key];
    const content = c.format ? c.format(value, row) : (value ?? '—');
    return h(`td${c.align === 'right' ? '.num' : ''}${c.cls ? `.${c.cls}` : ''}`, content);
  });

  const bodyFor = (list) => h('tbody', list.map((row) =>
    h('tr', { class: rowClass ? rowClass(row) : '' }, cells(row))));

  const draw = () => {
    drawChips();
    const shown = visible();

    if (!shown.length) {
      mount(body, h('div.empty', h('p', `Nothing in ${chosen}.`)));
      return;
    }

    if (!grouped || chosen != null) {
      mount(body, h('div.table-wrap',
        h('table', h('thead', headRow()), bodyFor(shown))));
      return;
    }

    const sections = groups
      .map((name) => ({ name, list: shown.filter((r) => groupOf(r) === name) }))
      .filter((s) => s.list.length);

    mount(body, h('div.table-wrap',
      h('table',
        h('thead', headRow()),
        ...sections.flatMap((section) => [
          h('tbody.group-head',
            h('tr',
              h('th', { colspan: String(columns.length) },
                h('span.group-name', section.name),
                h('span.group-note',
                  summarise
                    ? summarise(section.list)
                    : `${section.list.length} ${section.list.length === 1 ? label : `${label}s`}`),
              ))),
          bodyFor(section.list),
        ]),
      )));
  };

  draw();
  return h('div', chipRow, body);
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
