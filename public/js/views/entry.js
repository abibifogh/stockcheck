import { api, dequeueDay, queueDay } from '../api.js';
import { can, navigate, replaceParams, state } from '../app.js';
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
  // Today opens on a short summary; the sheet itself opens when asked for.
  if (!params.sheet) return renderToday(params);

  const day = params.day || todayISO();
  const data = await api.getDay(day);
  const { categories, ingredients } = state.catalog;

  // A day that is in, or has a correction waiting, has no form: it shows as
  // closed. A correction is opened only on purpose, from the closed day's
  // "Send a correction" link.
  if (data.pendingRevision || (data.service.submitted_at && !params.correct)) {
    return renderToday({ day });
  }
  const correcting = Boolean(data.service.submitted_at);
  // The server's rule: a correction waits for a manager unless whoever sends
  // it can approve corrections, or approval is switched off in Setup.
  const viaManager = correcting && !can('approvals')
    && (state.settings?.require_resubmit_approval ?? '1') !== '0';

  const usage = new Map(Object.entries(data.usage).map(([k, v]) => [Number(k), Number(v)]));
  const hints = data.hints || {};
  const service = {
    inhouse: data.service.inhouse_guests,
    outside: data.service.outside_guests,
    note: data.service.note || '',
  };
  const allowFillUsual = data.allowFillUsual !== false;
  const requireComplete = data.requireComplete !== false;
  const requiredIds = new Set(data.requiredIngredientIds || []);
  const locked = Boolean(data.locked);
  const restrictToEveryday = data.restrictToEveryday === true;
  let showAll = false;
  let filter = '';
  let dirty = false;

  // Supplies (tissue, soap) are issued from the storeroom, never eaten at breakfast.
  const activeIngredients = ingredients.filter((i) => i.active && (i.kind ?? 'food') !== 'supply');
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
    note: service.note || null,
    usage: Object.fromEntries([...usage.entries()]),
    submit,
  });

  async function save({ submit = false, quiet = true } = {}) {
    const body = payload(submit);
    setStatus('Saving…');
    try {
      const result = await api.saveDay(day, body);
      dequeueDay(day);
      dirty = false;
      const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      setStatus(
        result.pendingApproval ? 'Sent for approval' : submit ? 'Submitted ✓' : `Saved ${time}`,
        result.pendingApproval ? 'warn' : submit ? 'good' : '',
      );
      if (!quiet) toast(submit ? 'Day submitted' : 'Saved', 'good');
      return result;
    } catch (err) {
      // A rejected submission is a rule, not a lost connection — do not queue
      // it for retry, because retrying will fail in exactly the same way.
      if (err.status >= 400 && err.status < 500) {
        setStatus('Not saved', 'bad');
        toast(err.message, 'bad');
        return null;
      }
      queueDay(day, body);
      setStatus('Saved on this device — will sync', 'warn');
      if (!quiet) toast(err.message, 'bad');
      return null;
    }
  }

  const autosave = debounce(() => { if (dirty) save({ quiet: true }); }, 1200);

  const touch = () => {
    dirty = true;
    setStatus('Unsaved changes…');
    paintTotals();
    autosave();
  };

  /** Everyday items with no figure at all — the thing that blocks a submission. */
  function missingRequired() {
    return activeIngredients.filter((i) => requiredIds.has(i.id) && !usage.has(i.id));
  }

  /** Items deliberately recorded as none used. Worth confirming, not blocking. */
  function zeroItems() {
    return activeIngredients.filter((i) => usage.get(i.id) === 0);
  }

  function paintTotals() {
    const required = activeIngredients.filter((i) => requiredIds.has(i.id));
    const done = required.length - missingRequired().length;
    const zeros = zeroItems().length;

    mount(totalsEl,
      h('b', `${guests()}`), ' guests · ',
      h('b', `${done}`), ` of ${required.length} everyday items entered`,
      done < required.length
        ? h('span.pill.warn', `${required.length - done} still to go`)
        : h('span.pill.good', 'complete'),
      zeros ? h('span.pill', `${zeros} recorded as zero`) : null,
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

    const needed = highlightMissing && requiredIds.has(ing.id) && !usage.has(ing.id);
    const row = h(`div.item${usage.has(ing.id) ? '.filled' : ''}${needed ? '.needed' : ''}`,
      { dataset: { name: ing.name.toLowerCase() } },
      h('div',
        h('div.item-name', ing.name, h('span.item-unit', ing.unit)),
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

  let highlightMissing = false;

  function paintList() {
    const visible = activeIngredients.filter((ing) => {
      if (highlightMissing && requiredIds.has(ing.id) && !usage.has(ing.id)) return true;
      if (filter && !ing.name.toLowerCase().includes(filter)) return false;

      // A restricted list still shows anything already recorded, so switching
      // the setting on never makes a figure somebody entered disappear.
      if (restrictToEveryday) return ing.is_core || usage.has(ing.id);

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
  // Today's sheet has no Prev and Next: a stray tap should never move the
  // morning to yesterday. Another day, opened on purpose, keeps them.
  const isToday = day === todayISO();
  const toolbar = h('div.toolbar',
    isToday ? null : h('button.btn-sm', { onclick: () => go(shiftDay(day, -1)) }, '‹ Prev'),
    isToday ? null : h('input', {
      type: 'date', value: day, max: todayISO(),
      onchange: (e) => e.target.value && go(e.target.value),
    }),
    isToday ? null : h('button.btn-sm', { onclick: () => go(shiftDay(day, 1)), disabled: day >= todayISO() }, 'Next ›'),
    isToday ? null : h('a.btn.btn-sm', { href: '#/entry' }, 'Back to today'),
    h('div', { style: { flex: '1' } }),
    h('input', {
      type: 'search', placeholder: 'Search ingredient…', style: { maxWidth: '200px' },
      oninput: (e) => { filter = e.target.value.trim().toLowerCase(); paintList(); },
    }),
    restrictToEveryday ? null : h('div.seg',
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
    replaceParams('entry', { day: nextDay, sheet: 1 });
    const view = await renderEntry({ day: nextDay, sheet: 1 });
    // A day already in opens closed, so the address should say so too.
    if (view.classList.contains('today-page')) replaceParams('entry', { day: nextDay });
    const host = document.querySelector('.main');
    if (host) mount(host, view);
  }

  const footer = h('div.entry-footer',
    h('div.entry-footer-inner',
      statusEl,
      // A correction of figures already on screen has nothing to fill.
      allowFillUsual && !(correcting && !data.clearedForEntry)
        ? h('button', { onclick: fillUsual }, '⚡ Fill usual') : null,
      h('button', { onclick: () => save({ submit: false, quiet: false }) }, 'Save'),
      h('button.btn-primary', { onclick: attemptSubmit, disabled: locked },
        correcting ? 'Send correction' : 'Submit day'),
    ),
  );

  /**
   * Submitting is the moment the numbers become real, so it is the one place
   * that argues back: nothing missing, and zeros acknowledged out loud.
   */
  async function attemptSubmit() {
    if (!guests()) {
      toast('Enter the guest count before submitting', 'bad');
      return;
    }

    const missing = missingRequired();
    if (requireComplete && missing.length) {
      highlightMissing = true;
      paintList();
      const names = missing.slice(0, 6).map((i) => i.name).join(', ');
      toast(
        `${missing.length} everyday ${missing.length === 1 ? 'item has' : 'items have'} no figure: `
        + `${names}${missing.length > 6 ? '…' : ''}. Enter 0 if none was used.`,
        'bad',
      );
      missing[0] && document.querySelector(`.item[data-name="${missing[0].name.toLowerCase()}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const zeros = zeroItems();
    if (zeros.length) {
      const names = zeros.map((i) => `• ${i.name}`).join('\n');
      const confirmed = window.confirm(
        `You are recording ZERO used for ${zeros.length} ${zeros.length === 1 ? 'item' : 'items'}:\n\n`
        + `${names}\n\nIs that right? Choose Cancel to go back and change them.`,
      );
      if (!confirmed) return;
    }

    const result = await save({ submit: true, quiet: true });
    if (!result) return;
    if (result.pendingApproval) toast('Correction sent to a manager for approval', 'good');
    else toast('Day submitted', 'good');
    // Sent: the form closes, and the day shows as done (or as waiting).
    navigate('entry', isToday ? {} : { day });
  }

  paintTotals();
  paintList();
  setStatus(
    correcting ? (viaManager ? 'A correction: it goes to a manager' : 'A correction')
      : data.service.day && Object.keys(data.usage).length ? 'Draft saved'
        : 'Not started',
    correcting ? 'warn' : '',
  );

  // A page reload mid-service should not lose the morning.
  window.addEventListener('beforeunload', (event) => {
    if (dirty) event.preventDefault();
  });

  return h('div.entry-page',
    h('div.page-head',
      h('div',
        h('h1', isToday ? 'Today’s sheet' : fmtDay(day, { withYear: true })),
        h('div.sub', correcting ? (viaManager ? 'A correction: a manager approves it' : 'A correction: it replaces what was sent')
          : isToday ? fmtDay(day, { withYear: true }) : 'An earlier day'),
      ),
      correcting ? h('span.pill.warn', 'Correction') : h('span.pill', 'In progress'),
    ),
    toolbar,
    locked ? h('div.alert.warn',
      h('span.alert-icon', '🔒'),
      h('div',
        h('div.alert-title', 'This day is in a closed period'),
        h('div.alert-detail',
          `${data.lock.from} to ${data.lock.to}${data.lock.reason ? ` — ${data.lock.reason}` : ''}. `
          + 'The figures cannot be changed. Ask an administrator to unlock the period first.'),
      )) : null,
    // A blank sheet on a day the cook knows they filled in is alarming unless
    // somebody says why, so this goes above everything else.
    // A correction only: the day is in, and this sheet is opened on purpose.
    // (A day with a correction already waiting never opens a sheet at all.)
    correcting ? h('div.alert.info',
      h('span.alert-icon', '✓'),
      h('div',
        h('div.alert-title', 'This day has already been sent'),
        h('div.alert-detail', data.clearedForEntry
          ? 'Your figures are recorded and safe. The form starts empty so a correction is counted again '
            + 'rather than nudged. Fill it in afresh and send it; a manager compares it with what was sent first.'
          : viaManager
            ? 'Change what was wrong and send the correction. A manager compares it with what was sent first, '
              + 'and the recorded figures stay until they accept it.'
            : 'Change what was wrong and send the correction. It replaces what was sent.'),
        h('a.btn.btn-sm', { href: isToday ? '#/entry' : `#/entry?day=${day}`, style: { marginTop: '.5rem' } },
          'Nothing wrong? Close'),
      )) : null,
    guestCard,
    listHost,
    footer,
  );
}

/**
 * Today, before the sheet: where the morning stands and one button to go on.
 *
 * Three states, and only the first has a form behind it:
 *
 *  - not started or in progress: the button opens the sheet;
 *  - submitted: closed. What was sent is shown read-only, and a correction is
 *    a deliberate step behind a small link, still sent to a manager;
 *  - a correction waiting: closed too. Nothing to fill in or resend until a
 *    manager decides.
 *
 * It is always today unless somebody chose another day on purpose (see
 * `openOnToday` in app.js, which forgets that choice on the next visit).
 */
async function renderToday(params) {
  const day = params.day || todayISO();
  const isToday = day === todayISO();
  const data = await api.getDay(day);
  const { ingredients } = state.catalog;

  const guests = (Number(data.service.inhouse_guests) || 0) + (Number(data.service.outside_guests) || 0);
  const submitted = Boolean(data.service.submitted_at);
  const entered = new Set(Object.keys(data.usage || {}).map(Number));
  const required = (data.requiredIngredientIds || [])
    .filter((id) => ingredients.some((i) => i.id === id && i.active && (i.kind ?? 'food') !== 'supply'));
  const done = required.filter((id) => entered.has(id)).length;
  const started = !submitted && (guests > 0 || entered.size > 0);

  const openSheet = (d, extra = {}) => navigate('entry', { day: d, sheet: 1, ...extra });
  const other = h('input', {
    type: 'date', max: todayISO(), value: shiftDay(todayISO(), -1), 'aria-label': 'Another day',
  });

  const head = isToday
    ? h('div.page-head', h('div', h('h1', 'Today'), h('div.sub', fmtDay(day, { withYear: true }))))
    : h('div.page-head.today-head',
      h('a.today-back', { href: '#/entry', 'aria-label': 'Back to today', html: BACK }),
      h('div', h('h1', fmtDay(day)), h('div.sub', 'An earlier day')));

  let main;
  if (data.pendingRevision) {
    main = closedCard({
      tone: 'waiting',
      status: 'Correction waiting for approval',
      title: 'With a manager now',
      lines: [
        `${data.pendingRevision.submitted_by ?? 'Somebody'} sent a correction ${when(data.pendingRevision.submitted_at)}. `
        + 'The figures stay as first recorded until a manager accepts or rejects it.',
      ],
      strong: 'Nothing to fill in.',
    });
  } else if (submitted) {
    main = closedCard({
      tone: 'done',
      title: 'Breakfast is in',
      lines: [
        data.clearedForEntry ? null : `${guests} ${guests === 1 ? 'guest' : 'guests'} · ${entered.size} ${entered.size === 1 ? 'item' : 'items'}`,
        `Sent ${when(data.service.submitted_at)}${data.service.submitted_by ? ` by ${data.service.submitted_by}` : ''}`,
      ].filter(Boolean),
      chip: isToday ? 'Nothing more to do today' : 'Nothing more to do for this day',
    });
  } else {
    main = h('section.today-card',
      h('span.today-status', h(`span.pill${started ? '.warn' : ''}`, started ? 'In progress' : 'Not started')),
      h('div.today-figure', started ? `${guests} ${guests === 1 ? 'guest' : 'guests'}` : 'Breakfast'),
      h('div.today-line', started
        ? `${done} of ${required.length} everyday items entered`
        : `${required.length} everyday items to fill in`),
      data.locked ? h('div.today-line', '🔒 In a closed period: it can be read but not changed.') : null,
      h('button.btn-primary.today-go', { onclick: () => openSheet(day) },
        started ? 'Continue the sheet' : isToday ? 'Start today’s sheet' : 'Start the sheet'),
    );
  }

  // What is on record, read-only. Not sent to a browser whose only job is the
  // entry screen once the day is in (the server withholds it), so then there is
  // simply nothing to list.
  const recorded = (submitted || data.pendingRevision) && entered.size
    ? sentList(data, ingredients, data.pendingRevision ? 'Recorded now' : 'What was sent')
    : null;

  const correct = submitted && !data.pendingRevision && !data.locked
    ? h('button.today-correct', { onclick: () => openSheet(day, { correct: 1 }) }, 'Something wrong? Send a correction')
    : null;

  return h('div.today-page',
    head,
    main,
    recorded,
    correct,
    isToday
      ? h('section.card.today-other',
        h('h2', 'Another day'),
        h('div.btn-row',
          other,
          h('button', { onclick: () => other.value && navigate('entry', { day: other.value }) }, 'Open')))
      : h('div.btn-row', { style: { justifyContent: 'center', marginTop: '.5rem' } },
        h('a.btn.today-home', { href: '#/entry' }, 'Back to today')),
  );
}

const BACK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
const TICK = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

/** A day nobody needs to touch: submitted, or with a correction waiting. */
function closedCard({ tone, status, title, lines, strong, chip }) {
  return h(`section.today-card.today-closed.is-${tone}`,
    tone === 'done'
      ? h('span.today-tick', { html: TICK })
      : h('span.today-status', h('span.pill.warn', status)),
    h('div.today-figure', title),
    ...lines.map((line) => h('div.today-line', line)),
    strong ? h('div.today-line', h('b', strong)) : null,
    chip ? h('span.today-chip', chip) : null,
  );
}

/** The figures on record: the first three, and the rest a tap away. */
function sentList(data, ingredients, title) {
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  const rows = Object.entries(data.usage)
    .map(([id, qty]) => ({ item: byId.get(Number(id)), qty: Number(qty) }))
    .filter((r) => r.item)
    .sort((a, b) => (a.item.sort_order ?? 0) - (b.item.sort_order ?? 0));
  const guests = (Number(data.service.inhouse_guests) || 0) + (Number(data.service.outside_guests) || 0);
  const line = (label, value) => h('div.sent-row', h('span', label), h('b', value));
  const list = h('div.sent-list');
  const paint = (all) => {
    const shown = all ? rows : rows.slice(0, 3);
    mount(list,
      line('Guests', String(guests)),
      shown.map((r) => line(r.item.name, fmtQty(r.qty, r.item.unit, 2))),
      rows.length > 3
        ? h('button.btn-sm', { onclick: () => paint(!all) }, all ? 'Show fewer' : `Show all ${rows.length}`)
        : null);
  };
  paint(false);
  return h('section.card.sent-card',
    h('div.card-head', h('h2', title), h('span.card-note', 'READ ONLY')),
    list);
}

/** "today at 07:42", "on Wed 11 Nov at 11:09". SQLite's datetime is UTC. */
function when(at) {
  if (!at) return '';
  const d = new Date(`${String(at).replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(at) ? '' : 'Z'}`);
  if (Number.isNaN(d.getTime())) return String(at);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = d.toISOString().slice(0, 10);
  if (day === todayISO()) return `today at ${time}`;
  return `on ${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${time}`;
}
