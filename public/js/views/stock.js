import { api } from '../api.js';
import { state } from '../app.js';
import { fmtDay, fmtMoney, fmtNum, h, mount, toast, todayISO } from '../util.js';
import { card, categoryBar, exportButton, inCategory, statTile, table } from './components.js';

const STATUS_PILL = {
  negative: ['bad', 'Negative'],
  below_par: ['warn', 'Below par'],
  low_cover: ['warn', 'Running out'],
  ok: ['good', 'OK'],
};

/**
 * Book stock derived from purchases minus usage, plus a place to record a
 * physical count so the gap between the two is visible rather than assumed.
 *
 * A category can be picked at the top, and it narrows the whole page — the
 * figures as well as the lists. A store value that still counted the dairy
 * while the table below showed only cleaning would be worse than no filter at
 * all, and every list here is a subset of the same rows, so they can agree.
 */
export async function renderStock(params) {
  const asOf = params.asOf || todayISO();
  const data = await api.stock(asOf);
  const host = h('div');

  let category = params.category ?? null;
  let grouped = params.grouped ?? false;

  // Built once and re-used on every repaint so a half-typed count is not lost
  // when somebody presses a category chip.
  const countCard = card('Record a physical count', { note: 'Enter only what you actually counted' },
    countForm(async () => mount(host, await renderStock({ asOf, category, grouped }))),
  );

  const paint = () => {
    const rows = inCategory(data.rows, category);
    const reorder = inCategory(data.reorder, category);
    const shrinkage = inCategory(data.shrinkage, category);
    const groupBy = grouped ? (r) => r.categoryName : null;
    const groupValue = (group) =>
      fmtMoney(group.reduce((n, r) => n + (r.value ?? 0), 0), { compact: true });

    const bar = categoryBar({
      rows: data.rows,
      selected: category,
      grouped,
      onSelect: (value) => { category = value; paint(); },
      onGroup: (value) => { grouped = value; paint(); },
    });

    const tiles = h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      statTile({
        label: 'Store value',
        value: fmtMoney(rows.reduce((n, r) => n + r.value, 0), { compact: true }),
        sub: category ? `${category} only` : 'at weighted average cost',
      }),
      statTile({
        label: 'Needs ordering',
        value: fmtNum(reorder.length, 0),
        sub: reorder.length ? 'below par or running out' : 'everything above par',
        accent: reorder.length ? 'var(--warn)' : 'var(--good)',
      }),
      statTile({
        label: 'Negative balances',
        value: fmtNum(rows.filter((r) => r.status === 'negative').length, 0),
        sub: 'deliveries likely not recorded',
        accent: 'var(--bad)',
      }),
      statTile({
        label: 'Counted variances',
        value: fmtNum(shrinkage.length, 0),
        sub: 'physical count differs from the book',
        accent: shrinkage.length ? 'var(--warn)' : 'var(--good)',
      }),
    );

    mount(host,
      h('div.page-head',
        h('div',
          h('h1', 'Stock'),
          h('div.sub', 'Book stock = opening + purchases − recorded usage, valued at weighted average cost'),
        ),
        exportButton(api.exportUrl('stock', data.asOf, data.asOf), 'Export stock'),
      ),
      bar,
      tiles,
      reorderCard(reorder, groupBy, groupValue),
      shrinkageCard(shrinkage, groupBy),
      h('div.grid.grid-2', countCard, h('div')),
      allCard(rows, data.asOf, category, groupBy, groupValue),
    );
  };

  paint();
  return host;
}

function reorderCard(reorder, groupBy, groupValue) {
  return reorder.length
    ? card('Order list', { note: 'Suggested quantities bring each item back to its par level', wide: true },
      table([
        { key: 'name', label: 'Ingredient', format: (v, r) => h('div', h('div', v), h('small.muted', r.categoryName)) },
        { key: 'stock', label: 'On hand', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
        { key: 'parLevel', label: 'Par', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
        { key: 'avgDailyUse', label: 'Used/day', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
        { key: 'daysCover', label: 'Days cover', align: 'right', format: (v) => (v == null ? '—' : h(v < 3 ? 'b' : 'span', { style: v < 3 ? { color: 'var(--bad)' } : null }, fmtNum(v, 1))) },
        { key: 'suggestedOrder', label: 'Order', align: 'right', format: (v, r) => (v > 0 ? h('b', `${fmtNum(v, 2)} ${r.unit}`) : '—') },
        { key: 'status', label: 'Status', format: (v) => h(`span.pill.${STATUS_PILL[v][0]}`, STATUS_PILL[v][1]) },
      ], reorder, { groupBy, groupSummary: groupValue }),
      h('button.btn-sm', {
        style: { marginTop: '.7rem' },
        onclick: () => {
          // What was copied matches what is on screen: filtered to the chosen
          // category, and in the order the list is showing it.
          const lines = reorder
            .filter((r) => r.suggestedOrder > 0)
            .map((r) => `${r.name}: ${fmtNum(r.suggestedOrder, 2)} ${r.unit}`)
            .join('\n');
          navigator.clipboard?.writeText(lines || 'Nothing to order')
            .then(() => toast('Order list copied — paste it to your supplier', 'good'))
            .catch(() => toast('Could not copy on this device', 'bad'));
        },
      }, '📋 Copy order list'))
    : null;
}

function shrinkageCard(shrinkage, groupBy) {
  return shrinkage.length
    ? card('Count variances', { note: 'Physical count against the book balance', wide: true },
      table([
        { key: 'name', label: 'Ingredient' },
        { key: 'lastCountDay', label: 'Counted on', format: (v) => fmtDay(v) },
        { key: 'lastCountQty', label: 'Counted', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
        { key: 'countVariance', label: 'Difference', align: 'right', format: (v, r) => h(`span.delta.${v < 0 ? 'up' : 'down'}`, `${v > 0 ? '+' : ''}${fmtNum(v, 2)} ${r.unit}`) },
        { key: 'countVarianceValue', label: 'Value', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      ], shrinkage, { groupBy }),
      h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
        'A shortfall means more left the store than was recorded as used — over-portioning, waste, unrecorded staff meals or loss. A surplus usually means a delivery was never keyed in.'))
    : null;
}

function allCard(rows, asOf, category, groupBy, groupValue) {
  return card('Full stock position', {
    note: category ? `${category} · as at ${fmtDay(asOf)}` : `As at ${fmtDay(asOf)}`,
    wide: true,
  },
    table([
      { key: 'name', label: 'Ingredient', format: (v, r) => h('div', h('div', v), h('small.muted', r.categoryName)) },
      { key: 'stock', label: 'On hand', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
      { key: 'value', label: 'Value', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      { key: 'unitCost', label: 'Unit cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      { key: 'avgDailyUse', label: 'Used/day', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
      { key: 'daysCover', label: 'Days cover', align: 'right', format: (v) => (v == null ? '—' : fmtNum(v, 1)) },
      { key: 'parLevel', label: 'Par', align: 'right', format: (v, r) => (v ? `${fmtNum(v, 2)} ${r.unit}` : '—') },
      { key: 'status', label: 'Status', format: (v) => h(`span.pill.${STATUS_PILL[v][0]}`, STATUS_PILL[v][1]) },
    ], rows, {
      groupBy,
      groupSummary: groupValue,
      empty: category ? `Nothing in ${category}.` : 'No active ingredients yet.',
    }),
  );
}

function countForm(onSaved) {
  const day = h('input', { type: 'date', value: todayISO() });
  const rows = [];
  const rowsHost = h('div', { style: { display: 'grid', gap: '.5rem' } });

  const addRow = () => {
    const select = h('select',
      h('option', { value: '' }, 'Choose ingredient…'),
      state.catalog.ingredients.filter((i) => i.active).map((i) =>
        h('option', { value: i.id }, `${i.name} (${i.unit})`)),
    );
    const qty = h('input', { type: 'number', min: 0, step: '0.01', placeholder: 'Counted quantity' });
    const row = h('div', { style: { display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: '.4rem' } },
      select, qty,
      h('button.btn-sm.btn-ghost', {
        onclick: () => {
          row.remove();
          const idx = rows.findIndex((r) => r.row === row);
          if (idx >= 0) rows.splice(idx, 1);
        },
      }, '✕'),
    );
    rows.push({ row, select, qty });
    rowsHost.append(row);
  };
  addRow();

  return h('div',
    h('label.field', h('span', 'Count date'), day),
    rowsHost,
    h('div.btn-row', { style: { marginTop: '.6rem' } },
      h('button.btn-sm', { onclick: addRow }, '+ Add line'),
      h('button.btn-sm.btn-primary', {
        onclick: async (event) => {
          const counts = rows
            .filter((r) => r.select.value && r.qty.value !== '')
            .map((r) => ({ ingredient_id: Number(r.select.value), counted_qty: Number(r.qty.value) }));
          if (!counts.length) {
            toast('Add at least one counted ingredient', 'bad');
            return;
          }
          event.target.disabled = true;
          try {
            await api.saveStockCounts({ day: day.value, counts });
            toast(`Saved ${counts.length} counted ${counts.length === 1 ? 'item' : 'items'}`, 'good');
            onSaved();
          } catch (err) {
            toast(err.message, 'bad');
            event.target.disabled = false;
          }
        },
      }, 'Save count'),
    ),
  );
}
