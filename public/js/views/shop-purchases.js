import { api } from '../api.js';
import {
  attributeSummary, fmtDay, fmtMoney, fmtNum, h, mount, toast,
} from '../util.js';
import { card, table } from './components.js';

/**
 * Stock bought in for the craft shop.
 *
 * The same delivery form as the parts store, for the same reason: a delivery
 * arrives as one lot with one supplier and one date, and typing it in one line
 * at a time is how half of it never gets typed in at all.
 */
export async function renderShopPurchases() {
  const [data, recent, costs] = await Promise.all([
    api.shopBootstrap(),
    api.shopPurchases(),
    api.shopLastCosts().catch(() => ({ costs: {} })),
  ]);

  const host = h('div');
  const reload = async () => mount(host, await renderShopPurchases());

  const day = h('input', { type: 'date', value: data.today, max: data.today });
  const supplier = h('input', { type: 'text', placeholder: 'Who it came from', maxlength: 120 });
  const note = h('input', { type: 'text', placeholder: 'Note (optional)', maxlength: 300 });

  const linesHost = h('div');
  const lines = [];

  const addLine = () => {
    const select = h('select',
      h('option', { value: '' }, 'Choose a product…'),
      data.items.map((i) => h('option', { value: String(i.id) },
        [i.name, attributeSummary(i.attributes)].filter(Boolean).join(' · '))),
    );
    const qty = h('input', { type: 'number', min: '0', step: 'any', placeholder: 'Quantity' });
    const cost = h('input', { type: 'number', min: '0', step: '0.01', placeholder: 'Cost each' });
    const total = h('span.muted', { style: { fontSize: '.85rem', minWidth: '80px', textAlign: 'right' } }, '—');

    const recalc = () => {
      const value = Number(qty.value) * Number(cost.value);
      total.textContent = Number.isFinite(value) && value > 0
        ? fmtMoney(value, { withSymbol: false }) : '—';
    };
    qty.oninput = recalc;
    cost.oninput = recalc;

    // Pre-fill the last price paid: most deliveries repeat the last one, and a
    // wrong-but-editable number gets corrected far more often than a blank one
    // gets filled.
    select.onchange = () => {
      const last = costs.costs?.[select.value];
      if (last && !cost.value) { cost.value = String(last.unitCost); recalc(); }
    };

    const entry = { select, qty, cost };
    lines.push(entry);

    const row = h('div.mx-delivery-line',
      select, qty, cost, total,
      h('button.btn-ghost.btn-sm', {
        onclick: () => {
          const index = lines.indexOf(entry);
          if (index >= 0) lines.splice(index, 1);
          row.remove();
        },
      }, '✕'),
    );
    linesHost.append(row);
  };

  const save = async (event) => {
    const clean = lines
      .filter((l) => l.select.value && Number(l.qty.value) > 0)
      .map((l) => ({
        itemId: Number(l.select.value),
        qty: Number(l.qty.value),
        unitCost: Number(l.cost.value) || 0,
      }));

    if (!clean.length) { toast('Add at least one product with a quantity', 'bad'); return; }

    event.target.disabled = true;
    try {
      await api.shopCreateDelivery({
        day: day.value || data.today,
        supplier: supplier.value.trim() || null,
        note: note.value.trim() || null,
        lines: clean,
      });
      toast(`${clean.length} ${clean.length === 1 ? 'line' : 'lines'} recorded`, 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  addLine();
  addLine();

  const purchases = recent.purchases ?? [];
  const spend = purchases.reduce((n, p) => n + Number(p.qty) * Number(p.unit_cost), 0);

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Stock bought in'),
        h('div.sub', 'What came into the shop, and what it cost'),
      ),
    ),

    card('Record a delivery', { wide: true, note: 'One supplier, one date, as many lines as you need' },
      h('div.field-row',
        h('label.field', h('span', 'Date'), day),
        h('label.field', h('span', 'Supplier'), supplier),
        h('label.field', h('span', 'Note'), note),
      ),
      h('div', { style: { marginTop: '.9rem' } },
        h('div.mx-delivery-line', { style: { fontSize: '.76rem', color: 'var(--text-faint)' } },
          h('span', 'PRODUCT'), h('span', 'QUANTITY'), h('span', 'COST EACH'),
          h('span', { style: { textAlign: 'right' } }, 'LINE TOTAL'), h('span'),
        ),
        linesHost,
      ),
      h('div.btn-row', { style: { marginTop: '.7rem' } },
        h('button.btn-sm', { onclick: addLine }, '+ Add a line'),
        h('button.btn-primary', { onclick: save }, 'Record this delivery'),
      ),
      h('p.muted', { style: { fontSize: '.82rem', marginTop: '.8rem', marginBottom: 0 } },
        'The cost you type here is what the shop paid. It is what every margin figure is '
        + 'measured against, and it is never shown on the till screen.'),
    ),

    card('Recent deliveries', {
      wide: true,
      note: purchases.length
        ? `${purchases.length} lines · ${fmtMoney(spend)} spent`
        : 'nothing recorded yet',
    },
      purchases.length
        ? table([
          { key: 'day', label: 'Date', format: (v) => fmtDay(v) },
          { key: 'item_name', label: 'Product' },
          { key: 'qty', label: 'Quantity', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
          { key: 'unit_cost', label: 'Cost each', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
          {
            key: 'id',
            label: 'Total',
            align: 'right',
            format: (v, r) => h('strong', fmtMoney(Number(r.qty) * Number(r.unit_cost), { withSymbol: false })),
          },
          { key: 'supplier', label: 'From', format: (v) => v || h('span.muted', '—') },
          {
            key: 'created_at',
            label: '',
            format: (v, r) => h('button.btn-sm.btn-ghost', {
              onclick: async (event) => {
                if (!confirm('Remove this delivery line? Stock and costs go back to what they were.')) return;
                event.target.disabled = true;
                try {
                  await api.shopDeletePurchase(r.id);
                  toast('Removed', 'good');
                  reload();
                } catch (err) {
                  toast(err.message, 'bad');
                  event.target.disabled = false;
                }
              },
            }, 'Remove'),
          },
        ], purchases)
        : h('div.empty', h('p', 'No deliveries recorded yet.'))),
  );

  return host;
}
