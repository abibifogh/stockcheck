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
          // Neither of these changes anything on its own. What is already
          // recorded moves when an administrator accepts the request, which is
          // why the wording is "ask" and the confirmation says what happens next.
          format: (id, row) => h('div.btn-row',
            h('button.btn-sm.btn-ghost', {
              onclick: () => editPurchase(row, async () => {
                mount(host, await renderMxPurchases());
              }),
            }, 'Correct'),
            h('button.btn-sm.btn-ghost', {
              onclick: async () => {
                const reason = prompt('Ask to remove this delivery. Why?\n\n'
                  + 'Nothing changes until an administrator accepts it.');
                if (reason === null) return;
                try {
                  await api.mxDeletePurchase(id, reason.trim() || null);
                  toast('Sent to an administrator — nothing has moved yet', 'good');
                  mount(host, await renderMxPurchases());
                } catch (err) { toast(err.message, 'bad'); }
              },
            }, 'Remove'),
          ),
        },
      ], purchases.purchases, { sortable: true, empty: 'Nothing bought yet.' })),
  );

  return host;
}


/**
 * Ask for a delivery to be corrected.
 *
 * The part itself is not editable. Changing which item a delivery is about is
 * not a correction but a different delivery, and letting it through here would
 * move stock on two items from one signature.
 */
function editPurchase(row, onSent) {
  const day = h('input', { type: 'date', value: row.day });
  const qty = h('input', { type: 'number', min: '0', step: '0.01', value: row.qty });
  const unitCost = h('input', { type: 'number', min: '0', step: '0.01', value: row.unit_cost });
  const supplier = h('input', { type: 'text', value: row.supplier ?? '', maxlength: 120 });
  const note = h('input', { type: 'text', value: row.note ?? '', maxlength: 300 });
  const reason = h('input', { type: 'text', placeholder: 'Why it needs changing', maxlength: 300 });

  const dialog = h('dialog', {
    style: {
      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      background: 'var(--surface)', color: 'var(--text)',
      maxWidth: '560px', width: '92vw', padding: '1.2rem',
    },
  },
    h('div.card-head',
      h('h2', `Correct ${row.item_name}`),
      h('button.btn-sm.btn-ghost', { onclick: () => dialog.close() }, '✕'),
    ),
    h('p.muted', { style: { fontSize: '.85rem', marginTop: 0 } },
      'This asks for the change. The delivery stays exactly as it is, and stock and costs '
      + 'stay where they are, until an administrator accepts it.'),
    h('div.field-row',
      h('label.field', h('span', 'Date'), day),
      h('label.field', h('span', 'Quantity'), qty),
      h('label.field', h('span', 'Each'), unitCost),
      h('label.field', h('span', 'Supplier'), supplier),
    ),
    h('label.field', { style: { marginTop: '.6rem' } }, h('span', 'Note'), note),
    h('label.field', { style: { marginTop: '.6rem' } }, h('span', 'Reason'), reason),
    h('div.btn-row', { style: { marginTop: '1rem' } },
      h('button.btn-primary', {
        onclick: async (event) => {
          event.target.disabled = true;
          try {
            await api.mxUpdatePurchase(row.id, {
              day: day.value,
              qty: Number(qty.value),
              unitCost: Number(unitCost.value),
              supplier: supplier.value.trim() || null,
              note: note.value.trim() || null,
              reason: reason.value.trim() || null,
            });
            toast('Sent to an administrator — nothing has moved yet', 'good');
            dialog.close();
            onSent();
          } catch (err) {
            toast(err.message, 'bad');
            event.target.disabled = false;
          }
        },
      }, 'Ask for this change'),
      h('button', { onclick: () => dialog.close() }, 'Cancel'),
    ),
  );

  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
