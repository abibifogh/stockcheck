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
 */
export function table(columns, rows, { rowClass = null, empty = 'No data yet.' } = {}) {
  if (!rows?.length) return h('div.empty', h('p', empty));

  return h('div.table-wrap',
    h('table',
      h('thead', h('tr', columns.map((c) =>
        h(`th${c.align === 'right' ? '.num' : ''}`, c.label)))),
      h('tbody', rows.map((row) => h('tr', { class: rowClass ? rowClass(row) : '' },
        columns.map((c) => {
          const value = row[c.key];
          const content = c.format ? c.format(value, row) : (value ?? '—');
          return h(`td${c.align === 'right' ? '.num' : ''}${c.cls ? `.${c.cls}` : ''}`, content);
        })))),
    ),
  );
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
