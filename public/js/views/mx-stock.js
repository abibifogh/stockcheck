import { api } from '../api.js';
import { navigate } from '../app.js';
import { attributeSummary, fmtMoney, fmtNum, fmtQty, h, mount, toast, todayISO } from '../util.js';
import { card, statTile, table } from './components.js';
import { printButton } from '../print.js';

/**
 * What is on the shelf, what to order, and what is sitting there doing nothing.
 *
 * Days of cover is measured over three months rather than the kitchen's
 * fortnight: a hotel gets through bulbs steadily but replaces a cistern valve
 * twice a year, and a short window would call almost everything dead stock.
 */
export async function renderMxStock() {
  const data = await api.mxStock();
  const host = h('div');

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
      await api.mxSaveCounts({
        day: todayISO(),
        counts: [...counts.entries()].map(([itemId, qty]) => ({ itemId, qty })),
      });
      toast(`${counts.size} counted`, 'good');
      mount(host, await renderMxStock());
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Parts on the shelf'),
        h('div.sub', `Book value ${fmtMoney(data.totalValue)} · as at ${data.asOf}`),
      ),
      h('div.btn-row',
        printButton({ title: 'Maintenance store — stock', subtitle: `As at ${data.asOf}` }),
        h('button.btn-sm', { onclick: () => navigate('mx-purchases') }, 'Record a delivery'),
      ),
    ),

    h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      statTile({ label: 'Value on the shelf', value: fmtMoney(data.totalValue, { compact: true }), sub: 'at what you paid' }),
      statTile({
        label: 'Needs ordering',
        value: fmtNum(data.reorder.length, 0),
        sub: `about ${fmtMoney(data.reorderValue, { compact: true })} to restock`,
        accent: data.reorder.length ? 'var(--warn)' : undefined,
      }),
      statTile({
        label: 'Not moved in 90 days',
        value: fmtNum(data.idle.length, 0),
        sub: `${fmtMoney(data.idle.reduce((n, r) => n + r.value, 0), { compact: true })} sitting still`,
      }),
      statTile({
        label: 'Count differences',
        value: fmtNum(data.shrinkage.length, 0),
        sub: 'shelf against book',
        accent: data.shrinkage.length ? 'var(--bad)' : undefined,
      }),
    ),

    data.reorder.length
      ? card('Order list', {
        wide: true,
        note: 'Everything below its restock level, worst first',
      },
        table([
          { key: 'name', label: 'Part', format: (v, r) => h('div', h('div', v), h('small.muted', [r.categoryName, attributeSummary(r.attributes)].filter(Boolean).join(' · '))) },
          { key: 'stock', label: 'On shelf', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
          { key: 'parLevel', label: 'Level', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
          { key: 'suggestedOrder', label: 'Order', align: 'right', format: (v, r) => h('strong', fmtQty(v, r.unit)) },
          { key: 'suggestedOrderValue', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
          { key: 'daysCover', label: 'Days left', align: 'right', format: (v) => (v == null ? '—' : fmtNum(v, 0)) },
          { key: 'status', label: '', format: statusPill },
        ], data.reorder),
        h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
          'Negative stock never means the shelf is negative — it means a delivery was never keyed '
          + 'in. Record it under Deliveries and the figure corrects itself.'),
      )
      : card('Order list', { wide: true },
        h('div.empty', h('p', 'Nothing is below its restock level. The store is in good shape.'))),

    card('Everything in the store', {
      wide: true,
      note: 'Type a figure in the last column to record a physical count',
    },
      table([
        { key: 'name', label: 'Part', format: (v, r) => h('div', h('div', v), h('small.muted', [r.categoryName, attributeSummary(r.attributes)].filter(Boolean).join(' · '))) },
        { key: 'stock', label: 'On shelf', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
        { key: 'parLevel', label: 'Level', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
        { key: 'unitCost', label: 'Each', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        { key: 'value', label: 'Value', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        { key: 'used90', label: 'Used (90d)', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
        { key: 'daysCover', label: 'Days left', align: 'right', format: (v) => (v == null ? '—' : fmtNum(v, 0)) },
        { key: 'status', label: '', format: statusPill },
        {
          key: 'itemId',
          label: 'Counted',
          align: 'right',
          format: (id) => h('input', {
            type: 'number', step: 'any', min: '0',
            style: { width: '80px' },
            placeholder: '—',
            oninput: (e) => {
              const v = Number(e.target.value);
              if (e.target.value === '' || !Number.isFinite(v)) counts.delete(id);
              else counts.set(id, v);
            },
          }),
        },
      ], data.rows, { rowClass: (r) => (r.status === 'negative' ? 'row-bad' : '') }),
      h('div.btn-row', { style: { marginTop: '.9rem' } },
        h('button.btn-primary', { onclick: saveCounts }, 'Save today’s count'),
      ),
    ),

    data.shrinkage.length
      ? card('Where the count did not match the book', { wide: true },
        table([
          { key: 'name', label: 'Part' },
          { key: 'lastCountDay', label: 'Counted on' },
          { key: 'countVariance', label: 'Difference', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
          {
            key: 'countVarianceValue',
            label: 'Worth',
            align: 'right',
            format: (v) => h(`span.delta.${v < 0 ? 'up' : 'down'}`, fmtMoney(v, { withSymbol: false })),
          },
        ], data.shrinkage),
        h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
          'A shelf holding less than the book says means parts left without being recorded. '
          + 'A small gap is normal; a consistent one is worth asking about.'))
      : null,

    data.idle.length
      ? card('Not touched in three months', { wide: true, note: 'Money standing still' },
        table([
          { key: 'name', label: 'Part', format: (v, r) => h('div', h('div', v), h('small.muted', [r.categoryName, attributeSummary(r.attributes)].filter(Boolean).join(' · '))) },
          { key: 'stock', label: 'On shelf', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
          { key: 'value', label: 'Value', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        ], data.idle),
        h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
          'Not necessarily wrong — some spares exist precisely so you never need them in a hurry. '
          + 'But it is worth knowing how much cash is tied up in them.'))
      : null,
  );

  return host;
}
