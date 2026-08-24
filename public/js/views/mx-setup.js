import { api } from '../api.js';
import {
  attributeSearchText, attributeSummary, fmtMoney, fmtQty, h, mount, parseAttributes, toast,
} from '../util.js';
import { card, nextSort, sortHeader, sorted, table } from './components.js';
import { schedulesCard } from './mx-schedules.js';

/**
 * The parts list, and the places work happens.
 *
 * Rooms are added a floor at a time. Typing "Room 201" forty times is how a
 * setup screen goes unused, and an issue screen with no rooms on it files
 * everything against nothing.
 */
export async function renderMxSetup() {
  const [data, areas, schedules, products] = await Promise.all([
    api.mxBootstrap(),
    api.mxAreas(),
    // A store that has not run the latest database changes yet should still be
    // able to reach its parts list, so a missing schedules table is survivable.
    api.mxStocktakes().catch(() => null),
    // Absent until 0018 has run. The parts list itself does not depend on it.
    api.mxProducts().catch(() => null),
  ]);
  const host = h('div');
  const reload = async () => mount(host, await renderMxSetup());

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Maintenance setup'),
        h('div.sub', 'The parts you keep, the rooms you keep them for, and when they get counted'),
      ),
    ),
    roomsCard(areas.areas, reload),
    schedules ? schedulesCard(schedules, reload) : null,
    productsCard(products, data, reload),
    bulkPartsCard(data, reload),
    itemsCard(data, reload),
  );

  return host;
}

// ---------------------------------------------------------------------------
// Selecting several rows
// ---------------------------------------------------------------------------

/**
 * Tick boxes down the side of a table, and a bar that appears when anything is
 * ticked.
 *
 * Clearing out a hotel's worth of rooms one confirm dialog at a time is the
 * sort of chore that gets abandoned half way, leaving a list that is worse than
 * either the old one or the new one.
 *
 * The header box is three-state on purpose: ticked when everything is, dashed
 * when only some are, so it says what it will do before you press it.
 */
function selection(rows, onChange) {
  const chosen = new Set();
  const boxes = new Map();
  let headBox = null;

  const refresh = () => {
    if (headBox) {
      headBox.checked = chosen.size > 0 && chosen.size === rows.length;
      headBox.indeterminate = chosen.size > 0 && chosen.size < rows.length;
    }
    onChange(chosen);
  };

  return {
    chosen,
    clear: () => { chosen.clear(); for (const box of boxes.values()) box.checked = false; refresh(); },

    headerBox: () => {
      headBox = h('input', {
        type: 'checkbox',
        title: 'Select all',
        onchange: (e) => {
          chosen.clear();
          if (e.target.checked) for (const row of rows) chosen.add(row.id);
          for (const [id, box] of boxes) box.checked = chosen.has(id);
          refresh();
        },
      });
      return headBox;
    },

    rowBox: (row) => {
      const box = h('input', {
        type: 'checkbox',
        checked: chosen.has(row.id),
        onchange: (e) => {
          if (e.target.checked) chosen.add(row.id);
          else chosen.delete(row.id);
          refresh();
        },
      });
      boxes.set(row.id, box);
      return box;
    },
  };
}

/** The bar that appears once something is ticked. */
function selectionBar({ noun, onRemove, onClear }) {
  const label = h('span');
  const bar = h('div.bulk-bar', { style: { display: 'none' } },
    label,
    h('div.btn-row',
      h('button.btn-sm', { onclick: onClear }, 'Clear'),
      h('button.btn-sm.btn-danger', { onclick: onRemove }, 'Remove selected'),
    ),
  );

  return {
    el: bar,
    update: (chosen) => {
      bar.style.display = chosen.size ? '' : 'none';
      label.textContent = `${chosen.size} ${chosen.size === 1 ? noun : `${noun}s`} selected`;
    },
  };
}

/** One place to say what happened, since deleting and retiring both can. */
function describeRemoval(result, noun) {
  const parts = [];
  if (result.deleted) parts.push(`${result.deleted} removed`);
  if (result.retired) {
    parts.push(`${result.retired} retired — ${result.retired === 1 ? 'it has' : 'they have'} history worth keeping`);
  }
  return parts.join(', ') || `No ${noun}s were changed`;
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

  const picked = selection(areas, (chosen) => bar.update(chosen));
  const bar = selectionBar({
    noun: 'place',
    onClear: () => picked.clear(),
    onRemove: async (event) => {
      const ids = [...picked.chosen];
      if (!confirm(`Remove ${ids.length} ${ids.length === 1 ? 'place' : 'places'}? `
        + 'Any that have had parts issued to them are retired instead, so their history survives.')) return;
      event.target.disabled = true;
      try {
        const result = await api.mxRemoveAreas(ids);
        toast(describeRemoval(result, 'place'), 'good');
        reload();
      } catch (err) {
        toast(err.message, 'bad');
        event.target.disabled = false;
      }
    },
  });

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
      bar.el,
      table([
        { key: 'id', label: picked.headerBox(), cls: 'tick', format: (_v, row) => picked.rowBox(row) },
        { key: 'name', label: 'Name', cls: 'wrap' },
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
// Bulk upload
// ---------------------------------------------------------------------------

/**
 * Loading the parts list from a spreadsheet.
 *
 * Adding thirty-five parts one form at a time is how a store gets set up with
 * eight of them. The template comes down pre-filled with whatever is already
 * there, so the same file works to create the list, correct prices across the
 * board, or re-level everything after a stocktake.
 *
 * Details are ordinary columns: a "Size" column makes every part in it have a
 * size. That is how somebody would lay the sheet out anyway.
 */
function bulkPartsCard(data, reload) {
  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv' });
  const existing = h('select',
    h('option', { value: '0' }, 'Skip parts that are already in the list'),
    h('option', { value: '1' }, 'Update parts that are already in the list'),
  );

  const resultHost = h('div');
  let csvText = null;
  let ready = false;

  const applyBtn = h('button.btn-primary', {
    disabled: true,
    onclick: async (event) => {
      if (!csvText || !ready) return;
      if (!confirm('Import these parts now?')) return;
      event.target.disabled = true;
      try {
        const result = await api.mxImportParts({
          csv: csvText, apply: true, overwrite: existing.value === '1',
        });
        toast(`${result.created} added, ${result.updated} updated`, 'good');
        reload();
      } catch (err) {
        toast(err.message, 'bad');
        event.target.disabled = false;
      }
    },
  }, 'Import for real');

  const preview = async () => {
    if (!csvText) { toast('Choose a file first', 'bad'); return; }
    mount(resultHost, h('div.skeleton', { style: { height: '60px' } }));
    try {
      const result = await api.mxImportParts({
        csv: csvText, apply: false, overwrite: existing.value === '1',
      });
      ready = result.canApply;
      applyBtn.disabled = !ready;
      mount(resultHost, previewReport(result));
    } catch (err) {
      ready = false;
      applyBtn.disabled = true;
      mount(resultHost, h('div.alert.high',
        h('span.alert-icon', '⛔'),
        h('div', h('div.alert-title', 'That file could not be read'), h('div.alert-detail', err.message))));
    }
  };

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    csvText = await file.text();
    ready = false;
    applyBtn.disabled = true;
    preview();
  });

  return card('Load the parts list from a spreadsheet', {
    wide: true,
    note: 'For setting the store up, or changing a lot of parts at once',
  },
    h('div.btn-row', { style: { marginBottom: '.8rem' } },
      h('a.btn.btn-sm', { href: api.mxPartsTemplateUrl(), download: '' }, '⬇ Download the template'),
    ),
    h('p.muted', { style: { fontSize: '.85rem' } },
      'The template comes down with the parts you already have, so you can correct them in a '
      + 'spreadsheet and load them back. Add rows for anything new.'),
    h('p.muted', { style: { fontSize: '.85rem' } },
      h('strong', 'Sizes, colours and the rest are just columns. '),
      'Any column that is not one of the standard ones becomes a detail on the part — put “15W” '
      + 'under a Size column and “Chrome” under a Colour column, and that is what you get. Leave a '
      + 'cell blank and that part simply has no such detail.'),
    h('div.field-row',
      h('label.field', h('span', 'Your filled-in file'), fileInput),
      h('label.field', h('span', 'If a part is already there'), existing),
    ),
    h('div.btn-row', h('button', { onclick: preview }, 'Check the file'), applyBtn),
    h('div', { style: { marginTop: '.9rem' } }, resultHost),
  );
}

function previewReport(result) {
  const s = result.summary;

  return h('div',
    h('div.grid.grid-4', { style: { marginBottom: '.8rem' } },
      h('div.stat', h('div.stat-label', 'Rows read'), h('div.stat-value', String(s.rowsRead))),
      h('div.stat', h('div.stat-label', 'Will be added'),
        h('div.stat-value', { style: { color: 'var(--good)' } }, String(s.willCreate))),
      h('div.stat', h('div.stat-label', 'Will be updated'),
        h('div.stat-value', { style: { color: s.willUpdate ? 'var(--c3)' : undefined } }, String(s.willUpdate))),
      h('div.stat', h('div.stat-label', 'Left alone'), h('div.stat-value', String(s.willSkip))),
    ),

    s.detailColumns?.length
      ? h('div.guide-note', { style: { marginTop: 0 } },
        h('strong', 'Details found: '), s.detailColumns.join(', '),
        '. Every value in those columns becomes a detail on that part.')
      : h('div.guide-note', { style: { marginTop: 0 } },
        h('strong', 'No detail columns. '),
        'Add columns like Size or Colour to the spreadsheet if you want them.'),

    s.newCategories?.length
      ? h('div.guide-note', h('strong', 'New categories will be created: '), s.newCategories.join(', '))
      : null,

    s.newProducts?.length
      ? h('div.guide-note',
        h('strong', 'New products will be created: '), s.newProducts.join(', '),
        '. Each variant under them becomes a part of its own, counted separately.')
      : null,

    s.errorCount
      ? h('div.alert.high', { style: { marginTop: '.7rem' } },
        h('span.alert-icon', '⛔'),
        h('div',
          h('div.alert-title', `${s.errorCount} ${s.errorCount === 1 ? 'problem' : 'problems'} to fix first`),
          h('div.alert-detail', h('ul', { style: { margin: '.3rem 0 0', paddingLeft: '1.1rem' } },
            s.errors.map((e) => h('li', e)))),
        ))
      : null,

    s.willSkip && !s.errorCount
      ? h('p.muted', { style: { fontSize: '.83rem' } },
        `${s.willSkip} ${s.willSkip === 1 ? 'part is' : 'parts are'} already in the list and will be `
        + 'left as they are. Choose “Update parts that are already in the list” above to change them.')
      : null,

    result.preview?.length
      ? h('div', { style: { marginTop: '.8rem' } },
        h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'A sample of what will happen'),
        table([
          { key: 'line', label: 'Row', format: (v) => h('span.muted', String(v)) },
          {
            key: 'action',
            label: '',
            format: (v) => h(`span.pill.${v === 'create' ? 'good' : 'warn'}`, v === 'create' ? 'add' : 'update'),
          },
          {
            key: 'name',
            label: 'Part',
            cls: 'wrap',
            format: (v, r) => (r.variant
              ? h('div', h('div', v), h('small.muted', `${r.product} · ${r.variant}`))
              : v),
          },
          { key: 'category', label: 'Category', cls: 'wrap', format: (v) => v || h('span.muted', '—') },
          { key: 'unit', label: 'Unit' },
          { key: 'parLevel', label: 'Restock at', align: 'right' },
          { key: 'openingStock', label: 'On shelf', align: 'right' },
          { key: 'defaultUnitCost', label: 'Price each', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
          {
            key: 'attributes',
            label: 'Details',
            format: (v) => (attributeSummary(v) ? h('span.muted', attributeSummary(v)) : '—'),
          },
        ], result.preview))
      : null,
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

  // The list outgrew scrolling. Variants multiply it — one bulb kept in three
  // colours is three rows — so finding a part meant reading every name until
  // one matched.
  const categoryName = (r) => data.categories.find((c) => c.id === r.category_id)?.name ?? 'Uncategorised';

  let query = '';
  let categoryId = '';
  let everydayOnly = false;
  let sort = { key: 'name', dir: 'asc' };
  const NUMERIC = ['par_level', 'opening_stock', 'default_unit_cost'];

  const search = h('input', {
    type: 'search', placeholder: 'Search name, category or detail…', maxlength: 60,
    oninput: (e) => { query = e.target.value.trim().toLowerCase(); paintList(); },
  });
  const categoryPick = h('select', {
    onchange: (e) => { categoryId = e.target.value; paintList(); },
  },
    h('option', { value: '' }, 'Every category'),
    data.categories.map((c) => h('option', { value: String(c.id) }, c.name)));
  const everydayPick = h('input', {
    type: 'checkbox',
    onchange: (e) => { everydayOnly = e.target.checked; paintList(); },
  });

  // Matched against everything shown on the row, so what somebody can see is
  // what they can search for — the detail under the name included.
  const matches = (r) => {
    if (categoryId && String(r.category_id ?? '') !== categoryId) return false;
    if (everydayOnly && !r.is_common) return false;
    if (!query) return true;
    return [r.name, r.variant, r.unit, categoryName(r), attributeSearchText(r.attributes)]
      .filter(Boolean).join(' ').toLowerCase()
      .includes(query);
  };

  const onSort = (key) => { sort = nextSort(sort, key, { numeric: NUMERIC }); paintList(); };
  const listHost = h('div');

  const picked = selection(data.items, (chosen) => bar.update(chosen));
  const bar = selectionBar({
    noun: 'part',
    onClear: () => picked.clear(),
    onRemove: async (event) => {
      const ids = [...picked.chosen];
      if (!confirm(`Remove ${ids.length} ${ids.length === 1 ? 'part' : 'parts'}? `
        + 'Any that have been issued or bought are retired instead, so past months still add up.')) return;
      event.target.disabled = true;
      try {
        const result = await api.mxRemoveItems(ids);
        toast(describeRemoval(result, 'part'), 'good');
        reload();
      } catch (err) {
        toast(err.message, 'bad');
        event.target.disabled = false;
      }
    },
  });

  const el = card('The parts list', {
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
      h('div.field-row',
        h('label.field', h('span', 'Search'), search),
        h('label.field', h('span', 'Category'), categoryPick),
        h('label.field', h('span', 'Everyday only'), everydayPick),
      ),
      bar.el,
      listHost),
  );

  function paintList() {
    const rows = sorted(data.items.filter(matches), sort, {
      // Category sorts by its name rather than its id, which is a number
      // nobody chose and an order nobody expects.
      value: (r, k) => (k === 'category' ? categoryName(r) : r[k]),
    });

    mount(listHost,
      h('p.muted', { style: { fontSize: '.82rem', margin: '0 0 .5rem' } },
        rows.length === data.items.length
          ? `${data.items.length} ${data.items.length === 1 ? 'part' : 'parts'}`
          : `${rows.length} of ${data.items.length} parts`),
      table([
        { key: 'id', label: picked.headerBox(), cls: 'tick', format: (_v, row) => picked.rowBox(row) },
        {
          key: 'name',
          label: sortHeader('Part', 'name', sort, onSort),
          cls: 'wrap',
          format: (v, r) => h('div',
            h('div', v, r.is_common ? h('span.pill.info', { style: { marginLeft: '.4rem' } }, 'everyday') : null),
            h('small.muted', [
              data.categories.find((c) => c.id === r.category_id)?.name ?? 'Uncategorised',
              attributeSummary(r.attributes),
            ].filter(Boolean).join(' · ')),
          ),
        },
        { key: 'unit', label: sortHeader('Unit', 'unit', sort, onSort) },
        {
          key: 'par_level',
          label: sortHeader('Restock at', 'par_level', sort, onSort),
          align: 'right',
          format: (v, r) => fmtQty(v, r.unit),
        },
        {
          key: 'opening_stock',
          label: sortHeader('Opening', 'opening_stock', sort, onSort),
          align: 'right',
          format: (v, r) => fmtQty(v, r.unit),
        },
        {
          key: 'default_unit_cost',
          label: sortHeader('Price each', 'default_unit_cost', sort, onSort),
          align: 'right',
          format: (v) => fmtMoney(v, { withSymbol: false }),
        },
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
      ], rows, {
        empty: query || categoryId || everydayOnly
          ? 'No part matches that. Clear the search or pick another category.'
          : 'No parts yet.',
      }));
  }

  paintList();
  return el;
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


// ---------------------------------------------------------------------------
// Products and their variants
// ---------------------------------------------------------------------------

/**
 * Parts that come in sizes, colours or ratings.
 *
 * The heading is the only new thing. Each variant underneath is an ordinary
 * part with its own shelf, its own restock level and its own line on a count —
 * which is the point: two 40W bulbs in different colours run out on different
 * days, and a single figure covering both tells nobody when to buy either.
 */
function productsCard(loaded, data, reload) {
  // The database cannot hold products yet. Offering the form anyway is how
  // somebody types a product and three variants and learns on the Create
  // button — so this says it before a single field is filled in, and names the
  // file rather than describing it.
  if (!loaded || loaded.ready === false) {
    return card('Products and their variants', {
      wide: true,
      note: 'Waiting on a database update',
    },
      h('div.alert.warn',
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', 'This part of the site is ready, its tables are not'),
          h('div.alert-detail',
            'Run 0018_mx_product_variants.sql from migrations/console/ against the database, and '
            + 'products will start working here. Everything else on this screen is unaffected, and '
            + 'nothing has been lost.'),
        )),
    );
  }

  const products = loaded.products ?? [];
  const name = h('input', { type: 'text', placeholder: 'e.g. LED bulb', maxlength: 100 });
  const unit = h('input', { type: 'text', value: 'pcs', maxlength: 20 });
  const category = h('select',
    h('option', { value: '' }, 'Uncategorised'),
    ...data.categories.map((c) => h('option', { value: String(c.id) }, c.name)));

  // Variants are typed as a list because that is how somebody thinks about
  // them — "we keep it in 40W warm, 40W white and 60W" — rather than one form
  // filled in three times.
  const rows = [];
  const rowHost = h('div', { style: { display: 'grid', gap: '.4rem' } });

  const addRow = (value = '', par = '') => {
    const label = h('input', { type: 'text', placeholder: 'Variant — 40W warm', maxlength: 60, value });
    const parLevel = h('input', { type: 'number', min: '0', step: '1', placeholder: 'Restock at', value: par });
    const row = { label, parLevel };
    rows.push(row);
    paint();
    return row;
  };

  const paint = () => {
    mount(rowHost, rows.map((r, i) => h('div', {
      style: { display: 'grid', gridTemplateColumns: '1fr 130px auto', gap: '.4rem' },
    },
      r.label,
      r.parLevel,
      h('button.btn-sm.btn-ghost', {
        onclick: () => { rows.splice(i, 1); paint(); },
        disabled: rows.length === 1,
      }, '✕'),
    )));
  };

  addRow();
  addRow();

  const create = async (event) => {
    const variants = rows
      .map((r) => ({ variant: r.label.value.trim(), parLevel: Number(r.parLevel.value) || 0 }))
      .filter((v) => v.variant);
    if (!name.value.trim()) { toast('Give the product a name', 'bad'); return; }
    if (!variants.length) { toast('Add at least one variant', 'bad'); return; }

    event.target.disabled = true;
    try {
      await api.mxCreateProduct({
        name: name.value.trim(),
        unit: unit.value.trim() || 'pcs',
        categoryId: category.value || null,
        variants,
      });
      toast(`${name.value.trim()} added with ${variants.length} variants`, 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const addOne = (product) => async () => {
    const label = prompt(`Another variant of ${product.name}?\n\n`
      + 'It becomes a part of its own, with its own stock and its own count line.');
    if (label === null || !label.trim()) return;
    try {
      await api.mxAddVariant(product.id, { variant: label.trim() });
      toast('Variant added', 'good');
      reload();
    } catch (err) { toast(err.message, 'bad'); }
  };

  const remove = (product) => async () => {
    if (!confirm(`Remove the product “${product.name}”?\n\n`
      + 'Only the heading goes. Its variants stay as ordinary parts, with everything '
      + 'ever recorded against them.')) return;
    try {
      // Detach first: the server refuses to remove a heading with parts under
      // it, precisely so this cannot half-happen.
      for (const v of product.variants) await api.mxSetItemProduct(v.id, { productId: null });
      await api.mxDeleteProduct(product.id);
      toast('Product removed, parts kept', 'good');
      reload();
    } catch (err) { toast(err.message, 'bad'); }
  };

  return card('Products and their variants', {
    wide: true,
    note: 'For parts kept in more than one size, colour or rating',
  },
    products.length
      ? h('div', { style: { display: 'grid', gap: '.7rem', marginBottom: '1.1rem' } },
        products.map((p) => h('div', {
          style: {
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            padding: '.6rem .7rem', background: 'var(--surface-2)',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap' } },
            h('strong', p.name),
            h('span.muted', { style: { fontSize: '.82rem' } },
              `${p.variants.length} ${p.variants.length === 1 ? 'variant' : 'variants'}`),
            h('div.btn-row', { style: { marginLeft: 'auto' } },
              h('button.btn-sm.btn-ghost', { onclick: addOne(p) }, '+ Variant'),
              h('button.btn-sm.btn-ghost', { onclick: remove(p) }, 'Remove'),
            ),
          ),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '.3rem', marginTop: '.4rem' } },
            p.variants.length
              ? p.variants.map((v) => h('span.pill', v.variant ?? v.name))
              : h('span.muted', { style: { fontSize: '.82rem' } }, 'no variants yet')),
        )))
      : null,

    h('div.field-row',
      h('label.field', h('span', 'Product name'), name),
      h('label.field', h('span', 'Unit'), unit),
      h('label.field', h('span', 'Category'), category),
    ),
    h('div', { style: { marginTop: '.7rem' } },
      h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'The variants it comes in'),
      rowHost,
      h('button.btn-sm', { style: { marginTop: '.5rem' }, onclick: () => addRow() }, '+ Another variant'),
    ),
    h('button.btn-primary', { style: { marginTop: '.8rem' }, onclick: create }, 'Create the product'),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.8rem', marginBottom: 0 } },
      'Each variant becomes a part in its own right — counted separately, restocked separately, '
      + 'and issued separately. The product is only the name they share, so removing it later '
      + 'leaves every part and everything recorded against it exactly where it is.'),
  );
}
