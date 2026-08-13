import { api } from '../api.js';
import { can, navigate } from '../app.js';
import {
  attributeSummary, fmtDay, fmtMoney, fmtNum, fmtQty, h, mount, toast, todayISO,
} from '../util.js';
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
  const [data, pending, asked] = await Promise.all([
    api.mxStock(),
    api.mxPendingCounts().catch(() => ({ counts: [], days: [] })),
    api.mxMyStocktakes().catch(() => ({ tasks: [] })),
  ]);
  const host = h('div');
  const reload = async () => mount(host, await renderMxStock());

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
      toast(`${counts.size} counted — waiting for an administrator to accept it`, 'good');
      reload();
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

    askedToCount(asked),

    h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      statTile({ label: 'Value on the shelf', value: fmtMoney(data.totalValue, { compact: true }), sub: 'at what you paid' }),
      statTile({
        label: 'Needs ordering',
        value: fmtNum(data.reorder.length, 0),
        // Two different problems wear this badge: below the level you set, and
        // going out faster than what is left will cover. Only the first has a
        // bill attached, and "about GHS 0 to restock" is how a figure teaches
        // people to stop reading it.
        sub: data.reorderValue > 0
          ? `about ${fmtMoney(data.reorderValue, { compact: true })} to restock`
          : 'going out faster than the shelf covers',
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
        note: 'Below its restock level, or going out faster than the shelf will cover',
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
      h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
        'A count does not change the figures on its own. It is sent to an administrator, who sees '
        + 'what accepting it would do to each item and decides. Until then the book stands.'),
    ),

    countApprovalCard(pending, reload),

    data.shrinkage.length
      ? card('Counted differently from the book', { wide: true, note: 'Waiting on a decision' },
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
          + 'A small gap is normal; a consistent one is worth asking about. These gaps close '
          + 'when an administrator accepts the count.'))
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

// ---------------------------------------------------------------------------
// Accepting a count
// ---------------------------------------------------------------------------

/**
 * Counts waiting on an administrator.
 *
 * Recounting a store is exactly the moment a shortfall could be quietly
 * written off, so whoever counts is never whoever decides. This card is what
 * the decision looks like: every line, what it claims, what the book says, and
 * what accepting it would cost — before anything moves.
 *
 * Anyone with the stock screen can see the queue, because knowing a count is
 * stuck is not privileged information. Only an administrator gets the buttons.
 */
/**
 * "You have been asked to count this."
 *
 * The task closes itself when a count is recorded, so this says what to do and
 * then gets out of the way — there is nothing here to press.
 */
function askedToCount(asked) {
  const tasks = asked?.tasks ?? [];
  if (!tasks.length) return null;

  const late = tasks.some((t) => t.overdue);
  return h(`div.alert.${late ? 'high' : 'info'}`, { style: { marginBottom: '1rem' } },
    h('span.alert-icon', late ? '⏰' : '📋'),
    h('div',
      h('div.alert-title', tasks.length === 1
        ? `Stock count due: ${tasks[0].name}`
        : `${tasks.length} stock counts are due`),
      h('div.alert-detail',
        tasks.map((t) => h('div', `${t.name} — due ${fmtDay(t.dueDay)}${t.overdue ? ' (late)' : ''}`)),
        h('div', { style: { marginTop: '.35rem' } },
          'Type what is actually on the shelf in the last column below and submit. '
          + 'That closes the count; an administrator accepts the figures afterwards.'),
      ),
    ),
  );
}

function countApprovalCard(pending, reload) {
  const rows = pending?.counts ?? [];
  if (!rows.length) return null;

  const mayDecide = can('users');
  const chosen = new Set(rows.map((r) => r.id));
  const boxes = new Map();
  // Populated straight away, not only on the first change: every row starts
  // selected, so a blank label would misdescribe what Accept is about to do.
  const barLabel = h('span', `${rows.length} of ${rows.length} selected`);
  const noteInput = h('input', {
    type: 'text', placeholder: 'Why (optional — kept with the decision)', maxlength: 300,
  });

  const refresh = () => {
    barLabel.textContent = `${chosen.size} of ${rows.length} selected`;
    for (const [id, box] of boxes) box.checked = chosen.has(id);
  };

  const decide = async (approve, event) => {
    const ids = [...chosen];
    if (!ids.length) { toast('Nothing selected', 'bad'); return; }

    const worth = rows.filter((r) => ids.includes(r.id))
      .reduce((n, r) => n + r.differenceValue, 0);
    const question = approve
      ? `Accept ${ids.length} counted ${ids.length === 1 ? 'figure' : 'figures'}? `
        + `The book will be corrected to match the shelf, a change of `
        + `${fmtMoney(worth)} in stock value. This cannot be undone from here.`
      : `Reject ${ids.length} counted ${ids.length === 1 ? 'figure' : 'figures'}? `
        + 'The book stays as it is and the count is filed as rejected.';
    if (!confirm(question)) return;

    event.target.disabled = true;
    try {
      const result = await api.mxReviewCounts({ ids, approve, note: noteInput.value.trim() || null });
      toast(approve
        ? `${result.approved} accepted — stock corrected`
        : `${result.rejected} rejected — nothing changed`, 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const headBox = h('input', {
    type: 'checkbox', checked: true, title: 'Select all',
    onchange: (e) => {
      chosen.clear();
      if (e.target.checked) for (const r of rows) chosen.add(r.id);
      refresh();
    },
  });

  const summary = (pending.days ?? []).map((d) => h('div.stat',
    h('div.stat-label', fmtDay(d.day, { withYear: true })),
    h('div.stat-value', { style: { fontSize: '1.2rem' } }, `${d.items} ${d.items === 1 ? 'item' : 'items'}`),
    h('div.stat-sub',
      d.net < 0
        ? h('span.delta.up', `${fmtMoney(d.net, { withSymbol: false })} to write off`)
        : d.net > 0
          ? h('span.delta.down', `+${fmtMoney(d.net, { withSymbol: false })} found`)
          : h('span.muted', 'no net change'),
    ),
  ));

  return card('Counts waiting for approval', {
    wide: true,
    note: mayDecide ? 'Accepting corrects the book to match the shelf' : 'An administrator has to accept these',
  },
    summary.length ? h('div.grid.grid-4', { style: { marginBottom: '.9rem' } }, summary) : null,

    !mayDecide
      ? h('div.alert.info',
        h('span.alert-icon', 'ℹ️'),
        h('div',
          h('div.alert-title', 'These are with an administrator'),
          h('div.alert-detail',
            'The figures below are what was counted. Nothing has moved yet — the book still shows '
            + 'what it worked out. An administrator accepts or rejects each one.'),
        ))
      : null,

    table([
      ...(mayDecide ? [{
        key: 'id',
        label: headBox,
        cls: 'tick',
        format: (id) => {
          const box = h('input', {
            type: 'checkbox', checked: chosen.has(id),
            onchange: (e) => {
              if (e.target.checked) chosen.add(id); else chosen.delete(id);
              refresh();
            },
          });
          boxes.set(id, box);
          return box;
        },
      }] : []),
      { key: 'day', label: 'Counted on', format: (v) => fmtDay(v) },
      {
        key: 'name',
        label: 'Part',
        format: (v, r) => h('div', h('div', v),
          h('small.muted', [attributeSummary(r.attributes), r.countedBy ? `by ${r.countedBy}` : null]
            .filter(Boolean).join(' · '))),
      },
      { key: 'bookQty', label: 'Book says', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
      { key: 'countedQty', label: 'Counted', align: 'right', format: (v, r) => h('strong', fmtQty(v, r.unit)) },
      {
        key: 'difference',
        label: 'Change',
        align: 'right',
        format: (v, r) => h(`span.delta.${v < 0 ? 'up' : v > 0 ? 'down' : 'flat'}`,
          `${v > 0 ? '+' : ''}${fmtQty(v, r.unit)}`),
      },
      {
        key: 'differenceValue',
        label: 'Worth',
        align: 'right',
        format: (v) => h(`span.delta.${v < 0 ? 'up' : v > 0 ? 'down' : 'flat'}`,
          fmtMoney(v, { withSymbol: false })),
      },
      { key: 'note', label: 'Note', format: (v) => (v ? h('span.muted', v) : '—') },
    ], rows),

    mayDecide
      ? h('div', { style: { marginTop: '.9rem' } },
        h('div.bulk-bar', barLabel,
          h('div.btn-row',
            h('button.btn-sm', { onclick: () => { chosen.clear(); refresh(); } }, 'Select none'),
            h('button.btn-sm.btn-danger', { onclick: (e) => decide(false, e) }, 'Reject'),
            h('button.btn-primary.btn-sm', { onclick: (e) => decide(true, e) }, 'Accept and correct stock'),
          )),
        h('label.field', { style: { marginTop: '.6rem', maxWidth: '460px' } },
          h('span', 'Note on this decision'), noteInput),
        h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
          'Accepting sets the book to the counted figure from that date onwards. Later deliveries '
          + 'and issues carry on from there, and a delivery keyed in late with an earlier date '
          + 'cannot unsettle it.'),
      )
      : null,
  );
}
