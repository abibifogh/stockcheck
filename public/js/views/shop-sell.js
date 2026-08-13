import { api } from '../api.js';
import {
  attributeSearchText, attributeSummary, fmtMoney, h, mount, toast,
} from '../util.js';
import { card } from './components.js';

/**
 * The craft shop till.
 *
 * A customer is standing at the counter. Everything here is arranged around
 * that one fact: the basket is always visible, prices are large, and completing
 * a sale takes one tap once the goods are in. Nothing on this screen asks a
 * question that could have waited until the customer has gone.
 *
 * Cost prices are deliberately absent. An assistant needs to know what to
 * charge, not what the shop paid, and a till screen is read over shoulders.
 */
export async function renderShopSell() {
  const [data, till, recent] = await Promise.all([
    api.shopBootstrap(),
    api.shopTill().catch(() => null),
    api.shopSales({ limit: 8 }).catch(() => ({ sales: [] })),
  ]);

  const host = h('div');
  const basket = new Map(); // itemId -> qty
  let method = 'cash';
  let filter = '';
  let categoryId = null;
  let showAll = false;

  const itemHost = h('div');
  const basketHost = h('div.till-basket');

  const itemById = new Map(data.items.map((i) => [i.id, i]));

  // -------------------------------------------------------------- goods --

  const add = (item, by = 1) => {
    const next = Math.round(((basket.get(item.id) ?? 0) + by) * 1000) / 1000;
    if (next <= 0) basket.delete(item.id);
    else basket.set(item.id, next);
    drawItems();
    drawBasket();
  };

  const drawItems = () => {
    let shown = data.items;
    if (filter) {
      shown = shown.filter((i) => i.name.toLowerCase().includes(filter)
        || (i.sku ?? '').toLowerCase().includes(filter)
        || attributeSearchText(i.attributes).includes(filter));
    } else {
      if (categoryId != null) shown = shown.filter((i) => i.categoryId === categoryId);
      else if (!showAll) shown = shown.filter((i) => i.isCommon);
    }

    const chip = (label, on, onclick) => h('button.mx-chip', {
      class: on ? 'mx-chip on' : 'mx-chip', onclick,
    }, label);

    mount(itemHost,
      h('input.mx-search', {
        type: 'search',
        placeholder: 'Find by name or code…',
        value: filter,
        oninput: (e) => { filter = e.target.value.trim().toLowerCase(); drawItems(); },
      }),
      filter ? null : h('div.mx-chips', { style: { marginTop: '.55rem' } },
        chip('Everyday', categoryId == null && !showAll, () => {
          categoryId = null; showAll = false; drawItems();
        }),
        ...data.categories.map((c) => chip(c.name, categoryId === c.id, () => {
          categoryId = categoryId === c.id ? null : c.id;
          showAll = false;
          drawItems();
        })),
        chip(`Everything (${data.items.length})`, showAll && categoryId == null, () => {
          showAll = true; categoryId = null; drawItems();
        }),
      ),
      h('div.till-grid', { style: { marginTop: '.7rem' } }, shown.map((item) => {
        const qty = basket.get(item.id) ?? 0;
        // A product nobody priced cannot be sold, and finding that out only
        // after tapping it — with a customer waiting — is the worst moment.
        const sellable = item.sellPrice > 0;
        return h('button.till-tile', {
          class: `till-tile${qty ? ' on' : ''}${sellable ? '' : ' unpriced'}`,
          disabled: !sellable,
          title: sellable ? item.name : `${item.name} has no price yet`,
          onclick: () => add(item),
        },
          h('span.till-tile-name', item.name),
          attributeSummary(item.attributes)
            ? h('span.till-tile-attrs', attributeSummary(item.attributes))
            : null,
          h('span.till-tile-price', sellable ? fmtMoney(item.sellPrice) : 'no price yet'),
          qty ? h('span.till-tile-qty', String(qty)) : null,
        );
      })),
      shown.length ? null : h('p.muted', { style: { fontSize: '.87rem' } },
        data.items.length ? 'Nothing matches that.'
          : 'No products yet. A manager can add them under Craft shop → Setup.'),
    );
  };

  // ------------------------------------------------------------ payment --

  const tendered = h('input.till-tender', {
    type: 'number', min: '0', step: '0.01', placeholder: '0.00', inputmode: 'decimal',
    oninput: () => drawChange(),
  });

  const changeLine = h('div.till-change');

  const total = () => Math.round([...basket.entries()]
    .reduce((n, [id, qty]) => n + (itemById.get(id)?.sellPrice ?? 0) * qty, 0) * 100) / 100;

  const drawChange = () => {
    const due = total();
    const given = Number(tendered.value);
    if (method !== 'cash' || !tendered.value || !Number.isFinite(given)) {
      mount(changeLine, h('span.muted', method === 'cash'
        ? 'Type what the customer hands over and the change appears here.'
        : 'Paid by card — no change to work out.'));
      return;
    }
    if (given < due) {
      mount(changeLine, h('span.till-change-short', `Short by ${fmtMoney(due - given)}`));
      return;
    }
    mount(changeLine,
      h('span.muted', 'Change'),
      h('strong.till-change-amount', fmtMoney(given - due)),
    );
  };

  const methodButtons = h('div.till-methods');
  const drawMethods = () => {
    mount(methodButtons, ['cash', 'card'].map((key) => h('button.till-method', {
      class: method === key ? 'till-method on' : 'till-method',
      onclick: () => {
        method = key;
        if (key === 'card') tendered.value = '';
        drawMethods();
        drawBasket();
      },
    }, key === 'cash' ? '💵 Cash' : '💳 Card')));
  };

  // ------------------------------------------------------------- basket --

  const drawBasket = () => {
    const lines = [...basket.entries()]
      .map(([id, qty]) => ({ item: itemById.get(id), qty }))
      .filter((l) => l.item);
    const due = total();

    drawMethods();

    mount(basketHost,
      h('div.till-basket-inner',
        h('div.till-lines',
          lines.length
            ? lines.map(({ item, qty }) => h('div.till-line',
              h('div.till-line-main',
                h('span.till-line-name', item.name),
                h('span.till-line-each', `${qty} × ${fmtMoney(item.sellPrice)}`),
              ),
              h('div.mx-step',
                h('button', { onclick: () => add(item, -1) }, '−'),
                h('input', {
                  type: 'number', value: String(qty), min: '0', step: 'any',
                  oninput: (e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v) || v <= 0) basket.delete(item.id);
                    else basket.set(item.id, v);
                    liveTotal();
                  },
                  onblur: () => { drawItems(); drawBasket(); },
                }),
                h('button', { onclick: () => add(item, 1) }, '+'),
              ),
              h('strong.till-line-total', fmtMoney(item.sellPrice * qty)),
              h('button.btn-ghost.btn-sm', { onclick: () => add(item, -qty) }, '✕'),
            ))
            : h('p.muted', { style: { margin: 0, fontSize: '.88rem' } },
              'Tap what the customer is buying. It appears here.'),
        ),

        h('div.till-foot',
          h('div.till-total-row',
            h('span', `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`),
            h('div.till-total', h('span.muted', 'Total'), h('strong', fmtMoney(due))),
          ),
          methodButtons,
          method === 'cash'
            ? h('div.till-cash',
              h('label.field', h('span', 'Amount given'), tendered),
              // Only once there is something to pay for: quick-cash buttons
              // against an empty basket are four buttons that do nothing.
              due > 0
                ? h('div.till-quick',
                  ...quickAmounts(due).map((amount) => h('button.btn-sm', {
                    onclick: () => { tendered.value = String(amount); drawChange(); },
                  }, amount === due ? 'Exact' : fmtMoney(amount, { withSymbol: false }))),
                )
                : null,
              changeLine,
            )
            : null,
          h('button.btn-primary.till-complete', {
            disabled: !lines.length,
            onclick: complete,
          }, `Complete sale · ${fmtMoney(due)}`),
        ),
      ),
    );

    drawChange();
  };

  // Typing a quantity must not redraw the box the finger is in.
  const liveTotal = () => {
    const due = total();
    const button = basketHost.querySelector('.till-complete');
    if (button) {
      button.textContent = `Complete sale · ${fmtMoney(due)}`;
      button.disabled = basket.size === 0;
    }
    const shown = basketHost.querySelector('.till-total strong');
    if (shown) shown.textContent = fmtMoney(due);
    drawChange();
  };

  async function complete(event) {
    const lines = [...basket.entries()].map(([itemId, qty]) => ({ itemId, qty }));
    if (!lines.length) return;

    event.target.disabled = true;
    event.target.textContent = 'Saving…';
    try {
      const sale = await api.shopCreateSale({
        paymentMethod: method,
        tendered: method === 'cash' && tendered.value ? Number(tendered.value) : null,
        lines,
      });

      basket.clear();
      tendered.value = '';
      receipt(sale);
      mount(host, await renderShopSell());
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
      liveTotal();
    }
  }

  drawItems();
  drawBasket();

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', data.settings.shopName),
        h('div.sub', 'Tap what the customer is buying, take the money, done'),
      ),
    ),

    till ? tillStrip(till) : null,

    h('div.till-layout',
      card('What are they buying?', {}, itemHost),
      h('div', basketHost),
    ),

    recentCard(recent.sales ?? []),
  );

  return host;
}

/**
 * Notes a customer is likely to hand over.
 *
 * Ghana's notes are 10, 20, 50, 100 and 200. Offering the exact amount and the
 * two notes just above it covers almost every cash sale in one tap, which is
 * the difference between doing the arithmetic and not.
 */
function quickAmounts(due) {
  const notes = [5, 10, 20, 50, 100, 200];
  const above = notes.filter((n) => n >= due).slice(0, 3);
  const rounded = Math.ceil(due / 50) * 50;
  const set = new Set([Math.round(due * 100) / 100, ...above]);
  if (rounded > due && rounded <= 1000) set.add(rounded);
  return [...set].sort((a, b) => a - b).slice(0, 4);
}

/** The day's takings, split by where the money went. */
function tillStrip(till) {
  return h('div.till-strip',
    h('div.till-strip-item',
      h('span.stat-label', 'Cash today'),
      h('strong', fmtMoney(till.cash.total)),
      h('span.muted', `${till.cash.count} ${till.cash.count === 1 ? 'sale' : 'sales'}`),
    ),
    h('div.till-strip-item',
      h('span.stat-label', 'Card today'),
      h('strong', fmtMoney(till.card.total)),
      h('span.muted', `${till.card.count} ${till.card.count === 1 ? 'sale' : 'sales'}`),
    ),
    h('div.till-strip-item',
      h('span.stat-label', 'Taken today'),
      h('strong', fmtMoney(till.total)),
      h('span.muted', `${till.saleCount} ${till.saleCount === 1 ? 'sale' : 'sales'}`),
    ),
    till.voided.count
      ? h('div.till-strip-item',
        h('span.stat-label', 'Voided'),
        h('strong', fmtMoney(till.voided.total)),
        h('span.muted', `${till.voided.count} taken back out`),
      )
      : null,
  );
}

/**
 * The receipt, as a dialog.
 *
 * Shown after the sale rather than before, with the change due as the largest
 * thing on it — that is the number somebody has to act on while the customer is
 * still there. Printing is optional and uses the browser, so a shop with a
 * receipt printer can use one and a shop without one loses nothing.
 */
function receipt(sale) {
  const line = (l) => h('tr',
    h('td', l.name),
    h('td.num', String(l.qty)),
    h('td.num', fmtMoney(l.unitPrice, { withSymbol: false })),
    h('td.num', fmtMoney(l.lineTotal, { withSymbol: false })),
  );

  const dialog = h('dialog.receipt-dialog', {
    style: {
      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      background: 'var(--surface)', color: 'var(--text)',
      maxWidth: '420px', width: '92vw', padding: '1.2rem',
    },
  },
    h('div.card-head',
      h('h2', 'Sale complete'),
      h('button.btn-sm.btn-ghost', { onclick: () => dialog.close() }, '✕'),
    ),

    sale.changeDue != null
      ? h('div.receipt-change',
        h('span.stat-label', 'Change to give'),
        h('strong', fmtMoney(sale.changeDue)),
      )
      : h('div.receipt-change.paid',
        h('span.stat-label', sale.paymentMethod === 'card' ? 'Paid by card' : 'Paid in cash'),
        h('strong', fmtMoney(sale.total)),
      ),

    h('div.receipt-body', { id: 'receipt-print' },
      h('table',
        h('tbody', sale.lines.map(line)),
        h('tfoot', h('tr',
          h('td', h('strong', 'Total')),
          h('td'), h('td'),
          h('td.num', h('strong', fmtMoney(sale.total, { withSymbol: false }))),
        )),
      ),
      h('p.muted', { style: { fontSize: '.78rem', marginTop: '.6rem' } },
        `Sale #${sale.id} · ${sale.paymentMethod === 'card' ? 'Card' : 'Cash'}`
        + (sale.soldBy ? ` · ${sale.soldBy}` : '')),
    ),

    h('div.btn-row', { style: { marginTop: '1rem', justifyContent: 'flex-end' } },
      h('button', { onclick: () => window.print() }, '🖨 Print receipt'),
      h('button.btn-primary', { onclick: () => dialog.close() }, 'Next customer'),
    ),
  );

  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

function recentCard(sales) {
  if (!sales.length) return null;

  return card('Just sold', { note: 'The last few, newest first' },
    h('div.mx-recent', sales.map((sale) => h('div.mx-recent-row',
      h('span.muted', String(sale.at ?? '').slice(11, 16)),
      h('strong', fmtMoney(sale.total)),
      h('span.muted', sale.paymentMethod === 'card' ? '💳' : '💵'),
      h('span', `${sale.lineCount} ${sale.lineCount === 1 ? 'line' : 'lines'}`),
      sale.soldBy ? h('span.muted', `· ${sale.soldBy}`) : null,
      sale.voided ? h('span.pill.bad', 'voided') : null,
    ))),
  );
}
