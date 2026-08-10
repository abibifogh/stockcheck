import { api } from '../api.js';
import { fmtDay, fmtMoney, fmtQty, h, mount, toast, todayISO } from '../util.js';
import { card, table } from './components.js';

/**
 * Parts bought: quantity and what was paid.
 *
 * A whole delivery is entered at once — one supplier, one date, several lines —
 * because that is how an invoice arrives. Each line's price is pre-filled with
 * what was last paid for that part, so an unchanged price is no typing at all
 * and a changed one is immediately obvious.
 */
export async function renderMxPurchases() {
  const [data, purchases, lastCosts] = await Promise.all([
    api.mxBootstrap(),
    api.mxPurchases(),
    api.mxLastCosts(),
  ]);

  const host = h('div');
  const lines = [];
  const linesHost = h('div');

  const day = h('input', { type: 'date', value: data.today });
  const supplier = data.settings.supplierMode === 'off'
    ? null
    : (data.suppliers.length
      ? h('select', h('option', { value: '' }, 'No supplier'),
        data.suppliers.map((s) => h('option', { value: s.name }, s.name)))
      : h('input', { type: 'text', placeholder: 'Supplier (optional)', maxlength: 120 }));
  const note = h('input', { type: 'text', placeholder: 'Invoice number or note', maxlength: 300 });

  const addLine = (itemId = null) => {
    lines.push({ itemId, qty: '', unitCost: itemId ? (lastCosts.costs[itemId]?.unitCost ?? '') : '' });
    drawLines();
  };

  const drawLines = () => {
    mount(linesHost,
      lines.length
        ? lines.map((line, index) => {
          const itemSelect = h('select', {
            onchange: (e) => {
              line.itemId = Number(e.target.value) || null;
              // Pre-fill with the last price paid; a price that has not moved
              // then needs no typing at all.
              const last = line.itemId ? lastCosts.costs[line.itemId] : null;
              if (last && !line.unitCost) line.unitCost = last.unitCost;
              drawLines();
            },
          },
            h('option', { value: '' }, 'Choose a part…'),
            data.items.map((i) => h('option', {
              value: String(i.id), selected: line.itemId === i.id,
            }, `${i.name} (${i.unit})`)),
          );

          const item = data.items.find((i) => i.id === line.itemId);
          const last = line.itemId ? lastCosts.costs[line.itemId] : null;

          return h('div.mx-delivery-line',
            itemSelect,
            h('input', {
              type: 'number', step: 'any', min: '0', placeholder: 'Quantity',
              value: String(line.qty ?? ''),
              oninput: (e) => { line.qty = e.target.value; updateTotal(); },
            }),
            h('input', {
              type: 'number', step: 'any', min: '0', placeholder: 'Price each',
              value: String(line.unitCost ?? ''),
              oninput: (e) => { line.unitCost = e.target.value; updateTotal(); },
            }),
            h('span.muted', { style: { fontSize: '.8rem', minWidth: '92px' } },
              item ? `per ${item.unit}` : '',
              last ? h('div', `last: ${fmtMoney(last.unitCost, { withSymbol: false })}`) : null),
            h('button.btn-ghost.btn-sm', {
              onclick: () => { lines.splice(index, 1); drawLines(); },
            }, '✕'),
          );
        })
        : h('p.muted', { style: { fontSize: '.88rem' } }, 'No lines yet. Add the first item below.'),
      h('div.btn-row', { style: { marginTop: '.7rem' } },
        h('button.btn-sm', { onclick: () => addLine() }, '+ Add an item'),
        h('div', { style: { flex: 1 } }),
        h('strong.mx-delivery-total', totalText()),
      ),
    );
  };

  const totalText = () => {
    const total = lines.reduce((n, l) => n + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0);
    return `Delivery total: ${fmtMoney(total)}`;
  };

  const updateTotal = () => {
    const el = host.querySelector('.mx-delivery-total');
    if (el) el.textContent = totalText();
  };

  const save = async (event) => {
    const clean = lines
      .filter((l) => l.itemId && Number(l.qty) > 0)
      .map((l) => ({ itemId: l.itemId, qty: Number(l.qty), unitCost: Number(l.unitCost) || 0 }));

    if (!clean.length) { toast('Add at least one item with a quantity', 'bad'); return; }

    event.target.disabled = true;
    try {
      await api.mxCreateDelivery({
        day: day.value || data.today,
        supplier: supplier ? (supplier.value || '').trim() || null : null,
        note: note.value.trim() || null,
        lines: clean,
      });
      toast(`Delivery of ${clean.length} ${clean.length === 1 ? 'item' : 'items'} recorded`, 'good');
      mount(host, await renderMxPurchases());
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  addLine();

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Parts bought'),
        h('div.sub', 'Record what came in, and what it cost'),
      ),
    ),

    card('Record a delivery', { wide: true, note: 'One supplier, one date, as many items as arrived' },
      h('div.field-row',
        h('label.field', h('span', 'Date'), day),
        supplier ? h('label.field', h('span', 'Supplier'), supplier) : null,
        h('label.field', h('span', 'Invoice or note'), note),
      ),
      h('div', { style: { marginTop: '.9rem' } }, linesHost),
      h('div.btn-row', { style: { marginTop: '1rem' } },
        h('button.btn-primary', { onclick: save }, 'Save delivery'),
      ),
      h('p.muted', { style: { fontSize: '.82rem', marginTop: '.8rem', marginBottom: 0 } },
        'Each price starts at what you last paid. Leaving it alone says the price has not moved; '
        + 'changing it is what makes a price rise show up in the reports on the day it happened.'),
    ),

    card('Recent deliveries', { wide: true },
      table([
        { key: 'day', label: 'Date', format: (v) => fmtDay(v, { withYear: true }) },
        { key: 'item_name', label: 'Part' },
        { key: 'qty', label: 'Quantity', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
        { key: 'unit_cost', label: 'Each', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        {
          key: 'id',
          label: 'Total',
          align: 'right',
          format: (_v, r) => h('strong', fmtMoney(Number(r.qty) * Number(r.unit_cost), { withSymbol: false })),
        },
        { key: 'supplier', label: 'Supplier', format: (v) => v || h('span.muted', '—') },
        { key: 'note', label: 'Note', format: (v) => (v ? h('span.muted', v) : '—') },
        {
          key: 'id',
          label: '',
          format: (id) => h('button.btn-sm.btn-ghost', {
            onclick: async () => {
              if (!confirm('Remove this purchase? Stock and costs will be recalculated.')) return;
              try {
                await api.mxDeletePurchase(id);
                toast('Purchase removed');
                mount(host, await renderMxPurchases());
              } catch (err) { toast(err.message, 'bad'); }
            },
          }, 'Remove'),
        },
      ], purchases.purchases, { empty: 'Nothing bought yet.' })),
  );

  return host;
}
