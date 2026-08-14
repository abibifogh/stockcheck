import { api } from '../api.js';
import { navigate } from '../app.js';
import { debounce, h, mount, toast } from '../util.js';
import { card, table } from './components.js';
import { co, dialogActions, field, modal, refreshCo, select } from './co-common.js';

/**
 * Clients, and everybody else the firm writes to.
 *
 * One list rather than a list per kind. The register asks "who is this from",
 * and the answer has the same shape whether it is a client, the Revenue
 * Authority or another firm of auditors — so splitting them into separate
 * screens would only mean deciding which screen to look on before you could
 * start looking.
 */
export async function renderCoClients(params) {
  const query = { q: params.q ?? '', kind: params.kind ?? '' };
  const data = await api.coParties({ ...query, all: params.all ?? '' });
  const host = h('div');
  const reload = async () => mount(host, await renderCoClients(params));

  const search = h('input', {
    type: 'search', value: query.q, placeholder: 'Name, client code, TIN or email',
    style: { minWidth: '260px' },
  });
  search.addEventListener('input', debounce(() => {
    navigate('co-clients', { ...params, q: search.value || undefined });
  }, 400));

  const kinds = h('div.seg',
    ...[['', 'All'], ['client', 'Clients'], ['authority', 'Authorities'],
      ['bank', 'Banks'], ['auditor', 'Auditors'], ['other', 'Other']]
      .map(([value, label]) => h('button', {
        class: query.kind === value ? 'active' : '',
        onclick: () => navigate('co-clients', { ...params, kind: value || undefined }),
      }, label)),
  );

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Clients and parties'),
        h('div.sub', `${data.parties.length} on the list`),
      ),
      h('button.btn-primary.btn-sm', { onclick: () => openParty(null, reload) }, '+ Add'),
    ),
    card(null, { wide: true }, h('div.toolbar', search, kinds)),
    card(null, { wide: true }, table([
      {
        key: 'name',
        label: 'Name',
        format: (name, r) => h('div',
          h('div', h('b', name)),
          h('small.muted',
            r.client_code ? `${r.client_code} · ` : '',
            r.tin ? `TIN ${r.tin} · ` : '',
            r.sector ?? '',
          ),
        ),
      },
      { key: 'kind', label: 'Kind', format: (v) => h('span.pill', v) },
      {
        key: 'contact_name',
        label: 'Contact',
        format: (contact, r) => h('div',
          h('div', contact ?? h('span.muted', '—')),
          r.email ? h('small.muted', r.email) : null,
        ),
      },
      {
        key: 'open_cases',
        label: 'Engagements',
        align: 'right',
        format: (n, r) => (n
          ? h('a', { href: `#/co-cases?party=${r.id}` }, `${n} open`)
          : h('span.muted', '—')),
      },
      {
        key: 'letters',
        label: 'Letters',
        align: 'right',
        format: (n, r) => (n
          ? h('a', { href: `#/co-register?party=${r.id}&status=all` }, String(n))
          : h('span.muted', '0')),
      },
      {
        key: 'id',
        label: '',
        align: 'right',
        format: (id, r) => h('button.btn-sm', { onclick: () => openParty(r, reload) }, 'Edit'),
      },
    ], data.parties, { empty: 'Nobody on the list yet. Add your first client.' })),
  );

  return host;
}

function openParty(party, reload) {
  const name = h('input', { value: party?.name ?? '', maxlength: 200 });
  const kind = select(
    ['client', 'authority', 'bank', 'auditor', 'supplier', 'other']
      .map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) })),
    { value: party?.kind ?? 'client' },
  );
  const clientCode = h('input', { value: party?.client_code ?? '', maxlength: 40, placeholder: 'Your own code for them' });
  const tin = h('input', { value: party?.tin ?? '', maxlength: 40 });
  const contactName = h('input', { value: party?.contact_name ?? '', maxlength: 200 });
  const email = h('input', { type: 'email', value: party?.email ?? '', maxlength: 200 });
  const phone = h('input', { value: party?.phone ?? '', maxlength: 60 });
  const sector = h('input', { value: party?.sector ?? '', maxlength: 120, placeholder: 'e.g. Manufacturing' });
  const address = h('textarea', { rows: 3, value: party?.address ?? '' });
  const note = h('textarea', { rows: 2, value: party?.note ?? '' });
  const active = h('input', { type: 'checkbox', checked: party ? Boolean(party.active) : true });

  const dialog = modal(party ? `Edit ${party.name}` : 'Add a client or party', { width: '640px' },
    h('div.field-row', field('Name', name), field('Kind', kind)),
    h('div.field-row', field('Client code', clientCode), field('TIN', tin), field('Sector', sector)),
    h('div.field-row', field('Contact', contactName), field('Email', email), field('Phone', phone)),
    field('Address', address),
    field('Note', note),
    party
      ? h('label.inline-check', active, h('span', 'On the active list'))
      : null,
  );

  dialog.append(dialogActions(dialog, party ? 'Save' : 'Add', async () => {
    const body = {
      name: name.value.trim(),
      kind: kind.value,
      clientCode: clientCode.value.trim(),
      tin: tin.value.trim(),
      contactName: contactName.value.trim(),
      email: email.value.trim(),
      phone: phone.value.trim(),
      sector: sector.value.trim(),
      address: address.value.trim(),
      note: note.value.trim(),
      ...(party ? { active: active.checked } : {}),
    };
    if (!body.name) throw new Error('A name is required');
    if (party) await api.coUpdateParty(party.id, body);
    else await api.coCreateParty(body);
    refreshCo();
    toast('Saved', 'good');
    await reload();
  }));

  setTimeout(() => name.focus(), 0);
}

/** Exported so the compose dialog can offer "add a new client" inline. */
export { openParty };
