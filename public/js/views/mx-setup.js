import { api } from '../api.js';
import { attributeSummary, fmtMoney, fmtQty, h, mount, parseAttributes, toast } from '../util.js';
import { card, table } from './components.js';

/**
 * The parts list, and the places work happens.
 *
 * Rooms are added a floor at a time. Typing "Room 201" forty times is how a
 * setup screen goes unused, and an issue screen with no rooms on it files
 * everything against nothing.
 */
export async function renderMxSetup() {
  const [data, areas] = await Promise.all([api.mxBootstrap(), api.mxAreas()]);
  const host = h('div');
  const reload = async () => mount(host, await renderMxSetup());

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Maintenance setup'),
        h('div.sub', 'The parts you keep, and the rooms and areas you keep them for'),
      ),
    ),
    roomsCard(areas.areas, reload),
    itemsCard(data, reload),
  );

  return host;
}

// ---------------------------------------------------------------------------
// Rooms and areas
// ---------------------------------------------------------------------------

function roomsCard(areas, reload) {
  const prefix = h('input', { type: 'text', value: 'Room ', maxlength: 30 });
  const from = h('input', { type: 'number', placeholder: '101', min: '0' });
  const to = h('input', { type: 'number', placeholder: '120', min: '0' });
  const block = h('input', { type: 'text', placeholder: 'First floor', maxlength: 60 });

  const addRange = async (event) => {
    if (!from.value || !to.value) { toast('Give a first and last room number', 'bad'); return; }
    event.target.disabled = true;
    try {
      const result = await api.mxCreateAreaRange({
        prefix: prefix.value, from: Number(from.value), to: Number(to.value), block: block.value.trim() || null,
      });
      toast(`${result.requested} rooms added`, 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const name = h('input', { type: 'text', placeholder: 'e.g. Roof plant room', maxlength: 80 });
  const kind = h('select', h('option', { value: 'area' }, 'Area'), h('option', { value: 'room' }, 'Room'));
  const oneBlock = h('input', { type: 'text', placeholder: 'Block (optional)', maxlength: 60 });

  const addOne = async (event) => {
    if (!name.value.trim()) { toast('Give it a name', 'bad'); return; }
    event.target.disabled = true;
    try {
      await api.mxCreateArea({ name: name.value.trim(), kind: kind.value, block: oneBlock.value.trim() || null });
      toast('Added', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const rooms = areas.filter((a) => a.kind === 'room');
  const places = areas.filter((a) => a.kind === 'area');

  return card('Rooms and areas', {
    wide: true,
    note: `${rooms.length} rooms · ${places.length} other areas`,
  },
    h('h3', { style: { marginBottom: '.5rem' } }, 'Add a whole floor at once'),
    h('div.field-row',
      h('label.field', h('span', 'Name starts with'), prefix),
      h('label.field', h('span', 'First number'), from),
      h('label.field', h('span', 'Last number'), to),
      h('label.field', h('span', 'Block or floor'), block),
    ),
    h('button.btn-primary', { style: { marginTop: '.6rem' }, onclick: addRange }, 'Add these rooms'),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.5rem' } },
      'Rooms that already exist are left alone, so running this twice is safe.'),

    h('h3', { style: { marginTop: '1.2rem', marginBottom: '.5rem' } }, 'Add one place'),
    h('div.field-row',
      h('label.field', h('span', 'Name'), name),
      h('label.field', h('span', 'Kind'), kind),
      h('label.field', h('span', 'Block'), oneBlock),
    ),
    h('button.btn-sm', { style: { marginTop: '.6rem' }, onclick: addOne }, 'Add'),

    h('div', { style: { marginTop: '1.2rem' } },
      table([
        { key: 'name', label: 'Name' },
        { key: 'kind', label: 'Kind', format: (v) => h(`span.pill.${v === 'room' ? 'info' : ''}`, v) },
        { key: 'block', label: 'Block', format: (v) => v || h('span.muted', '—') },
        {
          key: 'active',
          label: 'In use',
          format: (v) => (v ? h('span.pill.good', 'yes') : h('span.pill', 'retired')),
        },
        {
          key: 'id',
          label: '',
          format: (id, row) => h('button.btn-sm.btn-ghost', {
            onclick: async () => {
              if (!confirm(`Remove ${row.name}? If parts were issued to it, it is retired instead of deleted.`)) return;
              try {
                const result = await api.mxDeleteArea(id);
                toast(result.retired ? `${row.name} retired — its history is kept` : 'Removed');
                reload();
              } catch (err) { toast(err.message, 'bad'); }
            },
          }, 'Remove'),
        },
      ], areas, { empty: 'No rooms or areas yet.' })),
  );
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

function itemsCard(data, reload) {
  const name = h('input', { type: 'text', placeholder: 'e.g. LED Bulb 15W', maxlength: 100 });
  const unit = h('input', { type: 'text', value: 'pcs', maxlength: 20 });
  const category = h('select',
    h('option', { value: '' }, 'No category'),
    data.categories.map((c) => h('option', { value: String(c.id) }, c.name)));
  const par = h('input', { type: 'number', step: 'any', min: '0', placeholder: '0' });
  const opening = h('input', { type: 'number', step: 'any', min: '0', placeholder: '0' });
  const cost = h('input', { type: 'number', step: 'any', min: '0', placeholder: '0' });
  const common = h('input', { type: 'checkbox' });
  const attributes = attributeEditor(null, data.items);

  const add = async (event) => {
    if (!name.value.trim()) { toast('Give the part a name', 'bad'); return; }
    event.target.disabled = true;
    try {
      await api.mxCreateItem({
        name: name.value.trim(),
        unit: unit.value.trim() || 'pcs',
        categoryId: category.value || null,
        parLevel: par.value || 0,
        openingStock: opening.value || 0,
        defaultUnitCost: cost.value || 0,
        isCommon: common.checked,
        attributes: attributes.value(),
      });
      toast('Part added', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  return card('The parts list', {
    wide: true,
    note: 'Everyday parts appear on the issue screen without searching',
  },
    h('div.field-row',
      h('label.field', h('span', 'Name'), name),
      h('label.field', h('span', 'Measured in'), unit),
      h('label.field', h('span', 'Category'), category),
      h('label.field', h('span', 'Restock level'), par),
      h('label.field', h('span', 'On the shelf now'), opening),
      h('label.field', h('span', 'Price each'), cost),
      h('label.field', h('span', 'Everyday part'), common),
    ),
    h('div', { style: { marginTop: '.8rem', maxWidth: '520px' } },
      h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Details (optional)'),
      attributes.el),
    h('button.btn-primary', { style: { marginTop: '.8rem' }, onclick: add }, 'Add part'),

    h('div', { style: { marginTop: '1.2rem' } },
      table([
        {
          key: 'name',
          label: 'Part',
          format: (v, r) => h('div',
            h('div', v, r.is_common ? h('span.pill.info', { style: { marginLeft: '.4rem' } }, 'everyday') : null),
            h('small.muted', [
              data.categories.find((c) => c.id === r.category_id)?.name ?? 'Uncategorised',
              attributeSummary(r.attributes),
            ].filter(Boolean).join(' · ')),
          ),
        },
        { key: 'unit', label: 'Unit' },
        { key: 'par_level', label: 'Restock at', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
        { key: 'opening_stock', label: 'Opening', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
        { key: 'default_unit_cost', label: 'Price each', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        {
          key: 'id',
          label: '',
          format: (id, row) => h('div.btn-row',
            h('button.btn-sm', {
              onclick: () => editItem(row, data, reload),
            }, 'Edit'),
            h('button.btn-sm.btn-ghost', {
              onclick: async () => {
                if (!confirm(`Remove ${row.name}? If it has history it is retired instead.`)) return;
                try {
                  const result = await api.mxDeleteItem(id);
                  toast(result.retired ? `${row.name} retired — its history is kept` : 'Removed');
                  reload();
                } catch (err) { toast(err.message, 'bad'); }
              },
            }, 'Remove'),
          ),
        },
      ], data.items, { empty: 'No parts yet.' })),
  );
}

/**
 * The variables an administrator puts on a part: size, colour, rating, whatever
 * this hotel uses to tell two similar things apart.
 *
 * Labels are suggested from what is already in use rather than fixed, so the
 * list stays consistent without anybody being told what a part is allowed to
 * have. Free-form was the only honest choice — one hotel sorts bulbs by
 * wattage and colour temperature, the next by fitting and lumens.
 */
function attributeEditor(initial, allItems) {
  const rows = Object.entries(parseAttributes(initial)).map(([label, value]) => ({ label, value }));
  const host = h('div', { style: { display: 'grid', gap: '.4rem' } });

  // Labels already in use anywhere, so "Colour" does not become "colour".
  const known = new Set();
  for (const item of allItems ?? []) {
    for (const label of Object.keys(parseAttributes(item.attributes))) known.add(label);
  }
  for (const suggestion of ['Size', 'Colour', 'Rating', 'Material', 'Fitting', 'Model', 'Finish']) {
    known.add(suggestion);
  }
  const listId = `mx-attr-labels-${Math.random().toString(36).slice(2, 8)}`;
  const datalist = h('datalist', { id: listId }, [...known].sort().map((l) => h('option', { value: l })));

  const draw = () => {
    mount(host,
      datalist,
      rows.length
        ? rows.map((row, index) => h('div', {
          style: { display: 'grid', gridTemplateColumns: '1fr 1.4fr auto', gap: '.4rem' },
        },
          h('input', {
            type: 'text', placeholder: 'Detail (e.g. Size)', value: row.label,
            list: listId, maxlength: 40,
            oninput: (e) => { row.label = e.target.value; },
          }),
          h('input', {
            type: 'text', placeholder: 'Value (e.g. 9W)', value: row.value, maxlength: 80,
            oninput: (e) => { row.value = e.target.value; },
          }),
          h('button.btn-sm.btn-ghost', {
            onclick: () => { rows.splice(index, 1); draw(); },
          }, '✕'),
        ))
        : h('p.muted', { style: { fontSize: '.84rem', margin: 0 } },
          'No details yet — add size, colour or anything else that tells this part '
          + 'apart from a similar one.'),
      h('button.btn-sm', {
        style: { marginTop: '.2rem', justifySelf: 'start' },
        onclick: () => { rows.push({ label: '', value: '' }); draw(); },
      }, '+ Add a detail'),
    );
  };
  draw();

  return {
    el: host,
    // Half-filled rows are dropped rather than refused: somebody who started
    // typing and thought better of it has not made a mistake worth a dialog.
    value: () => {
      const out = {};
      for (const row of rows) {
        const label = row.label.trim();
        const value = row.value.trim();
        if (label && value) out[label] = value;
      }
      return Object.keys(out).length ? out : null;
    },
  };
}

function editItem(item, data, reload) {
  const name = h('input', { type: 'text', value: item.name, maxlength: 100 });
  const unit = h('input', { type: 'text', value: item.unit, maxlength: 20 });
  const category = h('select',
    h('option', { value: '' }, 'No category'),
    data.categories.map((c) => h('option', {
      value: String(c.id), selected: c.id === item.category_id,
    }, c.name)));
  const par = h('input', { type: 'number', step: 'any', min: '0', value: String(item.par_level) });
  const opening = h('input', { type: 'number', step: 'any', min: '0', value: String(item.opening_stock) });
  const cost = h('input', { type: 'number', step: 'any', min: '0', value: String(item.default_unit_cost) });
  const common = h('input', { type: 'checkbox', checked: Boolean(item.is_common) });
  const attributes = attributeEditor(item.attributes, data.items);
  const error = h('p.form-error');

  const save = async (event) => {
    event.target.disabled = true;
    try {
      await api.mxUpdateItem(item.id, {
        name: name.value.trim(),
        unit: unit.value.trim() || 'pcs',
        categoryId: category.value || null,
        parLevel: par.value || 0,
        openingStock: opening.value || 0,
        defaultUnitCost: cost.value || 0,
        isCommon: common.checked,
        attributes: attributes.value(),
        active: true,
      });
      toast('Saved', 'good');
      dialog.close();
      reload();
    } catch (err) {
      error.textContent = err.message;
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
    h('div.card-head', h('h2', 'Edit part'), h('button.btn-sm.btn-ghost', { onclick: () => dialog.close() }, '✕')),
    h('label.field', h('span', 'Name'), name),
    h('label.field', h('span', 'Measured in'), unit),
    h('label.field', h('span', 'Category'), category),
    h('label.field', h('span', 'Restock level'), par),
    h('label.field', h('span', 'Opening stock'), opening),
    h('label.field', h('span', 'Price each'), cost),
    h('label.field', h('span', 'Show on the issue screen without searching'), common),
    h('div', { style: { marginTop: '.7rem' } },
      h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Details'),
      attributes.el),
    error,
    h('div.btn-row', { style: { justifyContent: 'flex-end', marginTop: '.8rem' } },
      h('button', { onclick: () => dialog.close() }, 'Cancel'),
      h('button.btn-primary', { onclick: save }, 'Save'),
    ),
  );

  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}
