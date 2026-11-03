import { api } from '../api.js';
import { ensureCatalog, state } from '../app.js';
import { fmtMoney, fmtNum, h, mount, setCurrency, toast } from '../util.js';
import {
  card, hint, modal, more, pageTabs, sheet, table,
} from './components.js';
import { odooSetupCard } from './odoo-import.js';

/**
 * Setup: what the kitchen fills in, who it buys from, and how the morning
 * works. One job per tab, so each is short enough to read.
 */
export async function renderSetup() {
  await ensureCatalog(true);
  const host = h('div');
  const reload = async () => mount(host, await renderSetup());

  const { categories, ingredients, units, settings } = state.catalog;
  const supplierData = await api.suppliers().catch(() => ({ suppliers: [] }));
  const suppliers = supplierData.suppliers || [];
  const hasStore = 'deliveries_to' in settings;

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Setup'),
        h('div.sub', 'What the kitchen fills in, and how the morning works'),
      ),
    ),
    pageTabs('setup', [
      {
        id: 'items',
        label: 'Items',
        count: ingredients.filter((i) => i.active).length,
        render: () => itemsTab(ingredients, categories, units, reload),
      },
      { id: 'categories', label: 'Categories', count: categories.length, render: () => categoriesTab(categories, reload) },
      {
        id: 'suppliers',
        label: 'Suppliers',
        count: suppliers.filter((s) => s.active).length,
        render: () => suppliersTab(suppliers, settings, reload),
      },
      hasStore ? { id: 'storeroom', label: 'Storeroom', render: () => storeroomTab(settings, reload) } : null,
      { id: 'settings', label: 'Settings', render: () => settingsTab(settings, reload) },
      { id: 'odoo', label: 'Odoo', render: () => odooSetupCard(settings, reload) },
    ].filter(Boolean)),
  );
  return host;
}

// ------------------------------------------------------------------ items --

function itemsTab(ingredients, categories, units, reload) {
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const search = h('input', { type: 'search', placeholder: 'Find an item…', 'aria-label': 'Find an item' });
  const category = h('select', { 'aria-label': 'Category' },
    h('option', { value: '' }, 'All categories'),
    categories.map((c) => h('option', { value: c.id }, c.name)));
  const status = h('select', { 'aria-label': 'Which items' },
    h('option', { value: 'active' }, 'In use'),
    h('option', { value: 'retired' }, 'Retired'),
    h('option', { value: 'all' }, 'All items'));
  const add = h('button.btn-primary', { onclick: () => itemDialog(null, categories, units, reload) }, '+ Add item');

  const count = h('p.list-count');
  const list = h('div');

  const tags = (i) => {
    const out = [];
    if (!i.is_core) out.push(h('span.pill', 'occasional'));
    if (i.is_produced) out.push(h('span.pill.info', i.is_bistro ? 'bakery · bistro' : 'bakery'));
    if (i.kind === 'supply') out.push(h('span.pill', 'supply'));
    if (!i.active) out.push(h('span.pill.warn', 'retired'));
    return out.length ? h('span.tag-row', out) : null;
  };

  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const rows = ingredients
      .filter((i) => (status.value === 'all' ? true : status.value === 'active' ? i.active : !i.active))
      .filter((i) => !category.value || String(i.category_id) === category.value)
      .filter((i) => !q || i.name.toLowerCase().includes(q))
      .map((i) => ({ ...i, category_name: categoryName.get(i.category_id) ?? '—' }));
    count.textContent = `${rows.length} ${rows.length === 1 ? 'item' : 'items'}`;
    mount(list, table([
      {
        key: 'name',
        label: 'Item',
        format: (v, r) => h('div',
          h('span.item-name', v), tags(r),
          h('div', h('small.muted', r.category_name, h('span.phone-only', ` · par ${fmtNum(r.par_level, 2)} ${r.unit}`)))),
      },
      { key: 'unit', label: 'Unit', cls: 'phone-hide' },
      { key: 'par_level', label: 'Par level', align: 'right', cls: 'phone-hide', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
      { key: 'default_unit_cost', label: 'Unit cost', align: 'right', cls: 'phone-hide', format: (v) => fmtMoney(v, { withSymbol: false }) },
      {
        key: 'id',
        label: '',
        align: 'right',
        format: (id, row) => h('button.btn-sm', { onclick: () => itemDialog(row, categories, units, reload) }, 'Edit'),
      },
    ], rows, {
      empty: ingredients.length ? 'Nothing matches.' : 'No items yet. Add what the kitchen buys for breakfast.',
    }));
  };
  search.addEventListener('input', paint);
  category.addEventListener('change', paint);
  status.addEventListener('change', paint);
  paint();

  return card(null, {},
    h('div.list-tools', search, category, status, add),
    count,
    list,
  );
}

/** Add or change one item. Everything about it in one place, grouped. */
function itemDialog(existing, categories, units, onSaved) {
  const problem = h('div.form-error.hidden');
  const showProblem = (message) => {
    problem.textContent = message;
    problem.classList.remove('hidden');
    problem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const value = existing || {
    category_id: categories[0]?.id, name: '', unit: 'kg', step: 1,
    par_level: 0, default_unit_cost: 0, opening_stock: 0, is_core: 1, is_produced: 0, is_bistro: 0,
    active: 1, sort_order: 100,
  };
  const yesNo = (on, yes, no) => [
    h('option', { value: '1', selected: Boolean(on) }, yes),
    h('option', { value: '0', selected: !on }, no),
  ];

  const name = h('input', { type: 'text', value: value.name, placeholder: 'e.g. Sliced bread' });
  const category = h('select', categories.map((c) => h('option', { value: c.id, selected: c.id === value.category_id }, c.name)));
  const unit = h('select', units.map((u) => h('option', { value: u, selected: u === value.unit }, u)));
  const active = h('select', yesNo(value.active, 'In use', 'Retired'));
  const isCore = h('select', yesNo(value.is_core, 'Everyday item', 'Occasional'));
  const step = h('input', { type: 'number', min: '0.01', step: '0.01', value: value.step });
  const order = h('input', { type: 'number', value: value.sort_order, step: 10 });
  const par = h('input', { type: 'number', min: 0, step: '0.1', value: value.par_level });
  const opening = h('input', { type: 'number', step: '0.1', value: value.opening_stock });
  const cost = h('input', { type: 'number', min: 0, step: '0.01', value: value.default_unit_cost });
  const isProduced = h('select', yesNo(value.is_produced, 'Made in our bakery', 'Bought in'));
  const isBistro = h('select', yesNo(value.is_bistro, 'Also baked for the bistro', 'Breakfast only'));

  // The storeroom's questions exist only once its database update has run.
  const hasStore = 'deliveries_to' in (state.settings || {});
  const kind = h('select',
    h('option', { value: 'food', selected: (value.kind ?? 'food') !== 'supply' }, 'Breakfast food'),
    h('option', { value: 'supply', selected: value.kind === 'supply' }, 'Supply (tissue, soap…)'));
  const requestable = h('select', yesNo(value.requestable !== 0, 'Can be asked for', 'Not kept there'));
  const storeOpening = h('input', { type: 'number', min: 0, step: '0.1', value: value.store_opening ?? 0 });
  const storePar = h('input', { type: 'number', min: 0, step: '0.1', value: value.store_par ?? 0 });

  const field = (label, input, note) => h('label.field', h('span', label), input, note ? hint(note) : null);

  let dialog = null;
  const save = async (event) => {
    problem.classList.add('hidden');
    if (!name.value.trim()) { showProblem('Give the item a name.'); return; }
    event.target.disabled = true;
    const body = {
      category_id: Number(category.value),
      name: name.value.trim(),
      unit: unit.value,
      step: Number(step.value) || 1,
      par_level: Number(par.value) || 0,
      default_unit_cost: Number(cost.value) || 0,
      opening_stock: Number(opening.value) || 0,
      is_core: isCore.value === '1',
      is_produced: isProduced.value === '1',
      is_bistro: isBistro.value === '1',
      active: active.value === '1',
      sort_order: Number(order.value) || 100,
      ...(hasStore ? {
        kind: kind.value,
        requestable: requestable.value === '1',
        store_opening: Number(storeOpening.value) || 0,
        store_par: Number(storePar.value) || 0,
      } : {}),
    };
    try {
      if (existing) await api.updateIngredient(existing.id, body);
      else await api.createIngredient(body);
      toast(existing ? 'Item saved' : 'Item added', 'good');
      dialog.close();
      onSaved();
    } catch (err) {
      showProblem(err.message);
      event.target.disabled = false;
    }
  };

  const remove = existing ? h('button.btn-danger', {
    onclick: async () => {
      if (!confirm(`Remove "${existing.name}"? If it has history it is retired instead, so past reports stay correct.`)) return;
      try {
        const result = await api.deleteIngredient(existing.id);
        toast(result.retired ? 'Item retired, history kept' : 'Item removed', 'good');
        dialog.close();
        onSaved();
      } catch (err) { showProblem(err.message); }
    },
  }, 'Remove') : null;

  dialog = sheet(existing ? existing.name : 'Add an item',
    h('h3.form-section', 'The item'),
    h('div.field-row',
      field('Name', name),
      field('Category', category),
      field('Unit', unit),
      field('Status', active)),

    h('h3.form-section', 'On the morning sheet'),
    h('div.field-row',
      field('Shown', isCore, 'Everyday items are on the sheet by default'),
      field('Tap step', step, 'How much one tap of + or − adds'),
      field('Sort order', order, 'Lower comes first')),

    h('h3.form-section', 'Stock and cost'),
    h('div.field-row',
      field('Par level', par, 'Below this it shows as low'),
      field('Opening stock', opening, 'On hand when tracking began'),
      field('Unit cost', cost, 'Used until the first delivery')),

    h('h3.form-section', 'Bakery'),
    h('div.field-row',
      field('Where it comes from', isProduced, 'Baked items go on the bakery’s form'),
      field('Baked for', isBistro)),

    hasStore ? h('h3.form-section', 'Storeroom') : null,
    hasStore ? h('div.field-row',
      field('What it is', kind, 'Supplies never count in breakfast cost'),
      field('Storeroom', requestable),
      field('In the storeroom at the start', storeOpening),
      field('Storeroom par level', storePar)) : null,

    problem,
    h('div.sheet-actions',
      remove,
      h('button', { onclick: () => dialog.close() }, 'Cancel'),
      h('button.btn-primary', { onclick: save }, existing ? 'Save' : 'Add item')),
  );
  setTimeout(() => { if (!existing) name.focus(); }, 0);
}

// ------------------------------------------------------------- categories --

function categoriesTab(categories, reload) {
  const name = h('input', { type: 'text', placeholder: 'New category', 'aria-label': 'New category name' });
  const order = h('input', { type: 'number', value: 100, step: 10, 'aria-label': 'Order', style: { maxWidth: '110px' } });
  const add = h('button.btn-primary', {
    onclick: async (event) => {
      if (!name.value.trim()) { name.focus(); return; }
      event.target.disabled = true;
      try {
        await api.createCategory({ name: name.value.trim(), sort_order: Number(order.value) || 100 });
        toast('Category added', 'good');
        reload();
      } catch (err) {
        toast(err.message, 'bad');
        event.target.disabled = false;
      }
    },
  }, 'Add');

  const edit = (row) => {
    const n = h('input', { type: 'text', value: row.name });
    const o = h('input', { type: 'number', value: row.sort_order, step: 10 });
    modal(`Edit ${row.name}`, [
      h('label.field', h('span', 'Name'), n),
      h('label.field', h('span', 'Order'), o, hint('Lower comes first on the morning sheet')),
    ], async (event, dialog) => {
      event.target.disabled = true;
      try {
        await api.updateCategory(row.id, { name: n.value.trim() || row.name, sort_order: Number(o.value) || 0 });
        dialog.close();
        toast('Category saved', 'good');
        reload();
      } catch (err) {
        toast(err.message, 'bad');
        event.target.disabled = false;
      }
    });
  };

  return card(null, {},
    h('p.muted', { style: { marginTop: 0, fontSize: '.86rem' } }, 'The order here is the order on the morning sheet.'),
    table([
      { key: 'name', label: 'Category', format: (v) => h('span.item-name', v) },
      { key: 'sort_order', label: 'Order', align: 'right' },
      {
        key: 'id',
        label: '',
        align: 'right',
        format: (id, row) => h('div.btn-row', { style: { justifyContent: 'flex-end' } },
          h('button.row-action', { onclick: () => edit(row) }, 'Edit'),
          h('button.row-action.danger', {
            onclick: async () => {
              if (!confirm(`Delete the "${row.name}" category?`)) return;
              try {
                await api.deleteCategory(id);
                toast('Category deleted', 'good');
                reload();
              } catch (err) { toast(err.message, 'bad'); }
            },
          }, 'Delete')),
      },
    ], categories, { empty: 'No categories yet.' }),
    h('div.list-tools', { style: { marginTop: '1rem', marginBottom: 0 } }, name, order, add),
  );
}

// -------------------------------------------------------------- suppliers --

function suppliersTab(suppliers, settings, reload) {
  const mode = settings.supplier_mode || 'suggest';
  const note = {
    suggest: 'Deliveries pick a supplier from this list, or type a new one.',
    select: 'Deliveries can only use a supplier on this list.',
    free: 'Supplier names are typed freely; this list is a reference.',
    off: 'Deliveries are not asking for a supplier (Settings).',
  }[mode];

  const addDialog = () => {
    const name = h('input', { type: 'text', placeholder: 'Supplier name' });
    const contact = h('input', { type: 'text', placeholder: 'Contact person' });
    const phone = h('input', { type: 'tel', placeholder: 'Phone' });
    modal('Add a supplier', [
      h('label.field', h('span', 'Name'), name),
      h('div.field-row',
        h('label.field', h('span', 'Contact person'), contact),
        h('label.field', h('span', 'Phone'), phone)),
    ], async (event, dialog) => {
      if (!name.value.trim()) { name.focus(); return; }
      event.target.disabled = true;
      try {
        await api.createSupplier({ name: name.value.trim(), contact: contact.value.trim() || null, phone: phone.value.trim() || null });
        dialog.close();
        toast('Supplier added', 'good');
        reload();
      } catch (err) {
        toast(err.message, 'bad');
        event.target.disabled = false;
      }
    }, { saveLabel: 'Add supplier' });
    setTimeout(() => name.focus(), 0);
  };

  return card(null, {},
    h('div.list-tools',
      h('p.muted', { style: { margin: 0, fontSize: '.86rem', flex: '1 1 260px' } }, note),
      h('button.btn-primary', { onclick: addDialog }, '+ Add supplier')),
    table([
      {
        key: 'name',
        label: 'Supplier',
        format: (v, row) => h('div',
          h('span.item-name', row.key_supplier ? `★ ${v}` : v),
          row.active ? null : h('span.tag-row', h('span.pill.warn', 'retired')),
          row.contact || row.phone
            ? h('div', h('small.muted', [row.contact, row.phone].filter(Boolean).join(' · ')))
            : null),
      },
      { key: 'odoo_id', label: 'From', format: (v, row) => (v ? h('span.pill', row.grp ? `Odoo · ${row.grp}` : 'Odoo') : h('span.muted', 'Added here')) },
      { key: 'purchase_count', label: 'Deliveries', align: 'right', format: (v) => fmtNum(v, 0) },
      {
        key: 'id',
        label: '',
        align: 'right',
        format: (id, row) => h('div.btn-row', { style: { justifyContent: 'flex-end' } },
          h('button.row-action', {
            onclick: () => {
              const next = prompt('Supplier name', row.name);
              if (next == null || !next.trim()) return;
              api.updateSupplier(id, { ...row, name: next.trim(), active: Boolean(row.active) })
                .then(() => { toast('Supplier renamed', 'good'); reload(); })
                .catch((err) => toast(err.message, 'bad'));
            },
          }, 'Rename'),
          h('button.row-action.danger', {
            onclick: async () => {
              if (!confirm(`Remove ${row.name}? Past deliveries keep their supplier name.`)) return;
              try {
                const result = await api.deleteSupplier(id);
                toast(result.retired ? 'Supplier retired, history kept' : 'Supplier removed', 'good');
                reload();
              } catch (err) { toast(err.message, 'bad'); }
            },
          }, 'Remove')),
      },
    ], suppliers, { empty: 'No suppliers yet.' }),
    more('How renaming and removing work',
      h('p', 'Renaming a supplier renames its past deliveries too, so reports keep it as one supplier.'),
      h('p', 'A supplier with deliveries is retired rather than deleted. Suppliers marked Odoo come from '
        + 'Insight (Buying › Suppliers); ★ marks a key supplier.')),
  );
}

// -------------------------------------------------------------- storeroom --

function storeroomTab(settings, reload) {
  const where = h('select',
    h('option', { value: 'store', selected: settings.deliveries_to !== 'kitchen' }, 'Into the storeroom'),
    h('option', { value: 'kitchen', selected: settings.deliveries_to === 'kitchen' }, 'Straight to the kitchen'));
  const departments = h('textarea', {
    rows: 4,
    value: String(settings.store_departments || 'Kitchen'),
    placeholder: 'Kitchen\nRestaurant bar\nHousekeeping',
  });
  const save = h('button.btn-primary', {
    onclick: async () => {
      save.disabled = true;
      try {
        const result = await api.updateSettings({ deliveries_to: where.value, store_departments: departments.value });
        state.settings = result.settings;
        toast('Storeroom saved', 'good');
        reload();
      } catch (err) {
        toast(err.message, 'bad');
        save.disabled = false;
      }
    },
  }, 'Save');

  return card(null, {},
    h('div.field-row',
      h('label.field', h('span', 'Deliveries go'), where,
        hint('Purchases can still send one straight to the kitchen')),
      h('label.field', { style: { gridColumn: '1 / -1' } }, h('span', 'Departments that can ask, one per line'), departments,
        hint('The first one is the breakfast kitchen'))),
    more('What the first department means',
      h('p', 'What the storeroom issues to the first department becomes breakfast stock, valued at the price last '
        + 'paid. What it issues to the others has left the storeroom and is theirs.')),
    h('div.btn-row', { style: { marginTop: '1rem' } }, save),
  );
}

// --------------------------------------------------------------- settings --

function settingsTab(settings, reload) {
  const opt = (value, label, on) => h('option', { value, selected: on }, label);
  const propertyName = h('input', { type: 'text', value: settings.property_name || '' });
  const currency = h('input', { type: 'text', value: settings.currency || 'GHS', maxlength: 8 });
  const timezone = h('input', { type: 'text', value: settings.timezone || 'Africa/Accra' });
  const fee = h('input', { type: 'number', min: 0, step: '0.5', value: settings.outsider_fee ?? settings.default_outsider_fee ?? 0 });
  const fillUsual = h('select',
    opt('1', 'Shown', settings.allow_fill_usual !== '0'),
    opt('0', 'Hidden from cooks', settings.allow_fill_usual === '0'));
  const restrictCooks = h('select',
    opt('0', 'The full item list', settings.restrict_cooks_to_everyday !== '1'),
    opt('1', 'Everyday items only', settings.restrict_cooks_to_everyday === '1'));
  const requireComplete = h('select',
    opt('1', 'Every item needs a figure', settings.require_complete_entry !== '0'),
    opt('0', 'Partly filled is fine', settings.require_complete_entry === '0'));
  const requireApproval = h('select',
    opt('1', 'Waits for approval', settings.require_resubmit_approval !== '0'),
    opt('0', 'Replaces it straight away', settings.require_resubmit_approval === '0'));
  const mode = settings.supplier_mode || 'suggest';
  const supplierMode = h('select',
    opt('suggest', 'Pick from the list, or type a new one', mode === 'suggest'),
    opt('select', 'Only suppliers on the list', mode === 'select'),
    opt('free', 'Type any name', mode === 'free'),
    opt('off', 'Don’t ask', mode === 'off'));
  const recoveryPin = h('select',
    opt('1', 'On', settings.allow_recovery_pin !== '0'),
    opt('0', 'Off: administrators use email and password', settings.allow_recovery_pin === '0'));

  const field = (label, input, note) => h('label.field', h('span', label), input, note ? hint(note) : null);

  const save = h('button.btn-primary', {
    onclick: async () => {
      save.disabled = true;
      try {
        const result = await api.updateSettings({
          property_name: propertyName.value,
          currency: currency.value.toUpperCase(),
          timezone: timezone.value,
          outsider_fee: fee.value,
          allow_fill_usual: fillUsual.value === '1',
          supplier_mode: supplierMode.value,
          restrict_cooks_to_everyday: restrictCooks.value === '1',
          require_complete_entry: requireComplete.value === '1',
          require_resubmit_approval: requireApproval.value === '1',
          allow_recovery_pin: recoveryPin.value === '1',
        });
        setCurrency(result.settings.currency);
        state.settings = result.settings;
        toast('Settings saved', 'good');
        reload();
      } catch (err) {
        toast(err.message, 'bad');
        save.disabled = false;
      }
    },
  }, 'Save settings');

  return card(null, {},
    h('h3.form-section', 'The property'),
    h('div.field-row',
      field('Name', propertyName),
      field('Currency', currency),
      field('Timezone', timezone, 'Decides which day a morning belongs to'),
      field('Fee per outside guest', fee, 'Recorded days keep the fee they had')),

    h('h3.form-section', 'The morning sheet'),
    h('div.field-row',
      field('Cooks see', restrictCooks),
      field('“Fill usual” button', fillUsual, 'Fills every habitual item in one tap'),
      field('Before submitting', requireComplete, '0 is an answer; blank is not'),
      field('Correcting a recorded day', requireApproval)),

    h('h3.form-section', 'Deliveries and access'),
    h('div.field-row',
      field('Supplier on a delivery', supplierMode),
      field('Emergency recovery PIN', recoveryPin, 'The MANAGER_PIN on the server')),
    more('About the emergency recovery PIN',
      h('p', 'It reaches everything. Switch it off once you can sign in with your own email and password, '
        + 'and not before: it is what rescues you if that fails.')),

    h('div.btn-row', { style: { marginTop: '1.1rem' } }, save),
  );
}
