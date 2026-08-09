import { api } from '../api.js';
import { ensureCatalog, state } from '../app.js';
import { fmtMoney, fmtNum, h, mount, setCurrency, toast } from '../util.js';
import { card, table } from './components.js';

/** Manager admin: the ingredient catalogue, categories and property settings. */
export async function renderSetup() {
  await ensureCatalog(true);
  const host = h('div');
  const reload = async () => mount(host, await renderSetup());

  const { categories, ingredients, units, settings } = state.catalog;
  const supplierData = await api.suppliers().catch(() => ({ suppliers: [] }));

  const settingsCard = card('Property settings', {},
    settingsForm(settings, reload),
  );

  const categoryCard = card('Categories', { note: 'Order here controls the order on the kitchen entry screen' },
    table([
      { key: 'name', label: 'Category' },
      { key: 'sort_order', label: 'Order', align: 'right' },
      {
        key: 'id',
        label: '',
        format: (id, row) => h('div.btn-row',
          h('button.btn-sm', { onclick: () => editCategory(row, reload) }, 'Edit'),
          h('button.btn-sm.btn-danger', {
            onclick: async () => {
              if (!confirm(`Delete the "${row.name}" category?`)) return;
              try {
                await api.deleteCategory(id);
                toast('Category deleted', 'good');
                reload();
              } catch (err) { toast(err.message, 'bad'); }
            },
          }, 'Delete'),
        ),
      },
    ], categories, { empty: 'No categories yet.' }),
    h('div', { style: { marginTop: '.8rem' } }, categoryForm(reload)),
  );

  const ingredientRows = ingredients.map((i) => ({
    ...i,
    category_name: categories.find((c) => c.id === i.category_id)?.name ?? '—',
  }));

  const ingredientCard = card('Ingredients', {
    note: `${ingredients.filter((i) => i.active).length} active · items marked “everyday” appear on the kitchen screen by default`,
    wide: true,
  },
    table([
      { key: 'name', label: 'Ingredient', format: (v, r) => h('div', h('div', v), h('small.muted', r.category_name)) },
      { key: 'unit', label: 'Unit' },
      { key: 'step', label: 'Tap step', align: 'right', format: (v) => fmtNum(v, 2) },
      { key: 'par_level', label: 'Par level', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
      { key: 'default_unit_cost', label: 'Fallback cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      { key: 'opening_stock', label: 'Opening stock', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
      { key: 'is_core', label: 'Everyday', format: (v) => (v ? h('span.pill.good', 'yes') : h('span.pill', 'no')) },
      { key: 'active', label: 'Status', format: (v) => (v ? h('span.pill.good', 'active') : h('span.pill.warn', 'retired')) },
      {
        key: 'id',
        label: '',
        format: (id, row) => h('div.btn-row',
          h('button.btn-sm', { onclick: () => editIngredient(row, categories, units, reload) }, 'Edit'),
          h('button.btn-sm.btn-danger', {
            onclick: async () => {
              if (!confirm(`Remove "${row.name}"? If it has history it will be retired rather than deleted, so past reports stay correct.`)) return;
              try {
                const result = await api.deleteIngredient(id);
                toast(result.retired ? 'Ingredient retired — history kept' : 'Ingredient deleted', 'good');
                reload();
              } catch (err) { toast(err.message, 'bad'); }
            },
          }, 'Remove'),
        ),
      },
    ], ingredientRows, { empty: 'No ingredients yet. Add the items your kitchen buys for breakfast.' }),
    h('div', { style: { marginTop: '1rem' } },
      h('h3', { style: { marginBottom: '.6rem' } }, 'Add an ingredient'),
      ingredientForm(null, categories, units, reload)),
  );

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Setup'),
        h('div.sub', 'The catalogue the kitchen fills in each morning'),
      ),
    ),
    h('div.grid.grid-2', settingsCard, categoryCard),
    supplierCard(supplierData.suppliers || [], settings, reload),
    ingredientCard,
  );
  return host;
}

function settingsForm(settings, onSaved) {
  const propertyName = h('input', { type: 'text', value: settings.property_name || '' });
  const currency = h('input', { type: 'text', value: settings.currency || 'GHS', maxlength: 8 });
  const timezone = h('input', { type: 'text', value: settings.timezone || 'Africa/Accra' });
  const fee = h('input', {
    type: 'number', min: 0, step: '0.5',
    value: settings.outsider_fee ?? settings.default_outsider_fee ?? 0,
  });
  const fillUsual = h('select',
    h('option', { value: '1', selected: settings.allow_fill_usual !== '0' }, 'Allowed'),
    h('option', { value: '0', selected: settings.allow_fill_usual === '0' }, 'Hidden from cooks'),
  );
  const requireComplete = h('select',
    h('option', { value: '1', selected: settings.require_complete_entry !== '0' },
      'Every everyday item must have a figure'),
    h('option', { value: '0', selected: settings.require_complete_entry === '0' },
      'Allow partly filled sheets'),
  );
  const restrictCooks = h('select',
    h('option', { value: '0', selected: settings.restrict_cooks_to_everyday !== '1' },
      'Cooks can open the full item list'),
    h('option', { value: '1', selected: settings.restrict_cooks_to_everyday === '1' },
      'Cooks see everyday items only'),
  );
  const recoveryPin = h('select',
    h('option', { value: '1', selected: settings.allow_recovery_pin !== '0' },
      'Emergency recovery PIN enabled'),
    h('option', { value: '0', selected: settings.allow_recovery_pin === '0' },
      'Disabled — administrators must use email & password'),
  );
  const requireApproval = h('select',
    h('option', { value: '1', selected: settings.require_resubmit_approval !== '0' },
      'A correction waits for approval'),
    h('option', { value: '0', selected: settings.require_resubmit_approval === '0' },
      'A correction overwrites straight away'),
  );
  const supplierMode = h('select',
    h('option', { value: 'select', selected: (settings.supplier_mode || 'select') === 'select' },
      'Choose from the supplier list'),
    h('option', { value: 'free', selected: settings.supplier_mode === 'free' },
      'Type any supplier name'),
    h('option', { value: 'off', selected: settings.supplier_mode === 'off' },
      'Do not ask for a supplier'),
  );

  return h('div',
    h('label.field', h('span', 'Property / unit name'), propertyName),
    h('div.field-row',
      h('label.field', h('span', 'Currency code'), currency),
      h('label.field', h('span', 'Timezone'), timezone),
    ),
    h('div.field-row',
      h('label.field', h('span', 'Fee per outside guest'), fee),
      h('label.field', h('span', '“Fill usual” button'), fillUsual),
      h('label.field', h('span', 'Supplier on deliveries'), supplierMode),
      h('label.field', h('span', 'Item list for cooks'), restrictCooks),
    ),
    h('div.field-row',
      h('label.field', h('span', 'Completeness of a submission'), requireComplete),
      h('label.field', h('span', 'Re-submitting a recorded day'), requireApproval),
      h('label.field', h('span', 'Emergency access'), recoveryPin),
    ),
    h('p.muted', { style: { fontSize: '.8rem' } },
      'The emergency recovery PIN is the MANAGER_PIN set on the server. It reaches everything, so '
      + 'switch it off once you have a working administrator account — but only once you are sure '
      + 'you can sign in with your email and password, because it is what rescues you otherwise.'),
    h('p.muted', { style: { fontSize: '.8rem' } },
      'The fee is fixed here rather than typed each morning, so the kitchen cannot change what '
      + 'outside guests are charged. Days already recorded keep the fee that applied then.'),
    h('p.muted', { style: { fontSize: '.8rem' } },
      '“Fill usual” fills every habitual item in one tap. Hide it if you would rather each '
      + 'quantity were entered deliberately — the per-item suggestions stay either way.'),
    h('p.muted', { style: { fontSize: '.8rem' } },
      'Restricting cooks to everyday items hides the “All items” switch from anyone whose only job '
      + 'here is the entry screen, so their morning is a short fixed list. Anything already recorded '
      + 'stays visible, and managers keep the full list.'),
    h('p.muted', { style: { fontSize: '.8rem' } },
      'Requiring completeness means a cook must put a number against every everyday item before the '
      + 'day can be submitted — 0 is a perfectly good answer, and they are asked to confirm any zeros. '
      + 'A blank is what causes trouble, because it looks the same as “we forgot”.'),
    h('p.muted', { style: { fontSize: '.8rem' } },
      'The timezone decides which calendar day a morning belongs to. Use an IANA name such as Africa/Accra.'),
    h('button.btn-primary', {
      onclick: async (event) => {
        event.target.disabled = true;
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
          onSaved();
        } catch (err) {
          toast(err.message, 'bad');
          event.target.disabled = false;
        }
      },
    }, 'Save settings'),
  );
}

function supplierCard(suppliers, settings, onSaved) {
  const mode = settings.supplier_mode || 'select';

  const name = h('input', { type: 'text', placeholder: 'Supplier name' });
  const contact = h('input', { type: 'text', placeholder: 'Contact person' });
  const phone = h('input', { type: 'text', placeholder: 'Phone' });

  const add = async (event) => {
    if (!name.value.trim()) { toast('Enter a supplier name', 'bad'); return; }
    event.target.disabled = true;
    try {
      await api.createSupplier({
        name: name.value.trim(),
        contact: contact.value.trim() || null,
        phone: phone.value.trim() || null,
      });
      toast('Supplier added', 'good');
      onSaved();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  return card('Suppliers', {
    note: mode === 'select'
      ? 'Deliveries are recorded against this list'
      : mode === 'free'
        ? 'Supplier names are typed freely — this list is not enforced'
        : 'Suppliers are not being recorded on deliveries',
    wide: true,
  },
    table([
      { key: 'name', label: 'Supplier' },
      { key: 'contact', label: 'Contact', format: (v) => v || h('span.muted', '—') },
      { key: 'phone', label: 'Phone', format: (v) => v || h('span.muted', '—') },
      { key: 'purchase_count', label: 'Deliveries', align: 'right', format: (v) => fmtNum(v, 0) },
      { key: 'active', label: 'Status', format: (v) => (v ? h('span.pill.good', 'active') : h('span.pill.warn', 'retired')) },
      {
        key: 'id',
        label: '',
        format: (id, row) => h('div.btn-row',
          h('button.btn-sm', {
            onclick: () => {
              const next = prompt('Supplier name', row.name);
              if (next == null || !next.trim()) return;
              api.updateSupplier(id, { ...row, name: next.trim(), active: Boolean(row.active) })
                .then(() => { toast('Supplier updated', 'good'); onSaved(); })
                .catch((err) => toast(err.message, 'bad'));
            },
          }, 'Rename'),
          h('button.btn-sm.btn-danger', {
            onclick: async () => {
              if (!confirm(`Remove ${row.name}? Past deliveries keep their supplier name.`)) return;
              try {
                const result = await api.deleteSupplier(id);
                toast(result.retired ? 'Supplier retired — history kept' : 'Supplier removed', 'good');
                onSaved();
              } catch (err) { toast(err.message, 'bad'); }
            },
          }, 'Remove'),
        ),
      },
    ], suppliers, { empty: 'No suppliers yet. Add the places you buy from.' }),

    h('div', { style: { marginTop: '.9rem' } },
      h('h3', { style: { marginBottom: '.5rem' } }, 'Add a supplier'),
      h('div.field-row',
        h('label.field', h('span', 'Name'), name),
        h('label.field', h('span', 'Contact person'), contact),
        h('label.field', h('span', 'Phone'), phone),
      ),
      h('button.btn-primary', { onclick: add }, 'Add supplier'),
    ),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
      'Renaming a supplier updates its past deliveries too, so the reports stay as one supplier '
      + 'rather than splitting in two. A supplier with history is retired rather than deleted.'),
  );
}

function categoryForm(onSaved) {
  const name = h('input', { type: 'text', placeholder: 'New category name' });
  const order = h('input', { type: 'number', value: 100, step: 10 });
  return h('div', { style: { display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: '.4rem' } },
    name, order,
    h('button.btn-sm.btn-primary', {
      onclick: async (event) => {
        if (!name.value.trim()) return;
        event.target.disabled = true;
        try {
          await api.createCategory({ name: name.value.trim(), sort_order: Number(order.value) || 100 });
          toast('Category added', 'good');
          onSaved();
        } catch (err) {
          toast(err.message, 'bad');
          event.target.disabled = false;
        }
      },
    }, 'Add'),
  );
}

function editCategory(row, onSaved) {
  const name = prompt('Category name', row.name);
  if (name == null) return;
  api.updateCategory(row.id, { name, sort_order: row.sort_order })
    .then(() => { toast('Category updated', 'good'); onSaved(); })
    .catch((err) => toast(err.message, 'bad'));
}

function ingredientForm(existing, categories, units, onSaved) {
  // Shown in the form rather than as a toast: when this form is opened as a
  // modal, a toast would be hidden behind it.
  const problem = h('div.form-error.hidden');
  const showProblem = (message) => {
    problem.textContent = message;
    problem.classList.remove('hidden');
    problem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const value = existing || {
    category_id: categories[0]?.id, name: '', unit: 'kg', step: 1,
    par_level: 0, default_unit_cost: 0, opening_stock: 0, is_core: 1, active: 1, sort_order: 100,
  };

  const name = h('input', { type: 'text', value: value.name, placeholder: 'e.g. Sliced bread' });
  const category = h('select', categories.map((c) =>
    h('option', { value: c.id, selected: c.id === value.category_id }, c.name)));
  const unit = h('select', units.map((u) =>
    h('option', { value: u, selected: u === value.unit }, u)));
  const step = h('input', { type: 'number', min: '0.01', step: '0.01', value: value.step });
  const par = h('input', { type: 'number', min: 0, step: '0.1', value: value.par_level });
  const cost = h('input', { type: 'number', min: 0, step: '0.01', value: value.default_unit_cost });
  const opening = h('input', { type: 'number', step: '0.1', value: value.opening_stock });
  const isCore = h('select',
    h('option', { value: '1', selected: !!value.is_core }, 'Everyday item'),
    h('option', { value: '0', selected: !value.is_core }, 'Occasional'));
  const active = h('select',
    h('option', { value: '1', selected: !!value.active }, 'Active'),
    h('option', { value: '0', selected: !value.active }, 'Retired'));
  const order = h('input', { type: 'number', value: value.sort_order, step: 10 });

  const submit = async (event) => {
    problem.classList.add('hidden');
    if (!name.value.trim()) {
      showProblem('Give the ingredient a name.');
      return;
    }
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
      active: active.value === '1',
      sort_order: Number(order.value) || 100,
    };
    try {
      if (existing) await api.updateIngredient(existing.id, body);
      else await api.createIngredient(body);
      toast(existing ? 'Ingredient updated' : 'Ingredient added', 'good');
      onSaved();
    } catch (err) {
      showProblem(err.message);
      event.target.disabled = false;
    }
  };

  return h('div',
    h('div.field-row',
      h('label.field', h('span', 'Name'), name),
      h('label.field', h('span', 'Category'), category),
      h('label.field', h('span', 'Unit'), unit),
      h('label.field', h('span', 'Tap step'), step),
      h('label.field', h('span', 'Par level'), par),
      h('label.field', h('span', 'Fallback unit cost'), cost),
      h('label.field', h('span', 'Opening stock'), opening),
      h('label.field', h('span', 'Entry screen'), isCore),
      h('label.field', h('span', 'Status'), active),
      h('label.field', h('span', 'Sort order'), order),
    ),
    h('p.muted', { style: { fontSize: '.8rem' } },
      'Tap step is how much one press of + or − moves the quantity — set it to how the kitchen actually measures (6 for eggs, 0.5 for a half kilo). Fallback unit cost is only used until the first delivery of that item is recorded.'),
    problem,
    h('button.btn-primary', { onclick: submit }, existing ? 'Save changes' : 'Add ingredient'),
  );
}

/** Simple modal editor — a dialog keeps the long table from jumping about. */
function editIngredient(row, categories, units, onSaved) {
  const dialog = h('dialog', {
    style: {
      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      background: 'var(--surface)', color: 'var(--text)', maxWidth: '760px', width: '92vw', padding: '1.2rem',
    },
  },
    h('div.card-head', h('h2', `Edit ${row.name}`), h('button.btn-sm.btn-ghost', { onclick: () => dialog.close() }, '✕')),
    ingredientForm(row, categories, units, () => { dialog.close(); onSaved(); }),
  );
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}
