import { api } from '../api.js';
import { state } from '../app.js';
import { fmtDay, fmtMoney, fmtNum, h, mount, toast } from '../util.js';
import { card } from './components.js';

/**
 * On its way from Odoo.
 *
 * Insight reads every confirmed Odoo PO and sends the breakfast lines here.
 * They wait, by PO, until somebody says they arrived: each line's number is
 * filled in with what was ordered (in the item's own unit), changed only when
 * the delivery is short, and one Received per PO puts it in stock today.
 * Underneath, what came in from Odoo today.
 *
 * Nothing shows until there is something to show: a site Insight is not
 * sending to never sees this card.
 */
export async function odooIncomingCard({ onReceived }) {
  const host = h('div', { style: { gridColumn: '1 / -1' } });

  async function load() {
    let data;
    try {
      data = await api.odooIncoming();
    } catch {
      mount(host);
      return;
    }
    if (data.unavailable || (!data.orders.length && !data.today.length)) { mount(host); return; }
    mount(host, paint(data));
  }

  function paint(data) {
    const lines = data.orders.reduce((n, o) => n + o.lines.length, 0);
    return card('On its way from Odoo', {
      wide: true,
      note: lines ? `${lines} on ${lines === 1 ? 'its' : 'their'} way` : 'nothing waiting',
    },
    data.orders.length
      ? data.orders.map(orderBlock)
      : h('p.muted', { style: { fontSize: '.88rem' } }, 'Nothing waiting. Insight sends each confirmed Odoo order here as it is placed.'),
    data.today.length
      ? h('div.incoming-today',
        h('h3', 'Added from Odoo today'),
        data.today.map(todayRow))
      : null);
  }

  function orderBlock(order) {
    const inputs = [];
    const rows = order.lines.map((line) => {
      const qty = h('input.incoming-qty', {
        type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: String(Number(line.qty)),
        'aria-label': `${line.item.name}, ${line.item.unit} received`,
      });
      inputs.push({ line, qty });
      const odoo = line.odooQty != null
        ? `${fmtNum(line.odooQty, 3)} ${line.odooUom || ''} in Odoo${line.product && line.product !== line.item.name ? ` · ${line.product}` : ''}`
        : line.product || '';
      return h('div.incoming-line',
        h('div',
          h('b', line.item.name),
          odoo ? h('div.muted', odoo) : null),
        qty,
        h('span.muted', line.item.unit));
    });

    const button = h('button.btn-primary.incoming-received', {
      onclick: async () => {
        const out = [];
        for (const { line, qty } of inputs) {
          const n = Number(qty.value);
          if (qty.value === '' || !Number.isFinite(n) || n < 0) {
            toast(`How many ${line.item.unit} of ${line.item.name} came? 0 if none.`, 'bad');
            qty.focus();
            return;
          }
          out.push({ lineId: line.lineId, qty: n });
        }
        button.disabled = true;
        try {
          const result = await api.odooReceive({ po: order.po, lines: out });
          const shortBy = result.short.length
            ? ` — short: ${result.short.map((s) => `${s.item} ${fmtNum(s.short, 2)} ${s.unit}`).join(', ')}`
            : '';
          toast(`${order.po} received, ${fmtMoney(result.total)}${shortBy}`, result.short.length ? '' : 'good');
          await load();
          onReceived?.();
        } catch (err) {
          toast(err.message, 'bad');
          button.disabled = false;
        }
      },
    }, 'Received');

    return h('div.odoo-order',
      h('div.odoo-order-head',
        h('div',
          h('b', order.supplier || 'Odoo order'),
          order.confirmedOn ? h('div.muted', { style: { fontSize: '.8rem' } }, `confirmed ${fmtDay(order.confirmedOn)}`) : null),
        h('span.muted', { style: { fontSize: '.82rem', whiteSpace: 'nowrap' } }, `${order.po} · from Odoo`)),
      rows,
      button,
      h('p.muted.incoming-hint', 'Something not here? Change its number to 0.'));
  }

  function time(at) {
    try {
      return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: state.settings?.timezone || undefined });
    } catch {
      return '';
    }
  }

  function todayRow(r) {
    const outcome = !(Number(r.qty) > 0)
      ? h('span.pill.bad', 'nothing came')
      : Number(r.short) > 0
        ? h('span.pill.bad', `${fmtNum(r.short, 2)} short`)
        : h('span.pill.good', 'In stock');
    return h('div.incoming-done',
      h('div',
        h('div', h('b', r.item?.name || ''), ` · ${fmtNum(r.qty, 2)} ${r.item?.unit || ''}`),
        h('div.muted', [r.po, r.by, time(r.at)].filter(Boolean).join(' · '))),
      outcome);
  }

  await load();
  return host;
}
