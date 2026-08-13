import { api } from '../api.js';
import { attributeSummary, fmtMoney, fmtNum, h, mount, parseAttributes, toast } from '../util.js';
import { card, table } from './components.js';

/**
 * The product list, and what everything is priced at.
 *
 * A craft shop's list is short and changes constantly — pieces arrive one at a
 * time from whoever made them — so this is built for adding one thing quickly
 * rather than for loading a spreadsheet.
 *
 * Cost and price sit side by side on purpose, with the margin worked out
 * between them as you type. A price set without looking at the cost is how a
 * shop ends up selling below what it paid.
 */
export async function renderShopSetup() {
  const data = await api.shopBootstrap();
  const host = h('div');
  const reload = async () => mount(host, await renderShopSetup());

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Craft shop setup'),
        h('div.sub', 'What you sell, what it cost, and what you charge'),
      ),
    ),
    settingsCard(data, reload),
    addProductCard(data, reload),
    productsCard(data, reload),
  );

  return host;
}

function settingsCard(data, reload) {
  const name = h('input', { type: 'text', value: data.settings.shopName, maxlength: 60 });
  const cover = h('input', {
    type: 'number', min: '1', max: '365', value: String(data.settings.lowCoverDays),
  });

  const save = async (event) => {
    event.target.disabled = true;
    try {
      await api.shopUpdateSettings({
        shopName: name.value.trim(),
        lowCoverDays: Number(cover.value),
      });
      toast('Saved', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  return card('The shop', { wide: true },
    h('div.field-row',
      h('label.field', h('span', 'What the shop is called'), name),
      h('label.field', h('span', 'Warn when stock has fewer than this many days left'), cover),
    ),
    h('button.btn-primary', { style: { marginTop: '.7rem' }, onclick: save }, 'Save'),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.8rem', marginBottom: 0 } },
      'Craft stock turns over slowly, so this is longer than the kitchen\'s. Three weeks means '
      + 'a piece selling one a month will not be flagged the moment two are left.'),
  );
}

/** Cost, price and the margin between them, worked out live. */
function priceFields(initial = {}) {
  const cost = h('input', {
    type: 'number', min: '0', step: '0.01', placeholder: '0.00',
    value: initial.unitCost != null ? String(initial.unitCost) : '',
  });
  const price = h('input', {
    type: 'number', min: '0', step: '0.01', placeholder: '0.00',
    value: initial.sellPrice != null ? String(initial.sellPrice) : '',
  });
  const readout = h('div.muted', { style: { fontSize: '.82rem', minHeight: '1.3em' } });

  const recalc = () => {
    const c = Number(cost.value);
    const p = Number(price.value);
    if (!Number.isFinite(p) || p <= 0) {
      readout.textContent = 'Set a selling price — the till will not sell anything priced at zero.';
      readout.style.color = '';
      return;
    }
    if (!Number.isFinite(c) || c <= 0) {
      readout.textContent = 'No cost recorded yet, so margin cannot be worked out.';
      readout.style.color = '';
      return;
    }
    const margin = p - c;
    const pct = (margin / p) * 100;
    readout.textContent = `${fmtMoney(margin)} a piece · ${fmtNum(pct, 0)}% margin`;
    readout.style.color = margin < 0 ? 'var(--bad)' : pct < 20 ? 'var(--warn)' : 'var(--good)';
  };

  cost.oninput = recalc;
  price.oninput = recalc;
  recalc();

  return { cost, price, readout, recalc };
}

/**
 * Details: size, colour, artist, material — whatever this shop actually uses.
 *
 * Free-form rather than fixed columns, because no two craft shops sort their
 * stock the same way and a fixed "size" field is wrong for a painting.
 */
function detailEditor(initial, existingItems) {
  const rows = [];
  const listHost = h('div', { style: { display: 'grid', gap: '.4rem' } });

  // Labels already in use, so the second bead necklace is filed the same way as
  // the first rather than under "Colour " with a trailing space.
  const known = [...new Set(existingItems.flatMap(
    (i) => Object.keys(parseAttributes(i.attributes) ?? {}),
  ))];

  const draw = () => {
    mount(listHost, rows.length
      ? rows.map((row, index) => h('div', {
        style: { display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '.4rem' },
      },
        row.label, row.value,
        h('button.btn-sm.btn-ghost', {
          onclick: () => { rows.splice(index, 1); draw(); },
        }, '✕'),
      ))
      : h('p.muted', { style: { fontSize: '.82rem', margin: 0 } },
        'No details yet — add colour, size, artist or anything else that tells this piece apart.'));
  };

  const addRow = (label = '', value = '') => {
    const labelInput = h('input', {
      type: 'text', value: label, maxlength: 40, placeholder: 'e.g. Colour',
      list: 'shop-detail-labels',
    });
    const valueInput = h('input', { type: 'text', value, maxlength: 80, placeholder: 'e.g. Indigo' });
    rows.push({ label: labelInput, value: valueInput });
    draw();
  };

  for (const [label, value] of Object.entries(parseAttributes(initial) ?? {})) addRow(label, value);
  draw();

  return {
    node: h('div',
      h('datalist', { id: 'shop-detail-labels' }, known.map((k) => h('option', { value: k }))),
      listHost,
      h('button.btn-sm', { style: { marginTop: '.45rem' }, onclick: () => addRow() }, '+ Add a detail'),
    ),
    get value() {
      const out = {};
      for (const row of rows) {
        const label = row.label.value.trim();
        const value = row.value.value.trim();
        if (label && value) out[label] = value;
      }
      return Object.keys(out).length ? out : null;
    },
  };
}

function categorySelect(categories, selected) {
  return h('select',
    h('option', { value: '' }, 'No category'),
    categories.map((c) => h('option', { value: String(c.id), selected: c.id === selected }, c.name)),
  );
}

function addProductCard(data, reload) {
  const name = h('input', { type: 'text', placeholder: 'e.g. Kente stole, blue', maxlength: 100 });
  const sku = h('input', { type: 'text', placeholder: 'Code (optional)', maxlength: 40 });
  const unit = h('input', { type: 'text', value: 'pcs', maxlength: 20 });
  const category = categorySelect(data.categories, null);
  const stock = h('input', { type: 'number', min: '0', step: 'any', placeholder: '0' });
  const par = h('input', { type: 'number', min: '0', step: 'any', placeholder: '0' });
  const common = h('input', { type: 'checkbox', checked: true, style: { width: 'auto', margin: 0 } });
  const prices = priceFields();
  const details = detailEditor(null, data.items);

  const add = async (event) => {
    if (!name.value.trim()) { toast('Give the product a name', 'bad'); return; }
    event.target.disabled = true;
    try {
      await api.shopCreateItem({
        name: name.value.trim(),
        sku: sku.value.trim() || null,
        unit: unit.value.trim() || 'pcs',
        categoryId: category.value || null,
        sellPrice: Number(prices.price.value) || 0,
        unitCost: Number(prices.cost.value) || 0,
        openingStock: Number(stock.value) || 0,
        parLevel: Number(par.value) || 0,
        attributes: details.value,
        isCommon: common.checked,
      });
      toast(`${name.value.trim()} added`, 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const newCategory = async () => {
    const value = prompt('Name the new category');
    if (!value?.trim()) return;
    try {
      await api.shopCreateCategory({ name: value.trim() });
      toast('Category added', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  return card('Add a product', { wide: true },
    h('div.field-row',
      h('label.field', h('span', 'Name'), name),
      h('label.field', h('span', 'Code'), sku),
      h('label.field', h('span', 'Category'), category),
      h('label.field', h('span', 'Measured in'), unit),
    ),
    h('div.field-row', { style: { marginTop: '.6rem' } },
      h('label.field', h('span', 'It cost you'), prices.cost),
      h('label.field', h('span', 'You charge'), prices.price),
      h('label.field', h('span', 'On the shelf now'), stock),
      h('label.field', h('span', 'Restock level'), par),
    ),
    h('div', { style: { marginTop: '.3rem' } }, prices.readout),

    h('label', {
      style: { display: 'flex', gap: '.5rem', alignItems: 'center', marginTop: '.6rem', cursor: 'pointer' },
    }, common, h('span', 'Show on the till without searching')),

    h('div', { style: { marginTop: '.8rem' } },
      h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Details (optional)'),
      details.node,
    ),

    h('div.btn-row', { style: { marginTop: '.9rem' } },
      h('button.btn-primary', { onclick: add }, 'Add product'),
      h('button.btn-sm', { onclick: newCategory }, '+ New category'),
    ),
  );
}

function productsCard(data, reload) {
  const chosen = new Set();
  const boxes = new Map();
  const bar = h('div.bulk-bar.hidden');

  const refresh = () => {
    bar.classList.toggle('hidden', chosen.size === 0);
    const label = bar.querySelector('.bulk-count');
    if (label) {
      label.textContent = `${chosen.size} ${chosen.size === 1 ? 'product' : 'products'} selected`;
    }
  };

  const tick = (row) => {
    const box = h('input', {
      type: 'checkbox', style: { width: 'auto', margin: 0 },
      onchange: () => {
        if (box.checked) chosen.add(row.id); else chosen.delete(row.id);
        refresh();
      },
    });
    boxes.set(row.id, box);
    return box;
  };

  mount(bar,
    h('span.bulk-count', ''),
    h('div.btn-row',
      h('button.btn-sm', {
        onclick: () => { boxes.forEach((b) => { b.checked = false; }); chosen.clear(); refresh(); },
      }, 'Clear'),
      h('button.btn-sm', {
        onclick: async (event) => {
          const ids = [...chosen];
          if (!confirm(`Remove ${ids.length} ${ids.length === 1 ? 'product' : 'products'}? `
            + 'Anything that has ever been sold is retired instead, so past takings still add up.')) return;
          event.target.disabled = true;
          try {
            const result = await api.shopRemoveItems(ids);
            toast(result.retired
              ? `${result.removed} removed, ${result.retired} retired`
              : `${result.removed} removed`, 'good');
            reload();
          } catch (err) {
            toast(err.message, 'bad');
            event.target.disabled = false;
          }
        },
      }, 'Remove selected'),
    ),
  );

  const margin = (item) => {
    if (!(item.sellPrice > 0) || !(item.unitCost > 0)) return null;
    return ((item.sellPrice - item.unitCost) / item.sellPrice) * 100;
  };

  return card('The product list', {
    wide: true,
    note: `${data.items.length} ${data.items.length === 1 ? 'product' : 'products'}`,
  },
    bar,
    data.items.length
      ? table([
        { key: 'id', label: '', format: (v, r) => tick(r) },
        {
          key: 'name',
          label: 'Product',
          format: (v, r) => h('div',
            h('div', v, r.isCommon ? h('span.pill.info', { style: { marginLeft: '.4rem' } }, 'on the till') : null),
            h('small.muted', [
              data.categories.find((c) => c.id === r.categoryId)?.name,
              r.sku,
              attributeSummary(r.attributes),
            ].filter(Boolean).join(' · ')),
          ),
        },
        { key: 'unit', label: 'Unit' },
        { key: 'unitCost', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        { key: 'sellPrice', label: 'Price', align: 'right', format: (v) => h('strong', fmtMoney(v, { withSymbol: false })) },
        {
          key: 'parLevel',
          label: 'Margin',
          align: 'right',
          format: (v, r) => {
            const pct = margin(r);
            if (pct == null) return h('span.muted', '—');
            return h('span', {
              style: { color: pct < 0 ? 'var(--bad)' : pct < 20 ? 'var(--warn)' : 'var(--good)' },
            }, `${fmtNum(pct, 0)}%`);
          },
        },
        {
          key: 'openingStock',
          label: '',
          format: (v, r) => h('button.btn-sm.btn-ghost', { onclick: () => editProduct(r, data, reload) }, 'Edit'),
        },
      ], data.items, {
        rowClass: (r) => (r.sellPrice > 0 && r.unitCost > 0 && r.sellPrice < r.unitCost ? 'row-flag-high' : ''),
      })
      : h('div.empty', h('p', 'No products yet. Add the first one above.')),
  );
}

function editProduct(item, data, reload) {
  const name = h('input', { type: 'text', value: item.name, maxlength: 100 });
  const sku = h('input', { type: 'text', value: item.sku ?? '', maxlength: 40 });
  const unit = h('input', { type: 'text', value: item.unit, maxlength: 20 });
  const category = categorySelect(data.categories, item.categoryId);
  const stock = h('input', { type: 'number', min: '0', step: 'any', value: String(item.openingStock ?? 0) });
  const par = h('input', { type: 'number', min: '0', step: 'any', value: String(item.parLevel ?? 0) });
  const common = h('input', {
    type: 'checkbox', checked: item.isCommon, style: { width: 'auto', margin: 0 },
  });
  const prices = priceFields(item);
  const details = detailEditor(item.attributes, data.items);
  const problem = h('div.form-error.hidden');

  const save = async (event) => {
    if (!name.value.trim()) {
      problem.textContent = 'Give the product a name.';
      problem.classList.remove('hidden');
      return;
    }
    event.target.disabled = true;
    try {
      await api.shopUpdateItem(item.id, {
        name: name.value.trim(),
        sku: sku.value.trim() || null,
        unit: unit.value.trim() || 'pcs',
        categoryId: category.value || null,
        sellPrice: Number(prices.price.value) || 0,
        unitCost: Number(prices.cost.value) || 0,
        openingStock: Number(stock.value) || 0,
        parLevel: Number(par.value) || 0,
        attributes: details.value,
        isCommon: common.checked,
      });
      toast('Saved', 'good');
      dialog.close();
      reload();
    } catch (err) {
      problem.textContent = err.message;
      problem.classList.remove('hidden');
      event.target.disabled = false;
    }
  };

  const dialog = h('dialog', {
    style: {
      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      background: 'var(--surface)', color: 'var(--text)',
      maxWidth: '620px', width: '92vw', padding: '1.2rem',
    },
  },
    h('div.card-head',
      h('h2', `Edit ${item.name}`),
      h('button.btn-sm.btn-ghost', { onclick: () => dialog.close() }, '✕'),
    ),
    h('div.field-row',
      h('label.field', h('span', 'Name'), name),
      h('label.field', h('span', 'Code'), sku),
      h('label.field', h('span', 'Category'), category),
      h('label.field', h('span', 'Measured in'), unit),
    ),
    h('div.field-row', { style: { marginTop: '.6rem' } },
      h('label.field', h('span', 'It cost you'), prices.cost),
      h('label.field', h('span', 'You charge'), prices.price),
      h('label.field', h('span', 'Opening stock'), stock),
      h('label.field', h('span', 'Restock level'), par),
    ),
    h('div', { style: { marginTop: '.3rem' } }, prices.readout),
    h('label', {
      style: { display: 'flex', gap: '.5rem', alignItems: 'center', marginTop: '.6rem', cursor: 'pointer' },
    }, common, h('span', 'Show on the till without searching')),
    h('div', { style: { marginTop: '.8rem' } },
      h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Details'),
      details.node,
    ),
    problem,
    h('div.btn-row', { style: { marginTop: '1rem', justifyContent: 'flex-end' } },
      h('button', { onclick: () => dialog.close() }, 'Cancel'),
      h('button.btn-primary', { onclick: save }, 'Save changes'),
    ),
    h('p.muted', { style: { fontSize: '.8rem', marginTop: '.7rem', marginBottom: 0 } },
      'Changing the price does not change what past sales were rung up at — those keep '
      + 'whatever was charged on the day.'),
  );

  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}
