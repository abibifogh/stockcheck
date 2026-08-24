import { api } from '../api.js';
import { can, navigate } from '../app.js';
import {
  attributeSummary, fmtDay, fmtMoney, fmtNum, fmtQty, h, mount, toast, todayISO,
} from '../util.js';
import {
  card, categoryBar, inCategory, nextSort, sortHeader, sorted, statTile, table,
} from './components.js';
import { printButton } from '../print.js';

/**
 * What is on the shelf, what to order, and what is sitting there doing nothing.
 *
 * Days of cover is measured over three months rather than the kitchen's
 * fortnight: a hotel gets through bulbs steadily but replaces a cistern valve
 * twice a year, and a short window would call almost everything dead stock.
 *
 * A category can be picked at the top and it narrows the whole page, figures
 * included. Every list here is drawn from the same rows, so they agree.
 */
export async function renderMxStock() {
  const [data, pending, asked, adjustments] = await Promise.all([
    api.mxStock(),
    api.mxPendingCounts().catch(() => ({ counts: [], days: [] })),
    api.mxMyStocktakes().catch(() => ({ tasks: [] })),
    // Absent until 0017 has been run, which is not a reason to fail the page.
    api.mxPendingAdjustments().catch(() => ({ adjustments: [] })),
  ]);
  const host = h('div');
  const reload = async () => mount(host, await renderMxStock());

  // Counted quantities live outside the repaint: pressing a category chip
  // rebuilds the table, and a figure somebody has already typed must survive
  // that — both in the map that gets saved and in the box on screen.
  const counts = new Map();
  let category = null;
  let grouped = false;
  // The category chips narrow the page; this orders what is left. Both go
  // through paint(), and the counts typed into the last column live outside it,
  // so re-sorting mid-count keeps every figure already entered.
  let sort = { key: null, dir: 'asc' };
  const NUMERIC = ['stock', 'parLevel', 'unitCost', 'value', 'used90', 'daysCover'];
  const onSort = (key) => { sort = nextSort(sort, key, { numeric: NUMERIC }); paint(); };

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

  // A variant is counted as its own part, so it gets its own row — the label is
  // what stops three near-identical names reading as one thing scrolled past.
  const nameCell = (v, r) => h('div',
    h('div', r.variant
      ? h('span', v.replace(` — ${r.variant}`, ''), ' ', h('span.pill', r.variant))
      : v),
    h('small.muted', [r.categoryName, attributeSummary(r.attributes)].filter(Boolean).join(' · ')));

  const paint = () => {
    // Unsorted means the order the store sent, which is deliberate: worst
    // first. Only once somebody picks a column does this reorder anything.
    const rows = sort.key
      ? sorted(inCategory(data.rows, category), sort)
      : inCategory(data.rows, category);
    const reorder = inCategory(data.reorder, category);
    const idle = inCategory(data.idle, category);
    const shrinkage = inCategory(data.shrinkage, category);
    const groupBy = grouped ? (r) => r.categoryName : null;
    const groupValue = (group) =>
      fmtMoney(group.reduce((n, r) => n + (r.value ?? 0), 0), { compact: true });

    mount(host,
      h('div.page-head',
        h('div',
          h('h1', 'Parts on the shelf'),
          h('div.sub', `Book value ${fmtMoney(rows.reduce((n, r) => n + r.value, 0))} · as at ${data.asOf}`
            + (category ? ` · ${category}` : '')),
        ),
        h('div.btn-row',
          printButton({
            title: 'Maintenance store — stock',
            subtitle: `As at ${data.asOf}${category ? ` · ${category}` : ''}`,
          }),
          h('button.btn-sm', { onclick: () => navigate('mx-purchases') }, 'Record a delivery'),
        ),
      ),

      askedToCount(asked),

      categoryBar({
        rows: data.rows,
        selected: category,
        grouped,
        onSelect: (value) => { category = value; paint(); },
        onGroup: (value) => { grouped = value; paint(); },
      }),

      h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
        statTile({
          label: 'Value on the shelf',
          value: fmtMoney(rows.reduce((n, r) => n + r.value, 0), { compact: true }),
          sub: category ? `${category} only` : 'at what you paid',
        }),
        statTile({
          label: 'Needs ordering',
          value: fmtNum(reorder.length, 0),
          sub: `about ${fmtMoney(reorder.reduce((n, r) => n + r.suggestedOrderValue, 0), { compact: true })} to restock`,
          accent: reorder.length ? 'var(--warn)' : undefined,
        }),
        statTile({
          label: 'Not moved in 90 days',
          value: fmtNum(idle.length, 0),
          sub: `${fmtMoney(idle.reduce((n, r) => n + r.value, 0), { compact: true })} sitting still`,
        }),
        statTile({
          label: 'Count differences',
          value: fmtNum(shrinkage.length, 0),
          sub: 'shelf against book',
          accent: shrinkage.length ? 'var(--bad)' : undefined,
        }),
      ),

      reorder.length
        ? card('Order list', {
          wide: true,
          note: 'Everything below its restock level, worst first',
        },
          table([
            { key: 'name', label: 'Part', cls: 'wrap', format: nameCell },
            { key: 'stock', label: 'On shelf', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
            { key: 'parLevel', label: 'Level', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
            { key: 'suggestedOrder', label: 'Order', align: 'right', format: (v, r) => h('strong', fmtQty(v, r.unit)) },
            { key: 'suggestedOrderValue', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
            { key: 'daysCover', label: 'Days left', align: 'right', format: (v) => (v == null ? '—' : fmtNum(v, 0)) },
            { key: 'status', label: '', format: statusPill },
          ], reorder, {
            groupBy,
            groupSummary: (group) =>
              fmtMoney(group.reduce((n, r) => n + (r.suggestedOrderValue ?? 0), 0), { compact: true }),
          }),
          h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
            'Negative stock never means the shelf is negative — it means a delivery was never keyed '
            + 'in. Record it under Deliveries and the figure corrects itself.'),
        )
        : card('Order list', { wide: true },
          h('div.empty', h('p', category
            ? `Nothing in ${category} is below its restock level.`
            : 'Nothing is below its restock level. The store is in good shape.'))),

      card('Everything in the store', {
        wide: true,
        note: 'Type a figure in the last column to record a physical count',
      },
        table([
          { key: 'name', label: sortHeader('Part', 'name', sort, onSort), cls: 'wrap', format: nameCell },
          {
            key: 'stock',
            label: sortHeader('On shelf', 'stock', sort, onSort),
            align: 'right',
            format: (v, r) => fmtQty(v, r.unit),
          },
          {
            key: 'parLevel',
            label: sortHeader('Level', 'parLevel', sort, onSort),
            align: 'right',
            format: (v, r) => fmtQty(v, r.unit),
          },
          {
            key: 'unitCost',
            label: sortHeader('Each', 'unitCost', sort, onSort),
            align: 'right',
            format: (v) => fmtMoney(v, { withSymbol: false }),
          },
          {
            key: 'value',
            label: sortHeader('Value', 'value', sort, onSort),
            align: 'right',
            format: (v) => fmtMoney(v, { withSymbol: false }),
          },
          {
            key: 'used90',
            label: sortHeader('Used (90d)', 'used90', sort, onSort),
            align: 'right',
            format: (v, r) => fmtQty(v, r.unit),
          },
          {
            key: 'daysCover',
            label: sortHeader('Days left', 'daysCover', sort, onSort),
            align: 'right',
            format: (v) => (v == null ? '—' : fmtNum(v, 0)),
          },
          { key: 'status', label: '', format: statusPill },
          {
            key: 'itemId',
            label: 'Counted',
            align: 'right',
            format: (id) => h('input', {
              type: 'number', step: 'any', min: '0',
              style: { width: '80px' },
              placeholder: '—',
              value: counts.has(id) ? String(counts.get(id)) : '',
              oninput: (e) => {
                const v = Number(e.target.value);
                if (e.target.value === '' || !Number.isFinite(v)) counts.delete(id);
                else counts.set(id, v);
              },
            }),
          },
        ], rows, {
          rowClass: (r) => (r.status === 'negative' ? 'row-bad' : ''),
          groupBy,
          groupSummary: groupValue,
          empty: category ? `Nothing in ${category}.` : 'Nothing in the store yet.',
        }),
        h('div.btn-row', { style: { marginTop: '.9rem' } },
          h('button.btn-primary', { onclick: saveCounts }, 'Save today’s count'),
        ),
        h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
          'Counts you have typed are kept while you move between categories — one Save records '
          + 'all of them. A count does not change the figures on its own: it is sent to an '
          + 'administrator, who sees what accepting it would do and decides.'),
      ),

      countApprovalCard(pending, reload),
      adjustmentCard(adjustments.adjustments ?? [], reload),
      rejectedAdjustmentCard(adjustments.rejected ?? [], reload),

      shrinkage.length
        ? card('Where the count did not match the book', { wide: true },
          table([
            { key: 'name', label: 'Part' },
            { key: 'pendingCountDay', label: 'Counted on' },
            { key: 'countVariance', label: 'Difference', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
            {
              key: 'countVarianceValue',
              label: 'Worth',
              align: 'right',
              format: (v) => h(`span.delta.${v < 0 ? 'up' : 'down'}`, fmtMoney(v, { withSymbol: false })),
            },
          ], shrinkage, { groupBy }),
          h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
            'A shelf holding less than the book says means parts left without being recorded. '
            + 'A small gap is normal; a consistent one is worth asking about.'))
        : null,

      idle.length
        ? card('Not touched in three months', { wide: true, note: 'Money standing still' },
          table([
            { key: 'name', label: 'Part', format: nameCell },
            { key: 'stock', label: 'On shelf', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
            { key: 'value', label: 'Value', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
          ], idle, { groupBy, groupSummary: groupValue }),
          h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
            'Not necessarily wrong — some spares exist precisely so you never need them in a hurry. '
            + 'But it is worth knowing how much cash is tied up in them.'))
        : null,
    );
  };

  paint();
  return host;
}

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


// ---------------------------------------------------------------------------
// Changes waiting on a decision
// ---------------------------------------------------------------------------

/**
 * Requests to correct or remove something already recorded.
 *
 * Sits beside the counts and reads the same way, because it is the same rule
 * from the other side: a count that has been agreed can be undone just as
 * quietly by deleting the delivery behind it, so that asks too.
 */
function adjustmentCard(adjustments, reload) {
  if (!adjustments.length) return null;

  const mayDecide = can('users');
  const chosen = new Set(adjustments.map((a) => a.id));
  const boxes = new Map();
  const noteInput = h('input', { type: 'text', placeholder: 'Note (optional)', maxlength: 300 });
  const foot = h('div.btn-row', { style: { marginTop: '.9rem' } });

  const decide = async (approve) => {
    const ids = [...chosen];
    if (!ids.length) { toast('Nothing selected', 'bad'); return; }
    try {
      const result = await api.mxReviewAdjustments({
        ids, approve, note: noteInput.value.trim() || null,
      });
      if (approve && result.missing) {
        toast(`${result.applied} applied — ${result.missing} had already gone`, 'bad');
      } else {
        toast(approve ? `${result.applied} applied` : `${result.decided} rejected`, 'good');
      }
      reload();
    } catch (err) { toast(err.message, 'bad'); }
  };

  const refresh = () => {
    mount(foot, mayDecide
      ? h('div',
        h('span.muted', { style: { marginRight: '.6rem' } },
          `${chosen.size} of ${adjustments.length} selected`),
        h('button.btn-primary', { disabled: !chosen.size, onclick: () => decide(true) }, 'Accept'),
        h('button', { disabled: !chosen.size, onclick: () => decide(false) }, 'Reject'),
      )
      : null);
  };

  refresh();

  return card('Changes waiting for approval', {
    wide: true,
    note: mayDecide
      ? 'Accepting is what finally moves the entry'
      : 'An administrator has to accept these',
  },
    !mayDecide
      ? h('div.alert.info',
        h('span.alert-icon', 'ℹ️'),
        h('div',
          h('div.alert-title', 'These are with an administrator'),
          h('div.alert-detail',
            'Nothing below has happened yet. Each entry is still exactly as it was recorded.'),
        ))
      : null,

    table([
      ...(mayDecide ? [{
        key: 'id',
        label: '',
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
      { key: 'kind', label: 'What', format: (v) => h('span.pill', v === 'issue' ? 'issue' : 'delivery') },
      {
        key: 'previous',
        label: 'Entry',
        format: (v, r) => h('div',
          h('div', h('strong', r.name)),
          h('small.muted', `${fmtDay(v.day)}${r.areaName ? ` · ${r.areaName}` : ''}`)),
      },
      { key: 'action', label: 'Asked for', format: (_v, r) => changes(r) },
      { key: 'reason', label: 'Why', format: (v) => (v ? h('span', v) : h('span.muted', '—')) },
      {
        key: 'requestedBy',
        label: 'Asked by',
        format: (v, r) => h('div', h('div', v || '—'),
          h('small.muted', String(r.requestedAt ?? '').slice(0, 16).replace('T', ' '))),
      },
    ], adjustments),

    mayDecide
      ? h('div', { style: { marginTop: '.8rem' } },
        h('label.field', h('span', 'Note on the decision'), noteInput),
        foot,
      )
      : null,
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
      'Removing a delivery takes parts back off the shelf and removing an issue puts them back on, '
      + 'which is why neither happens on its own. Whoever asks is never whoever decides — the same '
      + 'rule as a count, and for the same reason.'),
  );
}


/** What the reviewer needs: the field that moves, from what to what. */
const CHANGE_LABELS = {
  day: 'date', qty: 'quantity', unit_cost: 'each', supplier: 'supplier',
  note: 'note', area_id: 'room', job_ref: 'job',
};

function changes(row) {
  if (row.action === 'delete') return h('span.delta.up', 'remove it');
  const moved = Object.keys(row.payload ?? {})
    .filter((f) => `${row.payload[f] ?? ''}` !== `${row.previous[f] ?? ''}`)
    .map((f) => h('div', h('span.muted', `${CHANGE_LABELS[f] ?? f}: `),
      h('span', `${row.previous[f] ?? '—'}`), ' → ', h('strong', `${row.payload[f] ?? '—'}`)));
  return moved.length ? h('div', moved) : h('span.muted', 'no change');
}

/**
 * Requests that were turned down, and can still be accepted.
 *
 * A rejection is usually "I do not believe this yet" rather than "never", and
 * the answer tends to arrive afterwards — the technician explains, or the
 * delivery note turns up. Making somebody re-file the identical request would
 * lose who asked, when and why, so the original is simply reopened.
 *
 * Only an administrator sees this. For everybody else a rejection is an answer,
 * and a list of answers to argue with is not a screen anybody needs.
 */
function rejectedAdjustmentCard(rejected, reload) {
  if (!rejected.length || !can('users')) return null;

  const accept = (row) => async (event) => {
    if (!confirm(`Accept this after all?\n\nIt was rejected`
      + `${row.reviewedBy ? ` by ${row.reviewedBy}` : ''}`
      + `${row.reviewNote ? ` — "${row.reviewNote}"` : ''}.\n\n`
      + 'Accepting applies it now.')) return;
    event.target.disabled = true;
    try {
      const result = await api.mxReviewAdjustments({ ids: [row.id], approve: true });
      if (result.blocked) toast('Somebody has since asked again about that entry — decide that one', 'bad');
      else if (result.missing) toast('That entry has since gone, so nothing was applied', 'bad');
      else toast('Applied', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  return card('Turned down earlier', {
    wide: true,
    note: 'A rejection is not final — these can still be accepted',
  },
    table([
      { key: 'kind', label: 'What', format: (v) => h('span.pill', v === 'issue' ? 'issue' : 'delivery') },
      {
        key: 'previous',
        label: 'Entry',
        format: (v, r) => h('div',
          h('div', h('strong', r.name)),
          h('small.muted', `${fmtDay(v.day)}${r.areaName ? ` · ${r.areaName}` : ''}`)),
      },
      { key: 'action', label: 'Asked for', format: (_v, r) => changes(r) },
      {
        key: 'reviewedBy',
        label: 'Rejected by',
        format: (v, r) => h('div', h('div', v || '—'),
          r.reviewNote ? h('small.muted', r.reviewNote) : null),
      },
      {
        key: 'id',
        label: '',
        format: (_v, r) => (r.superseded
          ? h('span.muted', { title: 'Somebody has asked again about this entry' }, 'asked again')
          : h('button.btn-sm', { onclick: accept(r) }, 'Accept after all')),
      },
    ], rejected, { rowClass: (r) => (r.superseded ? 'row-muted' : '') }),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
      'Accepting one here applies it straight away, exactly as accepting it first time would '
      + 'have. Where somebody has since asked again about the same entry, answer that one '
      + 'instead — two decisions on one entry would land in an order nobody chose.'),
  );
}
