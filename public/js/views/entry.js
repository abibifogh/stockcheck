import { api, dequeueDay, queueDay } from '../api.js';
import { state, replaceParams } from '../app.js';
import { debounce, fmtNum, fmtQty, h, mount, todayISO, shiftDay, fmtDay, toast } from '../util.js';

/**
 * The cooks' screen. Everything here is optimised for speed of entry:
 *
 *  - guest counts and quantities are +/- steppers sized for a thumb,
 *  - each item shows what it "usually" takes for today's headcount, one tap
 *    to accept, so a normal morning is a handful of taps rather than typing,
 *  - nothing is pre-filled, because a pre-filled form gets rubber-stamped and
 *    the data stops meaning anything,
 *  - the sheet autosaves, and falls back to this device's storage when the
 *    connection drops.
 */
export async function renderEntry(params) {
  const day = params.day || todayISO();
  const data = await api.getDay(day);
  const { categories, ingredients } = state.catalog;

  const usage = new Map(Object.entries(data.usage).map(([k, v]) => [Number(k), Number(v)]));
  const hints = data.hints || {};
  const service = {
    inhouse: data.service.inhouse_guests,
    outside: data.service.outside_guests,
    fee: Number(data.service.outsider_fee) || 0,
    note: data.service.note || '',
  };
  let submitted = Boolean(data.service.submitted_at);
  let showAll = false;
  let filter = '';
  let dirty = false;

  const activeIngredients = ingredients.filter((i) => i.active);
  const statusEl = h('span.entry-status');
  const totalsEl = h('div.stat-sub');
  const listHost = h('div');

  const guests = () => (Number(service.inhouse) || 0) + (Number(service.outside) || 0);

  const setStatus = (text, kind = '') => {
    mount(statusEl, kind ? h(`span.pill.${kind}`, text) : text);
  };

  const payload = (submit = false) => ({
    inhouse_guests: Number(service.inhouse) || 0,
    outside_guests: Number(service.outside) || 0,
    outsider_fee: Number(service.fee) || 0,
    note: service.note || null,
    usage: Object.fromEntries([...usage.entries()]),
    submit,
  });

  async function save({ submit = false, quiet = true } = {}) {
    const body = payload(submit);
    setStatus('Saving…');
    try {
      await api.saveDay(day, body);
      dequeueDay(day);
      dirty = false;
      if (submit) submitted = true;
      const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      setStatus(submit ? 'Submitted ✓' : `Saved ${time}`, submit ? 'good' : '');
      if (!quiet) toast(submit ? 'Day submitted' : 'Saved', 'good');
    } catch (err) {
      queueDay(day, body);
      setStatus('Saved on this device — will sync', 'warn');
      if (!quiet) toast(err.message, 'bad');
    }
  }

  const autosave = debounce(() => { if (dirty) save({ quiet: true }); }, 1200);

  const touch = () => {
    dirty = true;
    setStatus('Unsaved changes…');
    paintTotals();
    autosave();
  };

  function paintTotals() {
    const recorded = [...usage.values()].filter((v) => v != null).length;
    const expected = activeIngredients.filter((i) => (hints[i.id]?.coverage ?? 0) >= 60).length;
    mount(totalsEl,
      h('b', `${guests()}`), ' guests · ',
      h('b', `${recorded}`), ` of ${expected || activeIngredients.length} usual items recorded`,
      recorded < expected ? h('span.pill.warn', `${expected - recorded} still to go`) : h('span.pill.good', 'complete'),
    );
  }

  // ------------------------------------------------------------- guests --
  function counter(getValue, setValue, { step = 1, min = 0, placeholder = '0' } = {}) {
    const input = h('input', {
      type: 'number', inputmode: 'numeric', min, step, placeholder,
      value: getValue() ?? '',
      onfocus: (e) => e.target.select(),
      oninput: (e) => {
        setValue(e.target.value === '' ? null : Number(e.target.value));
        touch();
        refreshHints();
      },
    });
    const bump = (delta) => {
      const next = Math.max(min, (Number(getValue()) || 0) + delta);
      setValue(next);
      input.value = next;
      touch();
      refreshHints();
    };
    return h('div.counter',
      h('button', { onclick: () => bump(-step), 'aria-label': 'decrease' }, '−'),
      input,
      h('button', { onclick: () => bump(step), 'aria-label': 'increase' }, '+'),
    );
  }

  const guestCard = h('div.entry-guests',
    h('div.guest-grid',
      h('label.field', h('span', 'In-house guests'),
        counter(() => service.inhouse, (v) => { service.inhouse = v; })),
      h('label.field', h('span', 'Outside guests (paying)'),
        counter(() => service.outside, (v) => { service.outside = v; })),
      h('label.field', h('span', `Fee per outsider (${state.settings.currency || 'GHS'})`),
        h('input', {
          type: 'number', min: 0, step: '0.5', value: service.fee || '',
          oninput: (e) => { service.fee = Number(e.target.value) || 0; touch(); },
        })),
      h('label.field', h('span', 'Note (optional)'),
        h('input', {
          type: 'text', placeholder: 'Buffet change, event, …', value: service.note,
          oninput: (e) => { service.note = e.target.value; touch(); },
        })),
    ),
    totalsEl,
  );

  // -------------------------------------------------------------- items --
  /**
   * Suggested quantity for an ingredient, rounded to the precision the kitchen
   * actually works in — whole eggs, not 113.98 of them.
   */
  const hintFor = (ing) => {
    const hint = hints[ing.id];
    if (!hint) return null;
    const g = guests();
    const raw = hint.perGuest != null && g ? hint.perGuest * g : hint.usualQty;
    if (raw == null) return null;
    const places = ing.step >= 1 ? 0 : ing.step >= 0.1 ? 1 : 2;
    return Math.round(raw * 10 ** places) / 10 ** places;
  };

  function itemRow(ing) {
    const suggestion = hintFor(ing);
    const value = usage.get(ing.id);

    const input = h('input', {
      type: 'number', inputmode: 'decimal', min: 0, step: ing.step,
      value: value ?? '',
      placeholder: suggestion != null ? String(suggestion) : '0',
      onfocus: (e) => e.target.select(),
      oninput: (e) => {
        if (e.target.value === '') usage.delete(ing.id);
        else usage.set(ing.id, Number(e.target.value));
        row.classList.toggle('filled', usage.has(ing.id));
        touch();
      },
    });

    const bump = (delta) => {
      const next = Math.max(0, Math.round(((Number(input.value) || 0) + delta) * 1000) / 1000);
      input.value = next;
      usage.set(ing.id, next);
      row.classList.toggle('filled', true);
      touch();
    };

    const accept = () => {
      if (suggestion == null) return;
      input.value = suggestion;
      usage.set(ing.id, suggestion);
      row.classList.add('filled');
      touch();
    };

    const hint = hints[ing.id];
    const hintLine = h('div.item-hint',
      suggestion != null
        ? h('button', { onclick: accept, title: 'Use the usual quantity for today’s headcount' }, `usual ${fmtNum(suggestion, 2)}`)
        : h('span.muted', 'no history yet'),
      hint?.lastQty != null ? h('span', `last ${fmtQty(hint.lastQty, ing.unit, 2)}`) : null,
      hint?.perGuest ? h('span', `${fmtNum(hint.perGuest, 3)} ${ing.unit}/guest`) : null,
    );

    const row = h(`div.item${usage.has(ing.id) ? '.filled' : ''}`, { dataset: { name: ing.name.toLowerCase() } },
      h('div',
        h('div.item-name', ing.name),
        hintLine,
      ),
      h('div.item-input',
        h('button', { onclick: () => bump(-ing.step), 'aria-label': `less ${ing.name}` }, '−'),
        input,
        h('span.unit', ing.unit),
        h('button', { onclick: () => bump(ing.step), 'aria-label': `more ${ing.name}` }, '+'),
      ),
    );
    return row;
  }

  function paintList() {
    const visible = activeIngredients.filter((ing) => {
      if (filter && !ing.name.toLowerCase().includes(filter)) return false;
      if (showAll || filter) return true;
      return ing.is_core || usage.has(ing.id);
    });

    if (!visible.length) {
      mount(listHost, h('div.card.empty',
        h('h3', 'Nothing to show'),
        h('p', filter ? 'No ingredient matches that search.' : 'Ask your manager to add ingredients in Setup.'),
      ));
      return;
    }

    const blocks = categories
      .map((cat) => ({ cat, items: visible.filter((i) => i.category_id === cat.id) }))
      .filter((b) => b.items.length)
      .map(({ cat, items }) => h('section.cat-block',
        h('h3.cat-title', cat.name, h('span.muted', { style: { textTransform: 'none', letterSpacing: 0 } }, `${items.length}`)),
        h('div.item-list', items.map(itemRow)),
      ));

    mount(listHost, blocks);
  }

  /** Re-render the "usual" hints after the headcount changes. */
  const refreshHints = debounce(() => paintList(), 400);

  function fillUsual() {
    let filled = 0;
    for (const ing of activeIngredients) {
      if (usage.has(ing.id)) continue;
      const suggestion = hintFor(ing);
      if (suggestion == null || suggestion <= 0) continue;
      if ((hints[ing.id]?.coverage ?? 0) < 60) continue; // only habitual items
      usage.set(ing.id, suggestion);
      filled += 1;
    }
    paintList();
    touch();
    toast(filled ? `Filled ${filled} usual items — adjust anything that differs` : 'Nothing left to fill', filled ? 'good' : '');
  }

  // ------------------------------------------------------------- toolbar --
  const toolbar = h('div.toolbar',
    h('button.btn-sm', { onclick: () => go(shiftDay(day, -1)) }, '‹ Prev'),
    h('input', {
      type: 'date', value: day, max: todayISO(),
      onchange: (e) => e.target.value && go(e.target.value),
    }),
    h('button.btn-sm', { onclick: () => go(shiftDay(day, 1)), disabled: day >= todayISO() }, 'Next ›'),
    day !== todayISO() ? h('button.btn-sm', { onclick: () => go(todayISO()) }, 'Today') : null,
    h('div', { style: { flex: '1' } }),
    h('input', {
      type: 'search', placeholder: 'Search ingredient…', style: { maxWidth: '200px' },
      oninput: (e) => { filter = e.target.value.trim().toLowerCase(); paintList(); },
    }),
    h('div.seg',
      h('button', { class: showAll ? '' : 'active', onclick: (e) => { showAll = false; segSwap(e); paintList(); } }, 'Everyday'),
      h('button', { class: showAll ? 'active' : '', onclick: (e) => { showAll = true; segSwap(e); paintList(); } }, 'All items'),
    ),
  );

  function segSwap(event) {
    for (const btn of event.target.parentElement.children) btn.classList.remove('active');
    event.target.classList.add('active');
  }

  async function go(nextDay) {
    if (dirty) await save({ quiet: true });
    replaceParams('entry', { day: nextDay });
    const view = await renderEntry({ day: nextDay });
    const host = document.querySelector('.main');
    if (host) mount(host, view);
  }

  const footer = h('div.entry-footer',
    h('div.entry-footer-inner',
      statusEl,
      h('button', { onclick: fillUsual }, '⚡ Fill usual'),
      h('button', { onclick: () => save({ submit: false, quiet: false }) }, 'Save'),
      h('button.btn-primary', {
        onclick: async () => {
          if (!guests()) {
            toast('Enter the guest count before submitting', 'bad');
            return;
          }
          await save({ submit: true, quiet: false });
        },
      }, submitted ? 'Re-submit day' : 'Submit day'),
    ),
  );

  paintTotals();
  paintList();
  setStatus(submitted ? 'Submitted ✓' : data.service.day && Object.keys(data.usage).length ? 'Draft saved' : 'Not started', submitted ? 'good' : '');

  // A page reload mid-service should not lose the morning.
  window.addEventListener('beforeunload', (event) => {
    if (dirty) event.preventDefault();
  });

  return h('div.entry-page',
    h('div.page-head',
      h('div',
        h('h1', fmtDay(day, { withYear: true })),
        h('div.sub', day === todayISO() ? 'Today’s breakfast service' : 'Editing an earlier day'),
      ),
      submitted ? h('span.pill.good', 'Submitted') : h('span.pill', 'In progress'),
    ),
    toolbar,
    guestCard,
    listHost,
    footer,
  );
}
