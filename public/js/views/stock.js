import { api } from '../api.js';
import { state } from '../app.js';
import { fmtDay, fmtMoney, fmtNum, h, mount, toast, todayISO } from '../util.js';
import { card, exportButton, groupedTable, statTile, table } from './components.js';

const STATUS_PILL = {
  negative: ['bad', 'Negative'],
  below_par: ['warn', 'Below par'],
  low_cover: ['warn', 'Running out'],
  ok: ['good', 'OK'],
};

/**
 * Book stock derived from purchases minus usage, plus a place to record a
 * physical count so the gap between the two is visible rather than assumed.
 */
export async function renderStock(params) {
  const asOf = params.asOf || todayISO();
  const data = await api.stock(asOf);
  const host = h('div');

  const reload = async () => mount(host, await renderStock({ asOf }));
  const bakeryHost = h('div');

  const tiles = h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
    statTile({ label: 'Store value', value: fmtMoney(data.totalValue, { compact: true }), sub: 'at weighted average cost' }),
    statTile({
      label: 'Needs ordering',
      value: fmtNum(data.reorder.length, 0),
      sub: data.reorder.length ? 'below par or running out' : 'everything above par',
      accent: data.reorder.length ? 'var(--warn)' : 'var(--good)',
    }),
    statTile({
      label: 'Negative balances',
      value: fmtNum(data.rows.filter((r) => r.status === 'negative').length, 0),
      sub: 'deliveries likely not recorded',
      accent: 'var(--bad)',
    }),
    statTile({
      label: 'Counted variances',
      value: fmtNum(data.shrinkage.length, 0),
      sub: 'physical count differs from the book',
      accent: data.shrinkage.length ? 'var(--warn)' : 'var(--good)',
    }),
  );

  const reorderCard = data.reorder.length
    ? card('Order list', { note: 'Suggested quantities bring each item back to its par level', wide: true },
      table([
        { key: 'name', label: 'Ingredient', format: (v, r) => h('div', h('div', v), h('small.muted', r.categoryName)) },
        { key: 'stock', label: 'On hand', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
        { key: 'parLevel', label: 'Par', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
        { key: 'avgDailyUse', label: 'Used/day', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
        { key: 'daysCover', label: 'Days cover', align: 'right', format: (v) => (v == null ? '—' : h(v < 3 ? 'b' : 'span', { style: v < 3 ? { color: 'var(--bad)' } : null }, fmtNum(v, 1))) },
        { key: 'suggestedOrder', label: 'Order', align: 'right', format: (v, r) => (v > 0 ? h('b', `${fmtNum(v, 2)} ${r.unit}`) : '—') },
        { key: 'status', label: 'Status', format: (v) => h(`span.pill.${STATUS_PILL[v][0]}`, STATUS_PILL[v][1]) },
      ], data.reorder),
      h('button.btn-sm', {
        style: { marginTop: '.7rem' },
        onclick: () => {
          const lines = data.reorder
            .filter((r) => r.suggestedOrder > 0)
            .map((r) => `${r.name}: ${fmtNum(r.suggestedOrder, 2)} ${r.unit}`)
            .join('\n');
          navigator.clipboard?.writeText(lines || 'Nothing to order')
            .then(() => toast('Order list copied — paste it to your supplier', 'good'))
            .catch(() => toast('Could not copy on this device', 'bad'));
        },
      }, '📋 Copy order list'))
    : null;

  const shrinkageCard = data.shrinkage.length
    ? card('Count variances', { note: 'Physical count against the book balance', wide: true },
      table([
        { key: 'name', label: 'Ingredient' },
        { key: 'lastCountDay', label: 'Counted on', format: (v) => fmtDay(v) },
        { key: 'lastCountQty', label: 'Counted', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
        { key: 'countVariance', label: 'Difference', align: 'right', format: (v, r) => h(`span.delta.${v < 0 ? 'up' : 'down'}`, `${v > 0 ? '+' : ''}${fmtNum(v, 2)} ${r.unit}`) },
        { key: 'countVarianceValue', label: 'Value', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      ], data.shrinkage),
      h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
        'A shortfall means more left the store than was recorded as used — over-portioning, waste, unrecorded staff meals or loss. A surplus usually means a delivery was never keyed in.'))
    : null;

  const countCard = card('Record a physical count', { note: 'Enter only what you actually counted' },
    countForm(reload),
  );

  const allCard = card('Full stock position', {
    note: `As at ${fmtDay(data.asOf)} · tap a category to narrow the list`,
    wide: true,
  },
    groupedTable([
      // The category has moved out from under the name: when the list is
      // grouped it is already the heading, and when it is filtered it is the
      // chip you just pressed. Repeating it on every row was noise.
      { key: 'name', label: 'Ingredient' },
      { key: 'stock', label: 'On hand', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
      { key: 'value', label: 'Value', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      { key: 'unitCost', label: 'Unit cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      { key: 'avgDailyUse', label: 'Used/day', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
      { key: 'daysCover', label: 'Days cover', align: 'right', format: (v) => (v == null ? '—' : fmtNum(v, 1)) },
      { key: 'parLevel', label: 'Par', align: 'right', format: (v, r) => (v ? `${fmtNum(v, 2)} ${r.unit}` : '—') },
      { key: 'status', label: 'Status', format: (v) => h(`span.pill.${STATUS_PILL[v][0]}`, STATUS_PILL[v][1]) },
    ], data.rows, {
      empty: 'No active ingredients yet.',
      storageKey: 'stock',
      label: 'ingredient',
      // What a section is worth is the reason to group at all: "the dairy is
      // half the store" is a fact you cannot see in a flat list.
      summarise: (rows) => `${rows.length} ${rows.length === 1 ? 'ingredient' : 'ingredients'} · `
        + `${fmtMoney(rows.reduce((n, r) => n + r.value, 0))}`
        + (rows.some((r) => r.status !== 'ok')
          ? ` · ${rows.filter((r) => r.status !== 'ok').length} need attention` : ''),
    }),
  );

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Stock'),
        h('div.sub', 'Book stock = opening + purchases + bakery − recorded usage, '
          + 'valued at weighted average cost'),
      ),
      exportButton(api.exportUrl('stock', data.asOf, data.asOf), 'Export stock'),
    ),
    tiles,
    reorderCard,
    shrinkageCard,
    h('div.grid.grid-2', countCard, h('div')),
    allCard,
    bakeryHost,
  );

  // Loaded after the page is up: the bakery log is worth having here, but not
  // worth holding the stock figures behind.
  loadBakery(bakeryHost, reload);

  return host;
}

/**
 * What the bakery has sent, on the stock screen.
 *
 * It belongs here rather than on a screen of its own: bread baked is stock
 * arriving, and the question anybody has about it — "did the night run go in?"
 * — is asked while looking at what is on the shelf.
 */
async function loadBakery(host, reload) {
  let data;
  try {
    data = await api.productionLog();
  } catch {
    return; // migration not run, or no access — either way, nothing to show
  }
  if (!data.runs?.length) return;

  const remove = async (event, run) => {
    if (!confirm(`Remove ${fmtNum(run.qty, 2)} ${run.unit} of ${run.name} from `
      + `${fmtDay(run.day)}${run.cycle ? ` (${run.cycle})` : ''}? Stock goes back to what it was.`)) return;
    event.target.disabled = true;
    try {
      await api.deleteProduction(run.id);
      toast('Removed', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const produced = data.runs.reduce((n, r) => n + r.value, 0);

  mount(host, card('Baked in our own bakery', {
    wide: true,
    note: `${data.cycles.length} ${data.cycles.length === 1 ? 'cycle' : 'cycles'} · `
      + `${fmtMoney(produced, { compact: true })} added to the shelf`,
  },
    table([
      { key: 'day', label: 'Date', format: (v) => fmtDay(v) },
      { key: 'cycle', label: 'Cycle', format: (v) => (v ? h('span.pill', v) : h('span.muted', '—')) },
      { key: 'name', label: 'Item' },
      { key: 'qty', label: 'Made', align: 'right', format: (v, r) => h('strong', `${fmtNum(v, 2)} ${r.unit}`) },
      { key: 'value', label: 'Worth', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      {
        key: 'producedBy',
        label: 'Reported by',
        format: (v, r) => h('span', v || h('span.muted', '—'),
          r.viaLink ? h('span.muted', { title: r.linkLabel ?? '' }, ' · via link') : null),
      },
      {
        key: 'id',
        label: '',
        format: (v, r) => h('button.btn-sm.btn-ghost', { onclick: (e) => remove(e, r) }, 'Remove'),
      },
    ], data.runs.slice(0, 60)),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
      'These add to stock exactly as a delivery does, and the morning sheet draws against '
      + 'them. They are kept out of Purchases, which is money actually spent with suppliers.'),
  ));
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
