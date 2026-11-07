import { api } from '../api.js';
import { can } from '../app.js';
import { fmtMoney, fmtNum, h, mount, toast } from '../util.js';
import { emptyState, modal, table } from './components.js';
import { minutes, statusPill, timeOf } from './store-common.js';

/**
 * The storekeeper's screen.
 *
 * What is waiting, most urgent first; one tap opens it with every line already
 * filled in with what was asked, so issuing a request in full is two taps.
 * Anything issued short asks why, and the rest stays on this list by itself.
 */

const REASONS = ['Out of stock', 'Not enough in stock', 'Other'];

export async function renderStore(params = {}) {
  const [queue, stock] = await Promise.all([api.storeRequests('queue'), api.storeStock()]);
  const host = h('div');
  let tab = ['waiting', 'done', 'stock'].includes(params.tab) ? params.tab : 'waiting';
  const stockById = new Map(stock.items.map((i) => [i.id, i]));

  const reload = async (next = {}) => mount(host, await renderStore({ tab, ...next }));

  // A request arriving while the screen is open shows up without anybody
  // pressing anything. Only while the list is showing, never mid-issue.
  let listing = true;
  const timer = setInterval(() => {
    if (!host.isConnected) { clearInterval(timer); return; }
    if (listing && tab === 'waiting') reload();
  }, 60000);

  function paint() {
    listing = true;
    const low = stock.items.filter((i) => i.active && i.requestable && i.low);
    mount(host,
      h('div.page-head',
        h('div',
          h('h1', 'Storeroom'),
          h('div.sub', queue.waiting.length
            ? `${queue.waiting.length} to issue · the most urgent first`
            : 'Nothing to issue')),
      ),
      h('div.seg.seg-fill.seg-row', { role: 'tablist', style: { marginBottom: '1rem' } },
        h('button', { class: tab === 'waiting' ? 'active' : '', onclick: () => { tab = 'waiting'; paint(); } },
          'To issue', h('span.seg-count', String(queue.waiting.length))),
        h('button', { class: tab === 'done' ? 'active' : '', onclick: () => { tab = 'done'; paint(); } },
          'Issued', h('span.seg-count', String(queue.done.length))),
        h('button', { class: tab === 'stock' ? 'active' : '', onclick: () => { tab = 'stock'; paint(); } },
          'Stock', low.length ? h('span.seg-count', `${low.length} low`) : null),
      ),
      tab === 'waiting' ? waitingList() : null,
      tab === 'done' ? doneList() : null,
      tab === 'stock' ? stockTable(stock.items) : null,
    );
  }

  function waitingList() {
    const low = stock.items.filter((i) => i.active && i.requestable && i.low);
    return h('div', { style: { display: 'grid', gap: '.8rem' } },
      queue.waiting.length
        ? queue.waiting.map((r) => requestButton(r))
        : emptyState('Nothing to issue', queue.approval
          ? 'Requests appear here once a manager approves them, and on your phone if alerts are on.'
          : 'New requests appear here, and on your phone if alerts are on.'),
      // Still with a manager: shown so nothing is a surprise, but not issuable.
      queue.awaitingApproval?.length
        ? h('section.card', { style: { margin: 0 } },
          h('div.card-head', h('h2', 'Waiting for a manager'), h('span.card-note', `${queue.awaitingApproval.length}`)),
          h('div', { style: { display: 'grid', gap: '.5rem' } }, queue.awaitingApproval.map((r) => h('div',
            { style: { fontSize: '.9rem' } },
            h('strong', `${r.department} · needed ${r.neededText.toLowerCase()}`),
            h('div.muted', { style: { fontSize: '.84rem' } },
              `${r.lines.map((l) => `${l.name} ${fmtNum(l.asked, 2)}`).join(' · ')}`),
            h('div.muted', { style: { fontSize: '.78rem' } }, [r.ref, r.requestedBy, timeOf(r.createdAt)].join(' · '))))))
        : null,
      low.length
        ? h('div.alert.warn',
          h('div.alert-icon', '⚠️'),
          h('div',
            h('div.alert-title', 'Running low in the storeroom'),
            h('div.alert-detail', low.slice(0, 8).map((i) => (i.stock <= 0
              ? `${i.name}: none left`
              : `${i.name}: ${fmtNum(i.stock, 2)} ${i.unit}${i.par ? `, par ${fmtNum(i.par, 2)}` : ''}`)).join(' · ')
              + (low.length > 8 ? ` · and ${low.length - 8} more` : ''))))
        : null,
    );
  }

  function requestButton(r) {
    const urgent = r.needed === 'now';
    return h('button.card', {
      style: {
        margin: 0, textAlign: 'left', width: '100%', cursor: 'pointer', display: 'grid', gap: '.4rem',
        justifyContent: 'stretch', alignItems: 'start', borderRadius: 'var(--radius)',
        borderColor: urgent ? 'var(--bad)' : null, font: 'inherit', color: 'inherit',
      },
      onclick: () => openIssue(r),
    },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '.5rem' } },
        h('strong', { style: { fontSize: '1.05rem' } }, r.department),
        h(`span.pill${urgent ? '.bad' : ''}`, `Needed ${r.neededText.toLowerCase()}`)),
      h('div', r.lines.map((l) => `${l.name} ${fmtNum(l.asked, 2)}`).join(' · ')),
      r.note ? h('div.muted', { style: { fontStyle: 'italic', fontSize: '.88rem' } }, `“${r.note}”`) : null,
      h('div.muted', { style: { fontSize: '.8rem', display: 'flex', justifyContent: 'space-between', gap: '.75rem', flexWrap: 'wrap' } },
        h('span', [r.ref, r.requestedBy, timeOf(r.createdAt), r.follows ? `rest of ${r.follows}` : null].filter(Boolean).join(' · ')),
        h('span', { style: { color: 'var(--accent)', fontWeight: 600 } }, 'Open ›')),
    );
  }

  function doneList() {
    if (!queue.done.length) return emptyState('Nothing issued in the last day', 'What you issue appears here.');
    return h('div', { style: { display: 'grid', gap: '.6rem' } }, queue.done.map((r) => h('section.card', { style: { margin: 0 } },
      h('div.card-head', h('h2', `${r.ref} · ${r.department}`), statusPill(r)),
      h('div', { style: { fontSize: '.9rem' } }, r.lines.map((l) => `${l.name} ${fmtNum(l.issued ?? 0, 2)}${l.issued < l.asked ? ` of ${fmtNum(l.asked, 2)}` : ''}`).join(' · ')),
      h('div.muted', { style: { fontSize: '.8rem', marginTop: '.3rem' } },
        [r.status === 'declined' ? `Declined by ${r.issuedBy}` : `Issued by ${r.issuedBy}`, timeOf(r.issuedAt),
          r.minutesToIssue != null ? `${minutes(r.minutesToIssue)} after it was asked` : null,
          r.value != null ? fmtMoney(r.value) : null,
          r.receivedBy && !r.receivedAuto ? `confirmed by ${r.receivedBy}` : null].filter(Boolean).join(' · ')),
      r.issueNote ? h('div.muted', { style: { fontSize: '.84rem' } }, `“${r.issueNote}”`) : null,
      r.receiptNote ? h('div', { style: { fontSize: '.84rem', color: 'var(--bad)' } }, `${r.department}: “${r.receiptNote}”`) : null,
    )));
  }

  // ------------------------------------------------------------- issuing --

  function openIssue(r) {
    listing = false;
    const answers = new Map(r.lines.map((l) => [l.id, { issued: l.asked, reason: null, other: '' }]));
    const linesHost = h('div', { style: { display: 'grid', gap: '.6rem' } });
    const summary = h('div.entry-status');
    const note = h('input', { type: 'text', placeholder: 'Anything the kitchen should know (optional)' });
    const issue = h('button.btn-primary', { onclick: submit }, 'Issue');

    function lineCard(l) {
      const a = answers.get(l.id);
      const item = stockById.get(l.ingredientId);
      const inStore = item ? item.stock : null;
      const input = h('input', {
        type: 'number', min: 0, step: 'any', value: a.issued, inputMode: 'decimal', 'aria-label': `${l.name} to issue`,
      });
      const set = (n) => {
        a.issued = Math.max(0, Math.round((Number(n) || 0) * 100) / 100);
        if (a.issued >= l.asked) a.reason = null;
        paintLines();
      };
      input.addEventListener('change', () => set(input.value));
      const shortBy = a.issued < l.asked;

      return h('div.item', {
        style: {
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          borderColor: shortBy ? 'var(--warn)' : null,
          background: shortBy ? 'color-mix(in srgb, var(--warn-soft) 60%, var(--surface))' : null,
        },
      },
        h('div',
          h('div.item-name', l.name),
          h('div.item-hint', `Asked for ${fmtNum(l.asked, 2)} ${l.unit}`)),
        h('div.item-input',
          h('button', { 'aria-label': `Issue one fewer ${l.name}`, onclick: () => set(a.issued - 1) }, '−'),
          input,
          h('button', { 'aria-label': `Issue one more ${l.name}`, onclick: () => set(a.issued + 1) }, '+')),
        shortBy
          ? h('div', { style: { gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', gap: '.35rem', alignItems: 'center' } },
            h('span.muted', { style: { fontSize: '.8rem' } }, 'Why less?'),
            REASONS.map((reason) => h(`button.pill.pill-btn${a.reason === reason ? '.warn' : ''}`, {
              onclick: () => { a.reason = reason; paintLines(); },
            }, reason)),
            a.reason === 'Other'
              ? h('input', {
                type: 'text', value: a.other, placeholder: 'Say why', style: { flex: '1 1 160px' },
                oninput: (e) => { a.other = e.target.value; },
              })
              : null)
          : null,
        h('div.item-hint', { style: { gridColumn: '1 / -1', color: inStore != null && inStore < a.issued ? 'var(--bad)' : null } },
          inStore == null ? ''
            : inStore <= 0 ? 'None in the storeroom by the book'
              : `In the storeroom: ${fmtNum(inStore, 2)} now, ${fmtNum(inStore - a.issued, 2)} after this`),
      );
    }

    function paintLines() {
      mount(linesHost, r.lines.map(lineCard));
      const giving = r.lines.filter((l) => answers.get(l.id).issued > 0).length;
      const value = r.lines.reduce((n, l) => n + answers.get(l.id).issued * (stockById.get(l.ingredientId)?.unitCost ?? 0), 0);
      summary.textContent = `Issuing ${giving} of ${r.lines.length} item${r.lines.length === 1 ? '' : 's'}`
        + (can('store_issue') ? ` · ${fmtMoney(value)} at last cost` : '');
      issue.textContent = giving ? `Issue ${giving} item${giving === 1 ? '' : 's'}` : 'Issue';
      issue.disabled = !giving;
    }

    async function submit() {
      const missing = r.lines.find((l) => {
        const a = answers.get(l.id);
        return a.issued < l.asked && (!a.reason || (a.reason === 'Other' && !a.other.trim()));
      });
      if (missing) { toast(`Say why ${missing.name} is short`, 'bad'); return; }
      issue.disabled = true;
      try {
        const out = await api.issueStoreRequest(r.id, {
          note: note.value.trim() || null,
          lines: r.lines.map((l) => {
            const a = answers.get(l.id);
            return { id: l.id, issued: a.issued, reason: a.reason === 'Other' ? a.other.trim() : a.reason };
          }),
        });
        toast(out.followUp ? `${r.ref} issued — the rest is ${out.followUp}` : `${r.ref} issued`, 'good');
        reload({ tab: 'waiting' });
      } catch (err) {
        toast(err.message, 'bad');
        issue.disabled = false;
      }
    }

    function decline() {
      const reason = h('input', { type: 'text', placeholder: 'e.g. Ask the manager first' });
      modal(`Decline ${r.ref}`, [
        h('p.muted', 'Nothing is issued. The kitchen is told, with your reason.'),
        h('label.field', h('span', 'Reason'), reason),
      ], async (event, dialog) => {
        if (!reason.value.trim()) { toast('Say why, so the kitchen knows what to do next.', 'bad'); return; }
        event.target.disabled = true;
        try {
          await api.declineStoreRequest(r.id, { note: reason.value.trim() });
          dialog.close();
          toast(`${r.ref} declined`, 'good');
          reload({ tab: 'waiting' });
        } catch (err) {
          toast(err.message, 'bad');
          event.target.disabled = false;
        }
      }, { saveLabel: 'Decline' });
    }

    paintLines();
    mount(host,
      h('div.page-head',
        h('div',
          h('button.btn-sm.btn-ghost', { onclick: paint, style: { marginBottom: '.4rem' } }, '‹ All requests'),
          h('h1', `${r.ref} · ${r.department}`),
          h('div.sub', `${r.requestedBy} · asked ${timeOf(r.createdAt)} · needed ${r.neededText.toLowerCase()}`
            + (r.follows ? ` · the rest of ${r.follows}` : ''))),
      ),
      r.note ? h('div.alert.info', h('div.alert-icon', '💬'), h('div', h('div.alert-detail', `“${r.note}”`))) : null,
      h('div.stat-label', { style: { margin: '.4rem 0 .5rem' } }, 'What to issue — filled in with what was asked'),
      linesHost,
      h('label.field', { style: { marginTop: '.8rem' } }, h('span', 'Note for the kitchen'), note),
      h('div.entry-footer', h('div.entry-footer-inner',
        summary,
        h('button.btn-danger', { onclick: decline }, 'Decline'),
        issue)),
      h('div', { style: { height: '96px' } }),
    );
  }

  paint();
  if (params.open) {
    const r = queue.waiting.find((x) => x.id === Number(params.open));
    if (r) openIssue(r);
  }
  return host;
}

function stockTable(items) {
  const rows = items.filter((i) => i.active && (i.requestable || i.stock !== 0));
  return h('section.card', { style: { margin: 0 } },
    h('div.card-head', h('h2', 'In the storeroom'),
      h('span.card-note', 'At the start, plus deliveries into the storeroom, less what was issued')),
    table([
      { key: 'name', label: 'Item', format: (v, r) => h('div', h('div', v, r.kind === 'supply' ? h('span.pill', { style: { marginLeft: '.35rem' } }, 'supply') : null), h('small.muted', r.category)) },
      { key: 'stock', label: 'In store', align: 'right', format: (v, r) => h('b', { style: { color: r.low ? 'var(--warn)' : null } }, `${fmtNum(v, 2)} ${r.unit}`) },
      { key: 'par', label: 'Par', align: 'right', format: (v) => (v ? fmtNum(v, 2) : h('span.muted', '—')) },
      { key: 'delivered', label: 'Delivered in', align: 'right', format: (v) => fmtNum(v, 2) },
      { key: 'issued', label: 'Issued out', align: 'right', format: (v) => fmtNum(v, 2) },
      { key: 'value', label: 'Value', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      { key: 'low', label: '', format: (v, r) => (v ? h('span.pill.warn', r.stock <= 0 ? 'none left' : 'low') : null) },
    ], rows, { sortable: true, empty: 'Nothing is kept in the storeroom yet. Choose what can be asked for under Setup.' }),
  );
}
