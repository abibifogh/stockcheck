import { api } from '../api.js';
import { fmtDay, h, mount, shiftDay, toast } from '../util.js';
import { card, table } from './components.js';

/**
 * What the roster can say about a bed, and what it looks like when it says it.
 *
 * One description, used by every screen that shows an expectation: this one,
 * the setup screen, a room's own page, and the hint on the check screen for
 * the few people allowed to see it. Green for a bed that should be empty, blue
 * for one somebody is booked into, grey for one nobody is tracking — so a
 * roster can be read down the page at a glance instead of word by word.
 */
export const ROSTER_STATES = {
  free: { label: 'Should be free', short: 'rostered free', cls: 'roster-free' },
  occupied: { label: 'Should be occupied', short: 'rostered occupied', cls: 'roster-occupied' },
  none: { label: 'Not tracked', short: 'not tracked', cls: 'roster-none' },
};

const stateOf = (value) => ROSTER_STATES[value || 'none'] ?? ROSTER_STATES.none;

/**
 * The "Tonight the roster says" control, which wears its own answer.
 *
 * Setting `.value` from code does not fire a change event, so anything that
 * sets a whole room at once must dispatch one — that is what repaints it.
 */
export function rosterSelect(value, onchange) {
  const select = h('select.roster-select',
    h('option', { value: '' }, ROSTER_STATES.none.label),
    h('option', { value: 'free' }, ROSTER_STATES.free.label),
    h('option', { value: 'occupied' }, ROSTER_STATES.occupied.label),
  );
  select.value = value ?? '';

  const paint = () => { select.className = `roster-select ${stateOf(select.value).cls}`; };
  select.addEventListener('change', () => { paint(); onchange?.(); });
  paint();
  return select;
}

/** The same three states, read-only, for the screens that only report them. */
export function rosterTag(value, { short = false } = {}) {
  const state = stateOf(value);
  return h(`span.pill.${state.cls}`, short ? state.short : state.label);
}

/**
 * The roster: last night closed off, tonight set.
 *
 * Two jobs on one screen, in the order they are actually done. Whoever writes
 * the roster in the morning starts by saying how last night really ended —
 * cancellations, no-shows, the walk-in at eleven — because that is what this
 * morning's check is being judged against. Then they set tonight.
 *
 * Splitting them across two screens would mean the confirming never happens,
 * and an unconfirmed night is one where the morning check is measured against
 * a guess.
 */
export async function renderHkRoster(params = {}) {
  const data = await api.hkRoster(params.day);
  const host = h('div.hk-page');
  const reload = async (day) => mount(host, await renderHkRoster({ day: day ?? data.day }));

  // Every control on the page, held by bed id alongside what it started as, so
  // a save sends only what actually changed.
  const tonight = new Map();
  const lastNight = new Map();
  const settled = Boolean(data.lastNightConfirmed);

  const statusEl = h('div.hk-status', '');
  const countEl = h('div.hk-progress', '');

  const changedIn = (edits) => [...edits.values()].filter(isChanged);

  const refresh = () => {
    const changes = changedIn(tonight).length + (settled ? 0 : changedIn(lastNight).length);
    mount(countEl, changes
      ? `${changes} ${changes === 1 ? 'bed' : 'beds'} changed`
      : tally(tonight));
    saveBtn.disabled = changes === 0;
    statusEl.textContent = settled
      ? `Last night was confirmed by ${data.lastNightConfirmed.by || 'somebody'}.`
      : 'Confirm last night, set tonight, then save.';
    statusEl.className = 'hk-status';
  };

  const saveBtn = h('button.btn-primary.hk-submit', {
    disabled: true,
    onclick: async () => {
      const tonightChanges = changedIn(tonight);
      const lastNightChanges = settled ? [] : changedIn(lastNight);
      if (!tonightChanges.length && !lastNightChanges.length) return;

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      statusEl.className = 'hk-status';
      statusEl.textContent = 'Saving…';

      try {
        // Last night first. It is the one with a deadline on it — the morning
        // check has already been walked — and if the second call fails, the
        // half that landed is the half that matters.
        if (!settled) {
          await api.hkSaveRoster({
            day: data.previousDay,
            confirm: true,
            beds: payload([...lastNight.values()]),
          });
        }
        if (tonightChanges.length) {
          await api.hkSaveRoster({ day: data.day, beds: payload(tonightChanges) });
        }
        toast(settled ? 'Roster saved' : 'Last night confirmed, roster saved', 'good');
        reload();
      } catch (err) {
        statusEl.className = 'hk-status bad';
        statusEl.textContent = err.message;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save the roster';
      }
    },
  }, 'Save the roster');

  const confirmBar = settled
    ? h('div.alert.info',
      h('span.alert-icon', '✓'),
      h('div',
        h('div.alert-title', `${fmtDay(data.previousDay)} is settled`),
        h('div.alert-detail',
          `Confirmed by ${data.lastNightConfirmed.by || 'somebody'}`
          + `${data.lastNightConfirmed.at ? ` at ${String(data.lastNightConfirmed.at).slice(11, 16)}` : ''}. `
          + 'What the morning check found that day can no longer move.'),
      ))
    : h('div.alert.warn',
      h('span.alert-icon', '⚠️'),
      h('div',
        h('div.alert-title', `First: how did ${fmtDay(data.previousDay)} actually end?`),
        h('div.alert-detail',
          'This morning’s check is judged against last night, not tonight — so a bed that '
          + 'cancelled today was still somebody’s bed last night. Correct anything the bookings '
          + 'changed after the roster was written, then save. It settles that night for good.'),
      ));

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'The roster'),
        h('div.sub', `Tonight: ${fmtDay(data.day)}`
          + (data.tonightFrom ? ` · carried forward from ${fmtDay(data.tonightFrom)}` : '')),
      ),
      h('div.toolbar', { style: { marginBottom: 0 } },
        h('button.btn-sm', { onclick: () => reload(shiftDay(data.day, -1)) }, '‹'),
        h('input', {
          type: 'date', value: data.day, max: data.today,
          onchange: (e) => e.target.value && reload(e.target.value),
        }),
        h('button.btn-sm', {
          onclick: () => reload(shiftDay(data.day, 1)),
          disabled: data.day >= data.today,
        }, '›'),
        data.day === data.today ? null
          : h('button.btn-sm', { onclick: () => reload(data.today) }, 'Today'),
      ),
    ),

    data.rooms.length ? confirmBar : null,

    ...data.rooms.map((room) => roomCard(room, { tonight, lastNight, settled, onChange: refresh })),

    data.rooms.length ? null : h('div.card.empty',
      h('h3', 'No dorm rooms yet'),
      h('p', 'Once the dorms and their beds are set up, they appear here for the roster.'),
    ),

    data.rooms.length ? h('p.muted', { style: { fontSize: '.82rem' } },
      'A bed left as “not tracked” is still checked and still has to have a name tag — it simply '
      + 'raises no surprise either way. The housekeeping round in the middle of the day is only '
      + 'judged where last night and tonight agree, because a bed changing hands can honestly be '
      + 'found either way at eleven in the morning.') : null,

    data.rooms.length ? h('div.hk-footer',
      h('div.hk-footer-inner',
        h('div.hk-footer-text', countEl, statusEl),
        saveBtn,
      ),
    ) : null,
  );

  refresh();
  return host;
}

/** What the API wants: the bed, its state and its note. */
function payload(edits) {
  return edits.map((edit) => ({
    bedId: edit.id,
    expected: edit.roster.value || null,
    note: edit.note ? edit.note.value.trim() || null : null,
  }));
}

/** Changed since the page loaded — an unchanged bed is not worth a write. */
function isChanged(edit) {
  return (edit.roster.value || null) !== edit.was.expected
    || (edit.note && (edit.note.value.trim() || null) !== edit.was.note);
}

/** What tonight's roster currently says, for the footer when nothing is pending. */
function tally(edits) {
  let occupied = 0;
  let free = 0;
  for (const edit of edits.values()) {
    if (edit.roster.value === 'occupied') occupied += 1;
    else if (edit.roster.value === 'free') free += 1;
  }

  const part = (n, state, word) => h(`span.${ROSTER_STATES[state].cls}`, `${n} ${word}`);
  return h('span.roster-tally',
    part(occupied, 'occupied', 'occupied'),
    h('span.muted', ' · '),
    part(free, 'free', 'free'),
    h('span.muted', ' · '),
    part(edits.size - occupied - free, 'none', 'not tracked'),
  );
}

function roomCard(room, { tonight, lastNight, settled, onChange }) {
  const beds = room.beds;
  const selects = [];

  const rows = beds.map((bed) => {
    const was = settled
      ? rosterTag(bed.lastNight)
      : rosterSelect(bed.lastNight, onChange);
    const now = rosterSelect(bed.tonight, onChange);
    const note = h('input', {
      type: 'text', value: bed.tonightNote ?? '', maxlength: 120,
      placeholder: 'Guest or booking (optional)',
      oninput: onChange,
    });

    if (!settled) {
      lastNight.set(bed.bedId, {
        id: bed.bedId,
        roster: was,
        note: null,
        was: { expected: bed.lastNight ?? null, note: bed.lastNightNote ?? null },
      });
    }
    selects.push(now);
    tonight.set(bed.bedId, {
      id: bed.bedId,
      roster: now,
      note,
      was: { expected: bed.tonight ?? null, note: bed.tonightNote ?? null },
    });

    return { id: bed.bedId, label: bed.label, was, now, note };
  });

  const setAll = (value) => {
    for (const select of selects) {
      select.value = value;
      // Setting `.value` in code fires nothing, and the control colours itself
      // on change — so say it changed.
      select.dispatchEvent(new Event('change'));
    }
  };

  return card(room.name, {
    wide: true,
    note: `${beds.length} ${beds.length === 1 ? 'bed' : 'beds'}${room.block ? ` · ${room.block}` : ''}`,
  },
    table([
      { key: 'label', label: 'Bed' },
      { key: 'was', label: 'Last night ended as' },
      { key: 'now', label: 'Tonight the roster says' },
      { key: 'note', label: 'Who is expected' },
    ], rows, { empty: 'No beds in this room yet.' }),

    beds.length ? h('div.btn-row', { style: { marginTop: '.8rem' } },
      h('span.muted', { style: { fontSize: '.82rem' } }, 'Set tonight to:'),
      h('button.btn-sm', { onclick: () => setAll('') }, 'Not tracked'),
      h('button.btn-sm', { onclick: () => setAll('free') }, 'Should be free'),
      h('button.btn-sm', { onclick: () => setAll('occupied') }, 'Should be occupied'),
    ) : null,
  );
}
