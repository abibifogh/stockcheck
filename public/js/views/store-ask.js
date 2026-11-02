import { api } from '../api.js';
import { fmtNum, h, mount, toast } from '../util.js';
import { emptyState } from './components.js';
import { statusPill, timeOf } from './store-common.js';

/**
 * Asking the storeroom for things, and saying what arrived.
 *
 * Built for a phone held in one hand in a busy kitchen: the items this person
 * usually asks for are already on the screen, every control is a thumb's
 * width, and nothing on it carries a price.
 */
export async function renderAsk(params = {}) {
  const [catalog, mine] = await Promise.all([api.storeCatalog(), api.storeRequests('mine')]);
  const host = h('div.entry-page');

  const toConfirm = mine.requests.filter((r) => r.status === 'issued');
  let tab = params.tab === 'mine' || (toConfirm.length && params.tab !== 'new') ? 'mine' : 'new';
  // Prefilled by "Ask again".
  const prefill = new Map((params.again ?? []).map((l) => [l.ingredientId, l.asked]));

  const reload = async (next = {}) => mount(host, await renderAsk(next));
  const show = (name) => { tab = name; paint(); };

  function paint() {
    mount(host,
      h('div.page-head',
        h('div',
          h('h1', 'Ask the storeroom'),
          h('div.sub', 'The storeroom is told the moment you send it')),
      ),
      h('div.seg.seg-fill.seg-row', { role: 'tablist', style: { marginBottom: '1rem' } },
        h('button', { class: tab === 'new' ? 'active' : '', role: 'tab', onclick: () => show('new') }, 'New request'),
        h('button', { class: tab === 'mine' ? 'active' : '', role: 'tab', onclick: () => show('mine') },
          'My requests',
          toConfirm.length ? h('span.pill.warn', { style: { marginLeft: '.4rem', padding: '0 .4rem' }, title: 'Waiting for you to confirm' }, String(toConfirm.length)) : null),
      ),
      tab === 'new'
        ? newRequest(catalog, prefill, () => reload({ tab: 'mine' }))
        : myRequests(mine.requests, reload),
    );
  }

  paint();
  return host;
}

// ----------------------------------------------------------- new request --

function newRequest(catalog, prefill, onSent) {
  const qty = new Map(prefill);
  const byId = new Map(catalog.items.map((i) => [i.id, i]));
  let needed = 'now';
  let search = '';

  const department = catalog.departments.length > 1
    ? h('select', catalog.departments.map((d) => h('option', { value: d }, d)))
    : null;
  const note = h('input', { type: 'text', placeholder: 'For the storeroom: what it is for, where to leave it…' });
  const listHost = h('div');
  const totalOut = h('div.entry-status');
  const send = h('button.btn-primary', { onclick: submit }, 'Send request');

  const neededSeg = h('div.seg.seg-fill.seg-row', { role: 'radiogroup', 'aria-label': 'Needed' });
  const paintNeeded = () => mount(neededSeg, catalog.needed.map((n) => h('button', {
    class: needed === n.key ? 'active' : '',
    role: 'radio',
    'aria-checked': String(needed === n.key),
    onclick: () => { needed = n.key; paintNeeded(); },
  }, n.label)));
  paintNeeded();

  function row(item) {
    const value = qty.get(item.id) ?? 0;
    const input = h('input', {
      type: 'number', min: 0, step: 'any', inputMode: 'decimal', value: value || '',
      placeholder: '0', 'aria-label': `How many ${item.name}`,
    });
    const set = (n) => {
      const clean = Math.max(0, Math.round(Number(n) * 100) / 100 || 0);
      if (clean) qty.set(item.id, clean); else qty.delete(item.id);
      input.value = clean || '';
      el.classList.toggle('filled', clean > 0);
      paintTotal();
    };
    input.addEventListener('input', () => set(input.value));
    const stockText = item.stock <= 0 ? 'None in the storeroom' : `${fmtNum(item.stock, 2)} in the storeroom`;
    const el = h(`div.item${value ? '.filled' : ''}`,
      h('div',
        h('div.item-name', item.name),
        h('div.item-hint',
          h('span', item.unit),
          h('span', { style: { color: item.low ? 'var(--warn)' : null } }, `· ${stockText}`))),
      h('div.item-input',
        h('button', { 'aria-label': `One fewer ${item.name}`, onclick: () => set((qty.get(item.id) ?? 0) - 1) }, '−'),
        input,
        h('button', { 'aria-label': `One more ${item.name}`, onclick: () => set((qty.get(item.id) ?? 0) + 1) }, '+')),
    );
    return el;
  }

  function paintList() {
    const term = search.trim().toLowerCase();
    const chosen = [...qty.keys()].map((id) => byId.get(id)).filter(Boolean);
    const usual = catalog.usual.map((id) => byId.get(id)).filter((i) => i && !qty.has(i.id));
    const others = catalog.items.filter((i) => !qty.has(i.id) && !catalog.usual.includes(i.id));
    const matches = (i) => !term || i.name.toLowerCase().includes(term) || (i.category || '').toLowerCase().includes(term);

    const section = (title, items) => (items.length
      ? h('div', { style: { marginBottom: '1rem' } },
        h('div.stat-label', { style: { margin: '0 0 .45rem' } }, title),
        h('div.item-list', items.map(row)))
      : null);

    mount(listHost,
      section('In this request', chosen),
      term
        ? section('Found', [...usual, ...others].filter(matches))
        : [section('You usually ask for', usual), section('Everything else', others)],
      !catalog.items.length
        ? emptyState('Nothing to ask for yet', 'An administrator chooses what can be asked for under Setup.')
        : null,
      term && ![...usual, ...others].some(matches)
        ? h('p.muted', `Nothing in the storeroom is called “${search}”.`)
        : null,
    );
  }

  function paintTotal() {
    const n = qty.size;
    totalOut.textContent = n ? `${n} item${n === 1 ? '' : 's'} in this request` : 'Nothing chosen yet';
    send.disabled = !n;
  }

  async function submit() {
    if (!qty.size) return;
    send.disabled = true;
    try {
      const { request } = await api.createStoreRequest({
        department: department?.value,
        needed,
        note: note.value.trim() || null,
        lines: [...qty].map(([ingredientId, amount]) => ({ ingredient_id: ingredientId, qty: amount })),
      });
      toast(`${request.ref} sent to the storeroom`, 'good');
      onSent();
    } catch (err) {
      toast(err.message, 'bad');
      send.disabled = false;
    }
  }

  const searchBox = h('input', {
    type: 'search', placeholder: 'Find something else…', 'aria-label': 'Search the storeroom',
    oninput: (e) => { search = e.target.value; paintList(); },
  });

  paintList();
  paintTotal();

  return h('div',
    department ? h('label.field', { style: { marginBottom: '.8rem' } }, h('span', 'For'), department) : null,
    h('div.field', { style: { marginBottom: '.8rem' } }, h('span', 'Needed'), neededSeg),
    h('label.field', { style: { marginBottom: '1rem' } }, h('span', 'Search'), searchBox),
    listHost,
    h('label.field', { style: { marginTop: '.4rem' } }, h('span', 'Note (optional)'), note),
    h('div.entry-footer', h('div.entry-footer-inner', totalOut, send)),
  );
}

// ------------------------------------------------------------ my requests --

function myRequests(requests, reload) {
  if (!requests.length) {
    return emptyState('No requests yet', 'What you ask the storeroom for, and what it sends, will be listed here.');
  }
  return h('div', { style: { display: 'grid', gap: '.8rem' } }, requests.map((r) => requestCard(r, reload)));
}

function requestCard(r, reload) {
  const body = h('div');
  const short = r.lines.filter((l) => l.issued != null && l.issued < l.asked);

  const linesTable = () => h('div.table-wrap', { style: { margin: '.5rem 0' } },
    h('table',
      h('thead', h('tr', h('th', 'Item'), h('th', { style: { textAlign: 'right' } }, 'Asked'),
        r.lines.some((l) => l.issued != null) ? h('th', { style: { textAlign: 'right' } }, 'Issued') : null,
        r.lines.some((l) => l.received != null) ? h('th', { style: { textAlign: 'right' } }, 'Received') : null)),
      h('tbody', r.lines.map((l) => h('tr',
        h('td', h('div', l.name), l.shortReason ? h('small', { style: { color: 'var(--warn)' } }, l.shortReason) : null),
        h('td', { style: { textAlign: 'right' } }, `${fmtNum(l.asked, 2)} ${l.unit}`),
        r.lines.some((x) => x.issued != null)
          ? h('td', { style: { textAlign: 'right', fontWeight: 650, color: l.issued < l.asked ? 'var(--warn)' : 'var(--good)' } },
            l.issued == null ? '—' : fmtNum(l.issued, 2))
          : null,
        r.lines.some((x) => x.received != null)
          ? h('td', { style: { textAlign: 'right' } }, l.received == null ? '' : fmtNum(l.received, 2))
          : null)))));

  const act = async (fn, okText, button) => {
    if (button) button.disabled = true;
    try {
      await fn();
      toast(okText, 'good');
      reload({ tab: 'mine' });
    } catch (err) {
      toast(err.message, 'bad');
      if (button) button.disabled = false;
    }
  };

  // Something's wrong: say what actually arrived, line by line.
  function differenceForm() {
    const inputs = new Map();
    const note = h('input', { type: 'text', placeholder: 'What was wrong? e.g. one carton missing' });
    const save = h('button.btn-primary', {
      onclick: () => act(() => api.receiveStoreRequest(r.id, {
        lines: [...inputs].map(([id, input]) => ({ id, received: Number(input.value) || 0 })),
        note: note.value.trim() || null,
      }), 'Thank you — the storeroom and the manager have been told', save),
    }, 'Send');
    mount(body,
      h('p', { style: { margin: '.4rem 0' } }, 'How much of each actually arrived?'),
      h('div.item-list', r.lines.filter((l) => l.issued > 0).map((l) => {
        const input = h('input', { type: 'number', min: 0, step: 'any', value: l.issued, 'aria-label': `${l.name} received` });
        inputs.set(l.id, input);
        return h('div.item',
          h('div', h('div.item-name', l.name), h('div.item-hint', `Issued ${fmtNum(l.issued, 2)} ${l.unit}`)),
          h('div.item-input', input));
      })),
      h('label.field', { style: { marginTop: '.6rem' } }, h('span', 'What was wrong'), note),
      h('div.btn-row', { style: { marginTop: '.6rem' } },
        save,
        h('button', { onclick: () => mount(body, ...actions()) }, 'Back')),
    );
  }

  function actions() {
    const parts = [linesTable()];
    if (r.issueNote) parts.push(h('p.muted', { style: { fontSize: '.84rem', margin: '.2rem 0' } }, `Storeroom: “${r.issueNote}”`));
    if (r.status === 'issued') {
      const ok = h('button.btn-primary', {
        onclick: () => act(() => api.receiveStoreRequest(r.id, {}), 'Confirmed', ok),
      }, 'Got it all');
      parts.push(h('div.btn-row', ok, h('button', { onclick: differenceForm }, 'Something’s wrong')));
      if (short.length) {
        parts.push(h('p.muted', { style: { fontSize: '.8rem' } },
          `${short.map((l) => l.name).join(', ')} stay${short.length === 1 ? 's' : ''} on the storeroom’s list as a new request until it is in stock, or you cancel it.`));
      }
    } else if (r.status === 'received' && r.receivedAuto) {
      parts.push(h('p.muted', { style: { fontSize: '.84rem' } }, 'Nobody confirmed this, so it was taken as received.'),
        h('div.btn-row', h('button', { onclick: differenceForm }, 'Something was wrong')));
    } else if (r.status === 'waiting') {
      const cancel = h('button.btn-danger', {
        onclick: () => {
          if (!window.confirm(`Cancel ${r.ref}?`)) return;
          act(() => api.cancelStoreRequest(r.id), `${r.ref} cancelled`, cancel);
        },
      }, 'Cancel request');
      parts.push(h('div.btn-row', cancel));
    } else {
      parts.push(h('div.btn-row', h('button.btn-sm', {
        onclick: () => reload({ tab: 'new', again: r.lines }),
      }, 'Ask again')));
    }
    return parts;
  }

  mount(body, ...actions());

  const when = [
    timeOf(r.createdAt),
    r.department,
    r.requestedBy,
    r.follows ? `the rest of ${r.follows}` : null,
  ].filter(Boolean).join(' · ');

  return h('section.card', { style: { margin: 0, borderColor: r.status === 'issued' ? 'var(--warn)' : null } },
    h('div.card-head',
      h('h2', r.ref),
      statusPill(r),
    ),
    h('div.muted', { style: { fontSize: '.84rem' } }, when,
      r.issuedBy ? ` · issued by ${r.issuedBy} ${timeOf(r.issuedAt)}` : ''),
    r.note ? h('div', { style: { fontSize: '.88rem', marginTop: '.3rem' } }, `“${r.note}”`) : null,
    body,
  );
}
