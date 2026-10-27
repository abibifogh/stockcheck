import { api } from '../api.js';
import { can, state } from '../app.js';
import { fmtDay, fmtMoney, fmtNum, h, mount, shiftDay, toast, todayISO } from '../util.js';
import { card, exportButton, statTile, table } from './components.js';
import { odooImportCard } from './odoo-import.js';

/**
 * Delivery log. Every delivery keyed here feeds the weighted average cost, so
 * this is what makes the money side of the analytics real rather than nominal.
 */
export async function renderPurchases(params) {
  const to = params.to || todayISO();
  const from = params.from || shiftDay(to, -60);

  const [data, supplierData] = await Promise.all([
    api.purchases(from, to),
    api.suppliers().catch(() => ({ suppliers: [] })),
  ]);

  const host = h('div');
  const reload = async () => mount(host, await renderPurchases({ from, to }));
  const rerange = (nextFrom, nextTo) => {
    renderPurchases({ from: nextFrom, to: nextTo }).then((view) => mount(host, view));
  };

  const supplierMode = state.settings.supplier_mode || 'suggest';
  const suppliers = (supplierData.suppliers || []).filter((s) => s.active);

  // The figures and the list redraw on their own after an Odoo import, so the
  // import panel — and the report of what it just did — stays where it is.
  const dataHost = h('div');
  const refresh = async () => {
    try {
      mount(dataHost, ...dataSection(await api.purchases(from, to), { from, to, suppliers, refresh }));
    } catch (err) { toast(err.message, 'bad'); }
  };
  mount(dataHost, ...dataSection(data, { from, to, suppliers, refresh }));

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Purchases'),
        h('div.sub', 'Recording deliveries keeps unit costs, stock levels and every money figure accurate'),
      ),
      exportButton(api.exportUrl('purchases', from, to), 'Export purchases'),
    ),
    h('div.toolbar',
      h('input', { type: 'date', value: from, onchange: (e) => rerange(e.target.value, to) }),
      h('span.muted', 'to'),
      h('input', { type: 'date', value: to, onchange: (e) => rerange(from, e.target.value) }),
    ),
    await odooImportCard({ onImported: refresh }),
    card('Record a delivery', { note: 'For anything not on an Odoo order — add every item, then save once', wide: true },
      deliveryForm({ suppliers, supplierMode, lastCosts: data.lastCosts || {}, onSaved: reload }),
    ),
    dataHost,
  );
  return host;
}

/** The tiles and the delivery list for a range. */
function dataSection(data, { from, to, suppliers, refresh }) {
  const total = data.purchases.reduce((a, p) => a + Number(p.qty) * Number(p.unit_cost), 0);
  const bySupplier = new Map();
  for (const p of data.purchases) {
    const key = p.supplier || 'Unspecified';
    bySupplier.set(key, (bySupplier.get(key) || 0) + Number(p.qty) * Number(p.unit_cost));
  }
  const ranked = [...bySupplier.entries()].sort((a, b) => b[1] - a[1]);

  const tiles = h('div.grid.grid-3', { style: { marginBottom: '1rem' } },
    statTile({ label: 'Purchases in range', value: fmtMoney(total, { compact: true }), sub: `${data.purchases.length} lines` }),
    statTile({ label: 'Suppliers used', value: fmtNum(bySupplier.size, 0), sub: `${suppliers.length} on the list` }),
    statTile({
      label: 'Largest supplier',
      value: ranked[0]?.[0] ?? '—',
      sub: fmtMoney(ranked[0]?.[1] ?? 0, { compact: true }),
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
      { key: 'po_ref', label: 'PO', format: (v) => (v ? h('span.pill.info.po-ref', v) : h('span.muted', '—')) },
      { key: 'note', label: 'Note', format: (v) => v || h('span.muted', '—') },
      {
        key: 'id',
        label: '',
        format: (id, row) => h('button.btn-sm.btn-danger', {
          onclick: async () => {
            const ask = row.po_ref
              ? `Delete this line? Costs and stock will be recalculated. It came from ${row.po_ref}, so importing that PO again would bring it back.`
              : 'Delete this line? Costs and stock will be recalculated.';
            if (!confirm(ask)) return;
            try {
              await api.deletePurchase(id);
              toast('Line deleted', 'good');
              refresh();
            } catch (err) { toast(err.message, 'bad'); }
          },
        }, 'Delete'),
      },
    ], data.purchases, { empty: 'No deliveries recorded in this range.' }),
  );

  return [tiles, listCard];
}

/**
 * One delivery, many lines. A delivery note lists several things at once, so
 * the form matches the piece of paper the person is holding.
 *
 * Each line's unit cost is pre-filled with what was last paid for that item —
 * prices seldom move between deliveries, and when they do, the person keying it
 * in is the one holding the invoice. The last-paid figure is shown next to the
 * field so a change is obvious rather than silent.
 */
function deliveryForm({ suppliers, supplierMode, lastCosts, onSaved }) {
  const ingredients = state.catalog.ingredients.filter((i) => i.active);
  const currency = state.settings.currency || 'GHS';

  const day = h('input', { type: 'date', value: todayISO() });
  const note = h('input', { type: 'text', placeholder: 'Invoice number, driver…' });

  // Suggest: pick from the list (key suppliers first, from Insight), or type one it does not have.
  const pickList = supplierMode === 'suggest'
    ? h('datalist', { id: 'supplier-pick' }, suppliers.map((s) => h('option', { value: s.name }, s.key_supplier ? `★ ${s.grp || 'Key supplier'}` : '')))
    : null;
  const supplierField = supplierMode === 'off'
    ? null
    : supplierMode === 'suggest'
      ? (() => {
        const input = h('input', { type: 'text', placeholder: 'Choose or type a supplier', autocomplete: 'off' });
        input.setAttribute('list', 'supplier-pick');
        return input;
      })()
    : supplierMode === 'select'
      ? h('select',
        h('option', { value: '' }, suppliers.length ? 'Choose supplier…' : 'No suppliers set up yet'),
        suppliers.map((s) => h('option', { value: s.name }, s.name)))
      : h('input', { type: 'text', placeholder: 'Supplier name' });

  const rows = [];
  const rowsHost = h('div', { style: { display: 'grid', gap: '.5rem' } });
  const totalOut = h('div.stat-value', fmtMoney(0));

  const recompute = () => {
    let total = 0;
    for (const row of rows) {
      if (!row.el.isConnected) continue;
      total += (Number(row.qty.value) || 0) * (Number(row.cost.value) || 0);
    }
    totalOut.textContent = fmtMoney(total);
  };

  function addRow() {
    const select = h('select',
      h('option', { value: '' }, 'Choose item…'),
      ingredients.map((i) => h('option', { value: i.id }, `${i.name} (${i.unit})`)),
    );
    const qty = h('input', { type: 'number', min: '0.01', step: '0.01', placeholder: 'Qty' });
    const cost = h('input', { type: 'number', min: '0', step: '0.01', placeholder: 'Unit cost' });
    const unitLabel = h('span.muted', { style: { fontSize: '.8rem', alignSelf: 'center' } }, '');
    const lastHint = h('div.item-hint', { style: { gridColumn: '1 / -1', marginTop: '-.15rem' } });

    const paintHint = () => {
      const id = Number(select.value);
      const ing = ingredients.find((i) => i.id === id);
      unitLabel.textContent = ing ? ing.unit : '';
      const last = lastCosts[id];

      if (!ing) { mount(lastHint); return; }
      if (last) {
        mount(lastHint,
          h('span.muted', `last paid ${fmtMoney(last.unitCost)} on ${fmtDay(last.day)}`),
          last.supplier ? h('span.muted', `· ${last.supplier}`) : null,
        );
      } else {
        mount(lastHint, h('span.muted', 'no delivery recorded for this item yet'));
      }
    };

    select.addEventListener('change', () => {
      const id = Number(select.value);
      const ing = ingredients.find((i) => i.id === id);
      const last = lastCosts[id];
      // Pre-fill from the last price paid, falling back to the fallback cost in
      // Setup. Only fill an untouched field, so a typed figure is never
      // overwritten by switching the item back and forth.
      if (!cost.dataset.touched) {
        cost.value = last ? last.unitCost : (Number(ing?.default_unit_cost) || '');
      }
      paintHint();
      recompute();
    });

    cost.addEventListener('input', () => { cost.dataset.touched = '1'; recompute(); });
    qty.addEventListener('input', recompute);

    const el = h('div', {
      style: {
        display: 'grid', gridTemplateColumns: '2.2fr 1fr 1fr auto auto', gap: '.4rem',
        alignItems: 'start', padding: '.5rem', background: 'var(--surface-2)',
        borderRadius: 'var(--radius-sm)',
      },
    },
      select, qty, cost, unitLabel,
      h('button.btn-sm.btn-ghost', {
        onclick: () => {
          if (rows.filter((r) => r.el.isConnected).length <= 1) {
            toast('A delivery needs at least one line', 'bad');
            return;
          }
          el.remove();
          recompute();
        },
        title: 'Remove this line',
      }, '✕'),
      lastHint,
    );

    rows.push({ el, select, qty, cost });
    rowsHost.append(el);
    return el;
  }

  addRow();

  const save = async (event) => {
    const items = rows
      .filter((r) => r.el.isConnected && r.select.value && r.qty.value)
      .map((r) => ({
        ingredient_id: Number(r.select.value),
        qty: Number(r.qty.value),
        unit_cost: Number(r.cost.value) || 0,
      }));

    if (!items.length) {
      toast('Add at least one item with a quantity', 'bad');
      return;
    }
    if (supplierMode === 'select' && supplierField && !supplierField.value) {
      toast('Choose the supplier', 'bad');
      return;
    }

    event.target.disabled = true;
    try {
      const result = await api.createDelivery({
        day: day.value,
        supplier: supplierField ? supplierField.value || null : null,
        note: note.value || null,
        items,
      });
      toast(`Delivery saved — ${result.lines} items, ${fmtMoney(result.total)}`, 'good');
      onSaved();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const supplierHelp = supplierMode === 'select' && !suppliers.length
    ? h('p.muted', { style: { fontSize: '.82rem' } },
      can('setup')
        ? 'No suppliers on the list yet. Add them under Setup → Suppliers, or switch to free typing there.'
        : 'No suppliers on the list yet — ask an administrator to add them under Setup.')
    : null;

  return h('div',
    h('div.field-row',
      h('label.field', h('span', 'Delivery date'), day),
      supplierField ? h('label.field', h('span', 'Supplier'), supplierField, pickList) : null,
      h('label.field', h('span', 'Note (optional)'), note),
    ),
    supplierHelp,
    h('div.stat-label', { style: { margin: '.4rem 0' } }, `Items delivered (unit costs in ${currency})`),
    rowsHost,
    h('button.btn-sm', { style: { marginTop: '.6rem' }, onclick: () => { addRow(); recompute(); } },
      '+ Add another item'),
    h('div.btn-row', { style: { marginTop: '1rem', justifyContent: 'space-between', alignItems: 'flex-end' } },
      h('div', h('div.stat-label', 'Delivery total'), totalOut),
      h('button.btn-primary', { onclick: save }, 'Save delivery'),
    ),
  );
}
