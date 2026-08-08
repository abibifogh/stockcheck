import { api } from '../api.js';
import { state } from '../app.js';
import { fmtDay, fmtMoney, fmtNum, h, mount, shiftDay, toast, todayISO } from '../util.js';
import { card, exportButton, statTile, table } from './components.js';

/**
 * Purchase log. Every delivery keyed here feeds the weighted average cost, so
 * this is what makes the money side of the analytics real rather than nominal.
 */
export async function renderPurchases(params) {
  const to = params.to || todayISO();
  const from = params.from || shiftDay(to, -60);
  const data = await api.purchases(from, to);
  const host = h('div');

  const reload = async () => mount(host, await renderPurchases({ from, to }));

  const total = data.purchases.reduce((a, p) => a + Number(p.qty) * Number(p.unit_cost), 0);
  const bySupplier = new Map();
  for (const p of data.purchases) {
    const key = p.supplier || 'Unspecified';
    bySupplier.set(key, (bySupplier.get(key) || 0) + Number(p.qty) * Number(p.unit_cost));
  }

  const tiles = h('div.grid.grid-3', { style: { marginBottom: '1rem' } },
    statTile({ label: 'Purchases in range', value: fmtMoney(total, { compact: true }), sub: `${data.purchases.length} deliveries` }),
    statTile({ label: 'Suppliers', value: fmtNum(bySupplier.size, 0), sub: 'distinct suppliers used' }),
    statTile({
      label: 'Largest supplier',
      value: [...bySupplier.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—',
      sub: fmtMoney([...bySupplier.values()].sort((a, b) => b - a)[0] ?? 0, { compact: true }),
    }),
  );

  const listCard = card('Deliveries', { note: `${fmtDay(from)} → ${fmtDay(to)}`, wide: true },
    table([
      { key: 'day', label: 'Date', format: (v) => fmtDay(v) },
      { key: 'ingredient_name', label: 'Ingredient' },
      { key: 'qty', label: 'Quantity', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
      { key: 'unit_cost', label: 'Unit cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      { key: 'total', label: 'Total', align: 'right', format: (_, r) => h('b', fmtMoney(Number(r.qty) * Number(r.unit_cost), { withSymbol: false })) },
      { key: 'supplier', label: 'Supplier', format: (v) => v || h('span.muted', '—') },
      { key: 'note', label: 'Note', format: (v) => v || h('span.muted', '—') },
      {
        key: 'id',
        label: '',
        format: (id) => h('button.btn-sm.btn-danger', {
          onclick: async () => {
            if (!confirm('Delete this purchase? Costs and stock will be recalculated.')) return;
            try {
              await api.deletePurchase(id);
              toast('Purchase deleted', 'good');
              reload();
            } catch (err) {
              toast(err.message, 'bad');
            }
          },
        }, 'Delete'),
      },
    ], data.purchases, { empty: 'No purchases recorded in this range.' }),
  );

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Purchases'),
        h('div.sub', 'Recording deliveries keeps unit costs, stock levels and every money figure accurate'),
      ),
      exportButton(api.exportUrl('purchases', from, to), 'Export purchases'),
    ),
    h('div.toolbar',
      h('input', { type: 'date', value: from, onchange: (e) => mount(host, renderPurchasesSync(e.target.value, to, host)) }),
      h('span.muted', 'to'),
      h('input', { type: 'date', value: to, onchange: (e) => mount(host, renderPurchasesSync(from, e.target.value, host)) }),
    ),
    tiles,
    card('Record a delivery', {}, purchaseForm(reload)),
    listCard,
  );
  return host;
}

// Date-range changes re-enter the async renderer; this keeps the swap tidy.
function renderPurchasesSync(from, to, host) {
  renderPurchases({ from, to }).then((view) => mount(host, view));
  return h('div.card', h('div.skeleton', { style: { height: '80px' } }));
}

function purchaseForm(onSaved) {
  const day = h('input', { type: 'date', value: todayISO() });
  const ingredient = h('select',
    h('option', { value: '' }, 'Choose ingredient…'),
    state.catalog.ingredients.filter((i) => i.active).map((i) =>
      h('option', { value: i.id, dataset: { unit: i.unit, cost: i.default_unit_cost } }, `${i.name} (${i.unit})`)),
  );
  const qty = h('input', { type: 'number', min: '0.01', step: '0.01', placeholder: '0' });
  const unitCost = h('input', { type: 'number', min: '0', step: '0.01', placeholder: '0.00' });
  const supplier = h('input', { type: 'text', placeholder: 'Supplier name' });
  const note = h('input', { type: 'text', placeholder: 'Optional note' });
  const totalOut = h('div.stat-value', fmtMoney(0));

  const recompute = () => {
    totalOut.textContent = fmtMoney((Number(qty.value) || 0) * (Number(unitCost.value) || 0));
  };
  qty.addEventListener('input', recompute);
  unitCost.addEventListener('input', recompute);
  ingredient.addEventListener('change', () => {
    const opt = ingredient.selectedOptions[0];
    if (opt?.dataset.cost && !unitCost.value) {
      unitCost.value = opt.dataset.cost;
      recompute();
    }
  });

  return h('div',
    h('div.field-row',
      h('label.field', h('span', 'Date'), day),
      h('label.field', h('span', 'Ingredient'), ingredient),
      h('label.field', h('span', 'Quantity'), qty),
      h('label.field', h('span', `Unit cost (${state.settings.currency || 'GHS'})`), unitCost),
      h('label.field', h('span', 'Supplier'), supplier),
      h('label.field', h('span', 'Note'), note),
    ),
    h('div.btn-row', { style: { justifyContent: 'space-between' } },
      h('div', h('div.stat-label', 'Delivery total'), totalOut),
      h('button.btn-primary', {
        onclick: async (event) => {
          if (!ingredient.value || !qty.value) {
            toast('Choose an ingredient and enter a quantity', 'bad');
            return;
          }
          event.target.disabled = true;
          try {
            await api.createPurchase({
              day: day.value,
              ingredient_id: Number(ingredient.value),
              qty: Number(qty.value),
              unit_cost: Number(unitCost.value) || 0,
              supplier: supplier.value || null,
              note: note.value || null,
            });
            toast('Delivery recorded', 'good');
            onSaved();
          } catch (err) {
            toast(err.message, 'bad');
            event.target.disabled = false;
          }
        },
      }, 'Save delivery'),
    ),
  );
}
