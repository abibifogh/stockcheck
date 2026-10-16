import { api } from '../api.js';
import { can, state } from '../app.js';
import { fmtDay, fmtMoney, fmtNum, h, mount, toast } from '../util.js';
import { card, table } from './components.js';

/**
 * Purchases from Odoo, by PO number.
 *
 * Somebody types or pastes the PO numbers, sees what each order holds, and
 * imports it. The only thing ever asked of them is, the first time a product
 * turns up, which ingredient it is — and that answer is remembered, so after
 * the first week or two an import is: paste, look, press.
 *
 * Nothing on this screen decides a figure. The preview is for reading; the
 * import asks Odoo again on the server and records what Odoo says.
 */

const key = (productId, uomId) => `${productId}:${uomId ?? 0}`;
const round4 = (n) => Math.round(Number(n) * 10000) / 10000;

export async function odooImportCard({ onImported }) {
  let status;
  try {
    status = await api.odooStatus();
  } catch (err) {
    // 409 here is "the database update has not been run", which is worth
    // saying in place rather than hiding the feature without a word.
    return card('Import from Odoo', { wide: true },
      h('div.alert.warn', h('div.alert-icon', '⚠️'),
        h('div', h('div.alert-title', 'Not available yet'), h('div.alert-detail', err.message))));
  }

  if (!status.ready) {
    return card('Import from Odoo', { wide: true, note: 'Pull purchase orders in by number' },
      h('p.muted', { style: { fontSize: '.88rem' } }, status.problem),
      can('setup') && !status.base
        ? h('p.muted', { style: { fontSize: '.84rem' } }, 'Set the Odoo address under Setup → Odoo purchase orders.')
        : null);
  }

  const ingredients = state.catalog.ingredients.filter((i) => i.active && !i.is_produced);
  const ingredientById = new Map(state.catalog.ingredients.filter((i) => i.active).map((i) => [i.id, i]));

  const input = h('textarea', {
    rows: 3,
    placeholder: 'P02433, P02441\nor one per line — 2433 works too',
    style: { width: '100%', fontFamily: 'inherit' },
  });
  const results = h('div');
  const previewHost = h('div');

  let preview = null;
  const edits = new Map();
  const editing = new Set();
  const days = {};

  /** The match a line will use: an edit made here, else what was remembered. */
  function matchOf(line) {
    const edit = edits.get(key(line.productId, line.uomId));
    if (edit) return edit;
    return line.mapping
      ? { ...line.mapping, productId: line.productId, uomId: line.uomId }
      : null;
  }

  /** What a line becomes, worked out again here as matches change. */
  function effective(line) {
    if (line.status === 'imported') return { status: 'imported' };
    const match = matchOf(line);
    if (match?.ignored) return { status: 'ignored', match };
    const ingredient = match?.ingredientId ? ingredientById.get(Number(match.ingredientId)) : null;
    if (!ingredient) return { status: 'unmatched', match };
    const factor = Number(match.factor) || 1;
    return {
      status: 'ready',
      match,
      ingredient,
      qty: round4(line.qty * factor),
      unitCost: round4(line.unitPrice / factor),
    };
  }

  function setMatch(line, change) {
    const current = matchOf(line) || { factor: 1, ignored: false, ingredientId: null };
    edits.set(key(line.productId, line.uomId), {
      productId: line.productId,
      uomId: line.uomId,
      product: line.product,
      uom: line.uom,
      ingredientId: current.ingredientId ?? null,
      factor: current.factor ?? 1,
      ignored: Boolean(current.ignored),
      ...change,
    });
    paint();
  }

  function matchEditor(line) {
    const match = matchOf(line) || {};
    const chosen = match.ingredientId ? ingredientById.get(Number(match.ingredientId)) : null;
    const select = h('select', { style: { minWidth: '0', flex: '1 1 12rem' } },
      h('option', { value: '' }, 'Which ingredient is this?'),
      ingredients.map((i) => h('option', {
        value: i.id, selected: Number(match.ingredientId) === i.id,
      }, `${i.name} (${i.unit})`)));
    select.addEventListener('change', () => {
      // Stay open: the conversion is the next question, and closing on the
      // choice would record a crate of thirty as one egg.
      editing.add(key(line.productId, line.uomId));
      setMatch(line, { ingredientId: select.value ? Number(select.value) : null, ignored: false });
    });

    const factor = h('input', {
      type: 'number', min: '0.000001', step: 'any', value: match.factor ?? 1,
      style: { width: '5.5rem' },
    });
    // On change, not on every keystroke: repainting while somebody is typing
    // "30" would take the field away from them after the "3".
    factor.addEventListener('change', () => {
      const n = Number(factor.value);
      if (!(n > 0)) { toast('The conversion must be more than zero', 'bad'); return; }
      // After the event, not inside it: "change" fires as the field loses
      // focus, and the browser objects to a field removed mid-blur.
      setTimeout(() => setMatch(line, { factor: n }), 0);
    });

    return h('div.odoo-match',
      h('div.odoo-match-row', select,
        h('button.btn-sm.btn-ghost', {
          title: 'This product is on the order but is not a breakfast item',
          onclick: () => { editing.delete(key(line.productId, line.uomId)); setMatch(line, { ignored: true }); },
        }, 'Not breakfast')),
      chosen
        ? h('div.odoo-match-row.muted', { style: { fontSize: '.82rem' } },
          h('span', `1 ${line.uom || 'unit'} in Odoo =`), factor, h('span', `${chosen.unit} of ${chosen.name}`))
        : null,
    );
  }

  function lineBlock(line, importable = true) {
    // On an order that cannot be imported there is nothing to decide, so the
    // line is shown for reference and asks nothing.
    if (!importable) {
      return h('div.odoo-line.odoo-quiet',
        h('div.odoo-line-head',
          h('div', h('b', line.product), line.uom ? h('span.muted', ` · ${line.uom}`) : null),
          h('div.muted', { style: { whiteSpace: 'nowrap' } },
            `${fmtNum(line.qty, 3)} × ${fmtMoney(line.unitPrice, { withSymbol: false })}`)));
    }
    const eff = effective(line);
    const k = key(line.productId, line.uomId);
    const open = editing.has(k);

    let outcome;
    if (eff.status === 'imported') {
      outcome = h('div.odoo-outcome', h('span.pill', 'already recorded'),
        line.importedDay ? h('span.muted', ` on ${fmtDay(line.importedDay)}`) : null);
    } else if (eff.status === 'ignored') {
      outcome = h('div.odoo-outcome', h('span.pill', 'not breakfast — skipped'),
        h('button.btn-sm.btn-ghost', { onclick: () => setMatch(line, { ignored: false }) }, 'Undo'));
    } else if (eff.status === 'ready') {
      // What will be recorded, in the ingredient's own unit — shown while the
      // match is being edited too, so a wrong conversion is visible at once.
      outcome = h('div',
        h('div.odoo-outcome',
          h('span.pill.good', '✓'),
          h('span', ` ${fmtNum(eff.qty, 3)} ${eff.ingredient.unit} ${eff.ingredient.name} at ${fmtMoney(eff.unitCost, { withSymbol: false })}`),
          open
            ? h('button.btn-sm', { onclick: () => { editing.delete(k); paint(); } }, 'Done')
            : h('button.btn-sm.btn-ghost', { onclick: () => { editing.add(k); paint(); } }, 'Change')),
        open ? matchEditor(line) : null);
    } else {
      outcome = h('div',
        h('div.odoo-outcome', h('span.pill.warn', 'not matched yet'),
          line.reason ? h('span.muted', ` ${line.reason}`) : null),
        matchEditor(line));
    }

    return h(`div.odoo-line${eff.status === 'imported' || eff.status === 'ignored' ? '.odoo-quiet' : ''}`,
      h('div.odoo-line-head',
        h('div', h('b', line.product), line.uom ? h('span.muted', ` · ${line.uom}`) : null),
        h('div.muted', { style: { whiteSpace: 'nowrap' } },
          `${fmtNum(line.qty, 3)} × ${fmtMoney(line.unitPrice, { withSymbol: false })}`)),
      outcome);
  }

  function orderBlock(order) {
    const effs = order.lines.map(effective);
    const count = (s) => effs.filter((e) => e.status === s).length;
    const ready = effs.filter((e) => e.status === 'ready');
    const value = ready.reduce((sum, e) => sum + e.qty * e.unitCost, 0);

    const day = h('input', {
      type: 'date',
      value: days[order.name] ?? order.orderedOn ?? '',
      onchange: (e) => { days[order.name] = e.target.value; },
    });

    return h('div.odoo-order',
      h('div.odoo-order-head',
        h('div',
          h('div', h('b', order.name), order.vendor ? h('span', ` · ${order.vendor}`) : null),
          h('div.muted', { style: { fontSize: '.82rem' } },
            `Ordered ${fmtDay(order.orderedOn)} · ${fmtMoney(order.untaxed)} before tax`)),
        h(`span.pill.${order.importable ? 'good' : 'warn'}`, order.stateText)),
      order.importable
        ? h('div',
          h('div.odoo-summary',
            ready.length ? h('span.pill.info', `${ready.length} to record · ${fmtMoney(value, { withSymbol: false })}`) : null,
            count('imported') ? h('span.pill', `${count('imported')} already in`) : null,
            count('ignored') ? h('span.pill', `${count('ignored')} not breakfast`) : null,
            count('unmatched') ? h('span.pill.warn', `${count('unmatched')} to match`) : null,
            !order.lines.length ? h('span.pill', 'no product lines') : null),
          ready.length
            ? h('label.field', { style: { maxWidth: '14rem', margin: '.5rem 0' } },
              h('span', 'Record on'), day)
            : null)
        : h('p.muted', { style: { fontSize: '.84rem', margin: '.4rem 0' } },
          `This order is ${order.stateText}. Only confirmed orders can be imported — confirm it in Odoo first.`),
      order.lines.map((line) => lineBlock(line, order.importable)));
  }

  function paint() {
    if (!preview) { mount(previewHost); return; }
    const importable = preview.orders.filter((o) => o.importable);
    let ready = 0;
    let unmatched = 0;
    let value = 0;
    for (const order of importable) {
      for (const line of order.lines) {
        const eff = effective(line);
        if (eff.status === 'ready') { ready += 1; value += eff.qty * eff.unitCost; }
        if (eff.status === 'unmatched') unmatched += 1;
      }
    }

    mount(previewHost,
      preview.unknown.length
        ? h('div.alert.warn', h('div.alert-icon', '⚠️'),
          h('div', h('div.alert-title', `Odoo has no order called ${preview.unknown.join(', ')}`),
            h('div.alert-detail', 'Check the number. The others below are unaffected.')))
        : null,
      preview.orders.map(orderBlock),
      preview.orders.length
        ? h('div.odoo-footer',
          unmatched
            ? h('p.muted', { style: { fontSize: '.84rem', margin: '0 0 .6rem' } },
              `${unmatched} line${unmatched === 1 ? ' is' : 's are'} not matched to an ingredient and will be left out. `
              + 'Match them now, or later — importing the same PO again brings in only what is missing.')
            : null,
          h('div.btn-row', { style: { justifyContent: 'space-between', alignItems: 'flex-end' } },
            h('div', h('div.stat-label', 'To record'),
              h('div.stat-value', fmtMoney(value)),
              h('div.muted', { style: { fontSize: '.82rem' } }, `${ready} line${ready === 1 ? '' : 's'}`)),
            h('button.btn-primary', { disabled: !ready && !edits.size, onclick: runImport },
              ready ? `Import ${ready} line${ready === 1 ? '' : 's'}` : 'Save matches')))
        : null,
    );
  }

  async function runPreview(event, { names = null } = {}) {
    const text = names ?? input.value.trim();
    if (!text) { toast('Enter at least one PO number', 'bad'); return; }
    const button = event?.target;
    if (button) button.disabled = true;
    // A fresh lookup clears the last import's report; the re-read straight
    // after an import keeps it, since that report is what they came to see.
    if (!names) mount(results);
    mount(previewHost, h('p.muted', 'Reading the orders from Odoo…'));
    try {
      preview = await api.odooPreview(text);
      editing.clear();
      paint();
    } catch (err) {
      preview = null;
      mount(previewHost, h('div.alert.high', h('div.alert-icon', '⛔'),
        h('div', h('div.alert-title', 'Could not read from Odoo'), h('div.alert-detail', err.message))));
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function runImport(event) {
    const button = event.target;
    button.disabled = true;
    const mappings = [...edits.values()].filter((m) => m.ignored || m.ingredientId);
    try {
      // Only confirmed orders: a draft would only come back refused, which
      // the preview already said.
      const pos = preview.orders.filter((o) => o.importable).map((o) => o.name).join(' ');
      if (!pos) { toast('None of these orders is confirmed in Odoo yet', 'bad'); button.disabled = false; return; }
      const result = await api.odooImport({
        pos,
        days,
        mappings,
      });
      edits.clear();
      showResult(result);
      if (result.recorded) {
        toast(`Recorded ${result.recorded} line${result.recorded === 1 ? '' : 's'} — ${fmtMoney(result.total)}`, 'good');
        onImported?.();
      } else if (mappings.length) {
        toast('Matches saved', 'good');
      }
      // Read again, so every line now shows what it actually is.
      await runPreview(null, { names: preview.orders.map((o) => o.name).join(' ') });
    } catch (err) {
      toast(err.message, 'bad');
      button.disabled = false;
    }
  }

  function showResult(result) {
    mount(results,
      result.orders.map((o) => {
        if (o.refused) {
          return h('div.alert.warn', h('div.alert-icon', '⚠️'),
            h('div', h('div.alert-title', `${o.name} was not recorded`), h('div.alert-detail', o.refused)));
        }
        const bits = [];
        if (o.skipped) bits.push(`${o.skipped} already in`);
        if (o.ignored) bits.push(`${o.ignored} not breakfast`);
        if (o.unmatched.length) bits.push(`left out until matched: ${o.unmatched.join(', ')}`);
        return h(`div.alert.${o.recorded ? 'good' : 'info'}`, h('div.alert-icon', o.recorded ? '✅' : 'ℹ️'),
          h('div',
            h('div.alert-title', o.recorded
              ? `${o.name}: ${o.recorded} line${o.recorded === 1 ? '' : 's'} recorded on ${fmtDay(o.day)} · ${fmtMoney(o.value)}`
              : `${o.name}: nothing new to record`),
            bits.length ? h('div.alert-detail', bits.join(' · ')) : null));
      }));
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runPreview();
  });

  return card('Import from Odoo', {
    wide: true,
    note: `Enter PO numbers — up to ${status.maxOrders} at a time`,
  },
    input,
    h('div.btn-row', { style: { marginTop: '.5rem' } },
      h('button.btn-primary', { onclick: runPreview }, 'Look up orders')),
    results,
    previewHost,
  );
}

/**
 * Setup: where Odoo is, and the matches remembered so far.
 *
 * The API key is not here and never will be — it is a Worker secret, so it is
 * never in a database row and never sent to a browser.
 */
export async function odooSetupCard(settings, onSaved) {
  const [status, mapData] = await Promise.all([
    api.odooStatus().catch((err) => ({ error: err.message })),
    api.odooMappings().catch(() => ({ mappings: [] })),
  ]);

  if (status.error) {
    return card('Odoo purchase orders', { wide: true },
      h('p.muted', { style: { fontSize: '.88rem' } }, status.error));
  }

  const base = h('input', { type: 'url', value: settings.odoo_base || '', placeholder: 'https://yourcompany.odoo.com' });
  const db = h('input', { type: 'text', value: settings.odoo_db || '', placeholder: 'Only if Odoo asks for one' });

  const save = h('button.btn-primary', {
    onclick: async () => {
      save.disabled = true;
      try {
        const result = await api.updateSettings({ odoo_base: base.value, odoo_db: db.value });
        state.settings = result.settings;
        toast('Odoo settings saved', 'good');
        onSaved();
      } catch (err) {
        toast(err.message, 'bad');
        save.disabled = false;
      }
    },
  }, 'Save');

  const keyLine = status.hasKey
    ? h('span.pill.good', 'API key is set')
    : h('span.pill.warn', 'API key not set');

  const remembered = mapData.mappings || [];
  return card('Odoo purchase orders', {
    wide: true,
    note: 'Lets Purchases pull an order in by its PO number',
  },
    h('div.field-row',
      h('label.field', h('span', 'Odoo address'), base),
      h('label.field', h('span', 'Database (optional)'), db)),
    h('div.btn-row', { style: { alignItems: 'center', margin: '.4rem 0 .8rem' } }, save, keyLine),
    status.hasKey
      ? null
      : h('p.muted', { style: { fontSize: '.82rem' } },
        'The API key is kept as a secret on the Worker, never in this app, so it cannot be typed in here. '
        + 'An administrator adds it once in Cloudflare as ODOO_API_KEY — the README has the steps.'),
    h('h3', { style: { margin: '.6rem 0' } }, 'Remembered products'),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: 0 } },
      'Matched the first time each one turns up on an order. Forget one and it will be asked about again on the next import.'),
    table([
      { key: 'odoo_name', label: 'Odoo product', format: (v, r) => h('div', h('div', v || `#${r.odoo_product_id}`), r.odoo_uom ? h('small.muted', r.odoo_uom) : null) },
      {
        key: 'ingredient_name',
        label: 'Ingredient here',
        format: (v, r) => {
          if (r.ignored) return h('span.pill', 'not breakfast');
          if (!v) return h('span.pill.warn', 'missing');
          return h('span', v, r.ingredient_active ? null : h('span.pill.warn', { style: { marginLeft: '.3rem' } }, 'retired'));
        },
      },
      {
        key: 'factor',
        label: 'Conversion',
        format: (v, r) => (r.ignored ? h('span.muted', '—') : `1 ${r.odoo_uom || 'unit'} = ${fmtNum(v, 4)} ${r.ingredient_unit || ''}`),
      },
      { key: 'updated_by', label: 'Matched by', format: (v) => v || h('span.muted', '—') },
      {
        key: 'odoo_product_id',
        label: '',
        format: (_, r) => h('button.btn-sm.btn-danger', {
          onclick: async () => {
            if (!confirm(`Forget “${r.odoo_name}”? It will be asked about again next time it is on an order. Purchases already recorded stay as they are.`)) return;
            try {
              await api.deleteOdooMapping(r.odoo_product_id, r.odoo_uom_id);
              toast('Forgotten', 'good');
              onSaved();
            } catch (err) { toast(err.message, 'bad'); }
          },
        }, 'Forget'),
      },
    ], remembered, { empty: 'Nothing matched yet. The first import will ask.', sortable: true }),
  );
}
