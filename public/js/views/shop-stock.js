import { api } from '../api.js';
import { can, navigate } from '../app.js';
import {
  attributeSummary, fmtMoney, fmtNum, fmtQty, h, mount, toast, todayISO,
} from '../util.js';
import { card, statTile, table } from './components.js';
import { printButton } from '../print.js';

/**
 * What is on the shelf in the craft shop.
 *
 * The problem here is the opposite of the kitchen's. A hotel shop rarely runs
 * out; it fills up with a season's worth of things that did not sell, and that
 * is where the money goes. So dead stock is given as much room as shortages,
 * and every product carries what it would fetch as well as what it cost.
 */
export async function renderShopStock() {
  const [data, pending] = await Promise.all([
    api.shopStock(),
    api.shopPendingCounts().catch(() => ({ counts: [], days: [] })),
  ]);

  const host = h('div');
  const reload = async () => mount(host, await renderShopStock());
  const counts = new Map();

  const statusPill = (status) => {
    const map = {
      negative: ['bad', 'never recorded'],
      below_par: ['warn', 'below level'],
      low_cover: ['warn', 'running out'],
      ok: ['good', 'fine'],
    };
    const [cls, label] = map[status] ?? ['', status];
    return h(`span.pill.${cls}`, label);
  };

  const saveCounts = async (event) => {
    if (!counts.size) { toast('Nothing counted yet', 'bad'); return; }
    event.target.disabled = true;
    try {
      await api.shopSaveCounts({
        day: todayISO(),
        counts: [...counts.entries()].map(([itemId, qty]) => ({ itemId, qty })),
      });
      toast(`${counts.size} counted — waiting for an administrator to accept it`, 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const countBox = (row) => h('input', {
    type: 'number', min: '0', step: 'any', placeholder: '—',
    style: { width: '90px', textAlign: 'right' },
    oninput: (e) => {
      const v = Number(e.target.value);
      if (e.target.value === '' || !Number.isFinite(v) || v < 0) counts.delete(row.itemId);
      else counts.set(row.itemId, v);
      const button = host.querySelector('.count-save');
      if (button) {
        button.disabled = counts.size === 0;
        button.textContent = counts.size
          ? `Submit ${counts.size} counted ${counts.size === 1 ? 'product' : 'products'}`
          : 'Submit the count';
      }
    },
  });

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Craft shop stock'),
        h('div.sub',
          `${fmtMoney(data.totalValue)} at cost · worth ${fmtMoney(data.totalRetailValue)} at today's prices`),
      ),
      h('div.btn-row',
        printButton({ title: 'Craft shop — stock', subtitle: `As at ${data.asOf}` }),
        h('button.btn-sm', { onclick: () => navigate('shop-purchases') }, 'Record a delivery'),
      ),
    ),

    h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      statTile({
        label: 'Money on the shelf',
        value: fmtMoney(data.totalValue, { compact: true }),
        sub: 'at what you paid',
      }),
      statTile({
        label: 'Needs restocking',
        value: fmtNum(data.reorder.length, 0),
        // Two different problems wear this badge. Only one of them has a bill
        // attached, and "about GHS 0 to bring back up" is how a figure teaches
        // people to stop reading it.
        sub: data.reorderValue > 0
          ? `about ${fmtMoney(data.reorderValue, { compact: true })} to bring back up`
          : 'selling faster than the shelf covers',
        accent: data.reorder.length ? 'var(--warn)' : undefined,
      }),
      statTile({
        label: 'Not sold in 90 days',
        value: fmtNum(data.idle.length, 0),
        sub: `${fmtMoney(data.idle.reduce((n, r) => n + r.value, 0), { compact: true })} sitting still`,
        accent: data.idle.length ? 'var(--warn)' : undefined,
      }),
      statTile({
        label: 'Priced below cost',
        value: fmtNum(data.underpriced.length, 0),
        sub: 'every one sold loses money',
        accent: data.underpriced.length ? 'var(--bad)' : undefined,
      }),
    ),

    countApprovalCard(pending, reload),

    data.underpriced.length
      ? card('Priced below what they cost you', {
        wide: true,
        note: 'Fix the price, or the cost, before any more go out',
      },
        table([
          { key: 'name', label: 'Product' },
          { key: 'unitCost', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
          { key: 'sellPrice', label: 'Price', align: 'right', format: (v) => h('strong', fmtMoney(v, { withSymbol: false })) },
          {
            key: 'itemId',
            label: 'Loses',
            align: 'right',
            format: (v, r) => h('span', { style: { color: 'var(--bad)' } },
              fmtMoney(r.unitCost - r.sellPrice, { withSymbol: false })),
          },
          { key: 'stock', label: 'On shelf', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
        ], data.underpriced))
      : null,

    data.reorder.length
      ? card('Order list', {
        wide: true,
        note: 'Below its level, or selling faster than the shelf will cover — worst first',
      },
        table([
          {
            key: 'name',
            label: 'Product',
            format: (v, r) => h('div', h('div', v),
              h('small.muted', [r.categoryName, attributeSummary(r.attributes)].filter(Boolean).join(' · '))),
          },
          { key: 'stock', label: 'On shelf', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
          { key: 'parLevel', label: 'Level', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
          { key: 'suggestedOrder', label: 'Order', align: 'right', format: (v, r) => h('strong', fmtQty(v, r.unit)) },
          { key: 'suggestedOrderValue', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
          { key: 'daysCover', label: 'Days left', align: 'right', format: (v) => (v == null ? '—' : fmtNum(v, 0)) },
          { key: 'status', label: '', format: statusPill },
        ], data.reorder),
        h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
          'Negative stock never means the shelf is negative — it means a delivery was never keyed '
          + 'in. Record it under Bought and the figure corrects itself.'))
      : card('Order list', { wide: true },
        h('div.empty', h('p', 'Nothing is below its restock level.'))),

    data.idle.length
      ? card('Sitting still', {
        wide: true,
        note: 'Nothing sold in three months — the usual problem in a craft shop',
      },
        table([
          { key: 'name', label: 'Product' },
          { key: 'stock', label: 'On shelf', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
          { key: 'value', label: 'At cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
          { key: 'retailValue', label: 'At retail', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
          { key: 'lastCountDay', label: 'Last counted', format: (v) => v || h('span.muted', 'never') },
        ], data.idle.slice(0, 25)))
      : null,

    card('Everything in the shop', {
      wide: true,
      note: 'Type a figure in the last column to record a physical count',
    },
      table([
        {
          key: 'name',
          label: 'Product',
          format: (v, r) => h('div', h('div', v),
            h('small.muted', [r.categoryName, r.sku, attributeSummary(r.attributes)]
              .filter(Boolean).join(' · '))),
        },
        { key: 'stock', label: 'On shelf', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
        { key: 'unitCost', label: 'Cost each', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        { key: 'sellPrice', label: 'Price each', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        {
          key: 'marginPct',
          label: 'Margin',
          align: 'right',
          format: (v) => (v == null ? '—' : h('span', {
            style: { color: v < 0 ? 'var(--bad)' : v < 20 ? 'var(--warn)' : 'var(--good)' },
          }, `${fmtNum(v, 0)}%`)),
        },
        { key: 'value', label: 'Value', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        { key: 'sold90', label: 'Sold 90d', align: 'right', format: (v) => fmtNum(v, 2) },
        {
          key: 'itemId',
          label: 'Counted',
          align: 'right',
          format: (v, r) => (r.pendingCountQty != null
            ? h('span.pill.warn', `${fmtNum(r.pendingCountQty, 2)} waiting`)
            : countBox(r)),
        },
      ], data.rows, { rowClass: (r) => (r.status === 'negative' ? 'row-flag-high' : '') }),

      h('div.btn-row', { style: { marginTop: '.8rem' } },
        h('button.btn-primary.count-save', { disabled: true, onclick: saveCounts }, 'Submit the count'),
        h('span.muted', { style: { fontSize: '.83rem' } },
          'A count changes nothing until an administrator accepts it.'),
      ),
    ),
  );

  return host;
}

/**
 * Counts waiting on a decision.
 *
 * Whoever counts is never whoever decides — recounting a shop is exactly the
 * moment a shortfall could be quietly written off. Anybody with the stock
 * screen sees the queue; only an administrator can act on it.
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
      const result = await api.shopReviewCounts({
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
    note: `${counts.length} ${counts.length === 1 ? 'product' : 'products'} counted, nothing changed yet`,
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
      ...(isAdmin ? [{
        key: 'id',
        label: '',
        format: (v, r) => tick(r),
      }] : []),
      { key: 'day', label: 'Counted' },
      {
        key: 'name',
        label: 'Product',
        format: (v, r) => h('div', h('div', v),
          attributeSummary(r.attributes) ? h('small.muted', attributeSummary(r.attributes)) : null),
      },
      { key: 'bookQty', label: 'Book says', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
      { key: 'countedQty', label: 'Counted', align: 'right', format: (v, r) => h('strong', fmtQty(v, r.unit)) },
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
  );
}
