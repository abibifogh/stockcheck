import { api } from '../api.js';
import { can } from '../app.js';
import { fmtMoney, fmtNum, h, mount, toast, todayISO } from '../util.js';
import { card, statTile, table } from './components.js';
import { printButton } from '../print.js';

/**
 * The day's sales, one line each, and the reckoning at the end of it.
 *
 * The point of separating cash from card is that only one of the two can be
 * short. If the drawer does not match the cash figure, the difference happened
 * at this counter on this day, and that is a much smaller thing to investigate
 * than "the shop is down this month".
 */
export async function renderShopSales() {
  const day = todayISO();
  const host = h('div');
  const dayInput = h('input', { type: 'date', value: day, max: day });

  const load = async (which) => {
    const [till, list] = await Promise.all([
      api.shopTill(which),
      api.shopSales({ day: which, limit: 200 }),
    ]);
    return { till, sales: list.sales ?? [] };
  };

  const draw = async (which) => {
    const { till, sales } = await load(which);
    const reload = () => draw(dayInput.value || day);

    mount(host,
      h('div.page-head',
        h('div',
          h('h1', 'Sales'),
          h('div.sub', 'Every sale rung up, and what should be in the drawer'),
        ),
        h('div.btn-row',
          printButton({ title: 'Craft shop — sales', subtitle: which }),
          h('label.field', h('span', 'Day'), dayInput),
        ),
      ),

      h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
        statTile({
          label: 'Should be in the drawer',
          value: fmtMoney(till.cash.total),
          sub: `${till.cash.count} cash ${till.cash.count === 1 ? 'sale' : 'sales'}`,
        }),
        statTile({
          label: 'On the card machine',
          value: fmtMoney(till.card.total),
          sub: `${till.card.count} card ${till.card.count === 1 ? 'sale' : 'sales'}`,
        }),
        statTile({
          label: 'Taken altogether',
          value: fmtMoney(till.total),
          sub: `${till.saleCount} ${till.saleCount === 1 ? 'sale' : 'sales'}`,
        }),
        statTile({
          label: 'Voided',
          value: fmtMoney(till.voided.total),
          sub: `${till.voided.count} taken back out`,
          accent: till.voided.count ? 'var(--warn)' : undefined,
        }),
      ),

      till.byPerson.length > 1
        ? card('Who rang them up', { wide: true },
          table([
            { key: 'name', label: 'Person' },
            { key: 'count', label: 'Sales', align: 'right', format: (v) => fmtNum(v, 0) },
            { key: 'total', label: 'Taken', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
          ], till.byPerson))
        : null,

      card('Every sale', { wide: true, note: `${sales.length} on ${which}` },
        sales.length
          ? table([
            { key: 'at', label: 'Time', format: (v) => String(v ?? '').slice(11, 16) },
            { key: 'id', label: 'Sale', format: (v) => `#${v}` },
            {
              key: 'lineCount',
              label: 'Items',
              align: 'right',
              format: (v, r) => `${fmtNum(r.units, 2)} over ${v} ${v === 1 ? 'line' : 'lines'}`,
            },
            {
              key: 'paymentMethod',
              label: 'Paid',
              format: (v) => (v === 'card' ? h('span.pill.info', '💳 card') : h('span.pill', '💵 cash')),
            },
            {
              key: 'changeDue',
              label: 'Change',
              align: 'right',
              format: (v, r) => (r.tendered == null
                ? h('span.muted', '—')
                : `${fmtMoney(r.tendered, { withSymbol: false })} → ${fmtMoney(v, { withSymbol: false })}`),
            },
            { key: 'total', label: 'Total', align: 'right', format: (v) => h('strong', fmtMoney(v, { withSymbol: false })) },
            { key: 'soldBy', label: 'By', format: (v) => v || h('span.muted', '—') },
            {
              key: 'voided',
              label: '',
              format: (v, r) => (v
                ? h('span.pill.bad', { title: r.voidReason ?? '' }, 'voided')
                : h('div.btn-row',
                  h('button.btn-sm.btn-ghost', { onclick: () => showSale(r.id) }, 'Receipt'),
                  can('shop_reports')
                    ? h('button.btn-sm.btn-ghost', { onclick: () => voidSale(r, reload) }, 'Void')
                    : null,
                )),
            },
          ], sales, { rowClass: (r) => (r.voided ? 'row-muted' : '') })
          : h('div.empty', h('p', 'No sales on this day.'))),
    );
  };

  dayInput.onchange = () => draw(dayInput.value || day);
  await draw(day);
  return host;
}

async function showSale(id) {
  let sale;
  try {
    sale = await api.shopSale(id);
  } catch (err) {
    toast(err.message, 'bad');
    return;
  }

  const dialog = h('dialog', {
    style: {
      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      background: 'var(--surface)', color: 'var(--text)',
      maxWidth: '420px', width: '92vw', padding: '1.2rem',
    },
  },
    h('div.card-head',
      h('h2', `Sale #${sale.id}`),
      h('button.btn-sm.btn-ghost', { onclick: () => dialog.close() }, '✕'),
    ),
    h('div.receipt-body',
      h('table',
        h('tbody', sale.lines.map((l) => h('tr',
          h('td', l.name),
          h('td.num', String(l.qty)),
          h('td.num', fmtMoney(l.unitPrice, { withSymbol: false })),
          h('td.num', fmtMoney(l.lineTotal, { withSymbol: false })),
        ))),
        h('tfoot', h('tr',
          h('td', h('strong', 'Total')), h('td'), h('td'),
          h('td.num', h('strong', fmtMoney(sale.total, { withSymbol: false }))),
        )),
      ),
      h('p.muted', { style: { fontSize: '.8rem', marginTop: '.6rem' } },
        `${sale.day} ${String(sale.at ?? '').slice(11, 16)} · `
        + `${sale.paymentMethod === 'card' ? 'Card' : 'Cash'}`
        + (sale.soldBy ? ` · ${sale.soldBy}` : '')
        + (sale.changeDue != null ? ` · change ${fmtMoney(sale.changeDue)}` : '')),
      sale.voided
        ? h('p', { style: { color: 'var(--bad)', fontSize: '.85rem' } },
          `Voided by ${sale.voidedBy}${sale.voidReason ? ` — ${sale.voidReason}` : ''}`)
        : null,
    ),
    h('div.btn-row', { style: { marginTop: '1rem', justifyContent: 'flex-end' } },
      h('button', { onclick: () => window.print() }, '🖨 Print'),
      h('button.btn-primary', { onclick: () => dialog.close() }, 'Close'),
    ),
  );

  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

/**
 * Take a sale back out.
 *
 * Voiding, never deleting: the sale stays on the list with who voided it and
 * why. A till a sale can vanish from is a till that gets robbed, and the whole
 * value of stock control that starts at the counter is that the counter cannot
 * be quietly edited afterwards.
 */
function voidSale(sale, reload) {
  const reason = h('input', {
    type: 'text', maxlength: 200,
    placeholder: 'e.g. rung up twice, customer changed their mind',
  });
  const problem = h('div.form-error.hidden');

  const confirmVoid = async (event) => {
    if (!reason.value.trim()) {
      problem.textContent = 'Say why. This stays on the record.';
      problem.classList.remove('hidden');
      return;
    }
    event.target.disabled = true;
    try {
      await api.shopVoidSale(sale.id, reason.value.trim());
      toast('Voided. The stock goes back on the shelf.', 'good');
      dialog.close();
      reload();
    } catch (err) {
      problem.textContent = err.message;
      problem.classList.remove('hidden');
      event.target.disabled = false;
    }
  };

  const dialog = h('dialog', {
    style: {
      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      background: 'var(--surface)', color: 'var(--text)',
      maxWidth: '460px', width: '92vw', padding: '1.2rem',
    },
  },
    h('div.card-head',
      h('h2', `Void sale #${sale.id}`),
      h('button.btn-sm.btn-ghost', { onclick: () => dialog.close() }, '✕'),
    ),
    h('p', `${fmtMoney(sale.total)} paid by ${sale.paymentMethod}`
      + (sale.soldBy ? `, rung up by ${sale.soldBy}` : '') + '.'),
    h('p.muted', { style: { fontSize: '.85rem' } },
      'The sale stays on the list, marked as voided, with your name against it. '
      + 'It stops counting towards takings and the stock goes back on the shelf.'),
    h('label.field', h('span', 'Why'), reason),
    problem,
    h('div.btn-row', { style: { marginTop: '1rem', justifyContent: 'flex-end' } },
      h('button', { onclick: () => dialog.close() }, 'Cancel'),
      h('button.btn-primary', { onclick: confirmVoid }, 'Void this sale'),
    ),
  );

  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}
