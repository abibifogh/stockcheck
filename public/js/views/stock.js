import { api } from '../api.js';
import { can, state } from '../app.js';
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
  const [data, pending] = await Promise.all([
    api.stock(asOf),
    api.pendingStockCounts().catch(() => ({ counts: [], days: [] })),
  ]);
  const host = h('div');
  const bakeryHost = h('div');
  const reload = async () => mount(host, await renderStock({ asOf, category, grouped }));

  let category = params.category ?? null;
  let grouped = params.grouped ?? false;

  // Built once and re-used on every repaint so a half-typed count is not lost
  // when somebody presses a category chip.
  const countCard = card('Record a physical count', { note: 'Enter only what you actually counted' },
    countForm(reload),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
      'A count does not change the figures on its own. It goes to an administrator, who sees what '
      + 'accepting it would do to each item and decides. Until then the book stands.'),
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
        label: 'Counts waiting',
        value: fmtNum(inCategory(pending.counts ?? [], category, 'categoryName').length, 0),
        sub: pending.counts?.length
          ? 'for an administrator to accept'
          : 'nothing waiting on a decision',
        accent: pending.counts?.length ? 'var(--accent)' : 'var(--good)',
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
      countApprovalCard(pending, reload),
      h('div.grid.grid-2', countCard, h('div')),
      allCard(rows, data.asOf, category, groupBy, groupValue),
      bakeryHost,
    );
  };

  paint();

  // Loaded after the page is up: the bakery log is worth having here, but not
  // worth holding the stock figures behind.
  loadBakery(bakeryHost, reload);

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
    ? card('Count variances', { note: 'Counted, and still waiting on a decision', wide: true },
      table([
        { key: 'name', label: 'Ingredient' },
        { key: 'pendingCountDay', label: 'Counted on', format: (v) => fmtDay(v) },
        { key: 'pendingCountQty', label: 'Counted', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
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

/**
 * Counts waiting on a decision.
 *
 * Whoever counts is never whoever decides. Recounting a store is exactly the
 * moment a shortfall could be quietly written off, so the two jobs are kept
 * apart: anybody with the stock screen can count and see the queue, and only an
 * administrator can accept one. The same rule as the parts store and the shop.
 */
function countApprovalCard(pending, reload) {
  const counts = pending?.counts ?? [];
  if (!counts.length) return null;

  const isAdmin = can('users');
  const chosen = new Set(counts.map((c) => c.id));
  const note = h('input', { type: 'text', placeholder: 'Note (optional)', maxlength: 300 });
  const label = h('span.muted', { style: { fontSize: '.85rem' } });

  const refresh = () => {
    const value = counts.filter((c) => chosen.has(c.id))
      .reduce((n, c) => n + c.differenceValue, 0);
    label.textContent = `${chosen.size} selected · ${chosen.size ? fmtMoney(value) : 'nothing'} `
      + `${value < 0 ? 'short' : 'over'}`;
  };

  const boxes = new Map();
  const tick = (count) => {
    const box = h('input', {
      type: 'checkbox', checked: true, style: { width: 'auto', margin: 0 },
      onchange: () => {
        if (box.checked) chosen.add(count.id); else chosen.delete(count.id);
        refresh();
      },
    });
    boxes.set(count.id, box);
    return box;
  };

  const decide = async (event, approve) => {
    if (!chosen.size) { toast('Nothing selected', 'bad'); return; }
    const value = counts.filter((c) => chosen.has(c.id)).reduce((n, c) => n + c.differenceValue, 0);
    if (approve && !confirm(
      `Accept ${chosen.size} counted ${chosen.size === 1 ? 'figure' : 'figures'}? `
      + `Stock will be corrected to what was counted, a change of ${fmtMoney(value)}.`,
    )) return;

    event.target.disabled = true;
    try {
      const result = await api.reviewStockCounts({
        ids: [...chosen], approve, note: note.value.trim() || null,
      });
      toast(approve
        ? `${result.approved} accepted — stock corrected`
        : `${result.rejected} rejected — nothing changed`, 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  refresh();

  return card('Counts waiting for a decision', {
    wide: true,
    note: `${counts.length} ${counts.length === 1 ? 'ingredient' : 'ingredients'} counted, nothing changed yet`,
  },
    isAdmin
      ? null
      : h('div.alert.info',
        h('span.alert-icon', 'ℹ️'),
        h('div',
          h('div.alert-title', 'These are with an administrator'),
          h('div.alert-detail',
            'Stock stays as the book has it until somebody with Users & data accepts them.'))),

    table([
      ...(isAdmin ? [{ key: 'id', label: '', format: (v, r) => tick(r) }] : []),
      { key: 'day', label: 'Counted', format: (v) => fmtDay(v) },
      { key: 'name', label: 'Ingredient' },
      { key: 'bookQty', label: 'Book says', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
      { key: 'countedQty', label: 'Counted', align: 'right', format: (v, r) => h('strong', `${fmtNum(v, 2)} ${r.unit}`) },
      {
        key: 'difference',
        label: 'Difference',
        align: 'right',
        format: (v, r) => h('span', {
          style: { color: v < 0 ? 'var(--bad)' : v > 0 ? 'var(--good)' : undefined },
        }, `${v > 0 ? '+' : ''}${fmtNum(v, 2)} ${r.unit}`),
      },
      { key: 'differenceValue', label: 'Worth', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      { key: 'countedBy', label: 'By', format: (v) => v || h('span.muted', '—') },
    ], counts),

    isAdmin
      ? h('div',
        h('div.field-row', { style: { marginTop: '.8rem' } },
          h('label.field', h('span', 'Note on this decision'), note)),
        h('div.btn-row', { style: { marginTop: '.7rem', alignItems: 'center' } },
          h('button.btn-sm', {
            onclick: () => { boxes.forEach((b) => { b.checked = false; }); chosen.clear(); refresh(); },
          }, 'Select none'),
          h('button', { onclick: (e) => decide(e, false) }, 'Reject'),
          h('button.btn-primary', { onclick: (e) => decide(e, true) }, 'Accept and correct stock'),
          label,
        ))
      : null,

    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.8rem', marginBottom: 0 } },
      'Accepting sets the book to what was counted, from that date onwards. A delivery keyed in '
      + 'late and dated before the count does not unsettle it — you counted what was actually '
      + 'there, and that stands.'),
  );
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
