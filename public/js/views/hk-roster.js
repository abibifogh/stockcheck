import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
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
 * Tonight's roster, and nothing else.
 *
 * The front desk knows who is booked into which bed tonight, and that knowledge
 * is what turns "this bed is occupied" into "this bed should not have been".
 * But knowing the bookings is no reason to be handed the screen that renames
 * dorms and deletes beds, so the roster gets a page of its own: the same three
 * columns as the setup screen, without the destructive half around them.
 *
 * One Save for the lot. Reception is setting a dozen beds at a time between
 * check-ins, and a Save button per room would mean a dozen presses and a dozen
 * chances to walk away having pressed eleven.
 */
export async function renderHkRoster() {
  const data = await api.hkRooms();
  const rooms = data.rooms.filter((room) => room.active);
  const host = h('div.hk-page');
  const reload = async () => mount(host, await renderHkRoster());

  // Every control on the page, held by bed id alongside what it started as, so
  // the save can send only what actually changed and the count in the footer
  // can say how much that is.
  const edits = new Map();

  const statusEl = h('div.hk-status', 'Set what each bed should be tonight, then save.');
  const countEl = h('div.hk-progress', '');

  const refreshCount = () => {
    const changed = [...edits.values()].filter(isChanged);
    if (changed.length) {
      mount(countEl, `${changed.length} ${changed.length === 1 ? 'bed' : 'beds'} changed`);
    } else {
      mount(countEl, tally(edits));
    }
    saveBtn.disabled = changed.length === 0;
  };

  const saveBtn = h('button.btn-primary.hk-submit', {
    disabled: true,
    onclick: async () => {
      const changed = [...edits.values()].filter(isChanged);
      if (!changed.length) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      statusEl.className = 'hk-status';
      statusEl.textContent = 'Saving…';
      try {
        await api.hkSaveRoster({
          beds: changed.map((edit) => ({
            bedId: edit.id,
            expected: edit.roster.value || null,
            note: edit.note.value.trim() || null,
          })),
        });
        toast(`Roster saved — ${changed.length} ${changed.length === 1 ? 'bed' : 'beds'}`, 'good');
        reload();
      } catch (err) {
        statusEl.className = 'hk-status bad';
        statusEl.textContent = err.message;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save the roster';
      }
    },
  }, 'Save the roster');

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Tonight’s roster'),
        h('div.sub', 'Who should be in each bed when the next check walks the dorms'),
      ),
    ),

    ...rooms.map((room) => roomCard(room, edits, refreshCount)),

    rooms.length ? null : h('div.card.empty',
      h('h3', 'No dorm rooms yet'),
      h('p', 'Once the dorms and their beds are set up, they appear here for the roster.'),
    ),

    rooms.length ? h('p.muted', { style: { fontSize: '.82rem' } },
      'A bed left as “not tracked” is still checked and still has to have a name tag — it simply '
      + 'raises no surprise either way. Only the beds you set here can be reported as occupied '
      + 'when they should have been free.') : null,

    rooms.length ? h('div.hk-footer',
      h('div.hk-footer-inner',
        h('div.hk-footer-text', countEl, statusEl),
        saveBtn,
      ),
    ) : null,
  );

  refreshCount();
  return host;
}

/** Changed since the page loaded — an unchanged bed is not worth a write. */
function isChanged(edit) {
  return (edit.roster.value || null) !== edit.was.expected
    || (edit.note.value.trim() || null) !== edit.was.note;
}

/** What the roster currently says, for the footer when nothing has been touched. */
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

function roomCard(room, edits, onChange) {
  const beds = room.beds.filter((bed) => bed.active);
  const selects = [];

  const rows = beds.map((bed) => {
    const roster = rosterSelect(bed.expected_state, onChange);

    const note = h('input', {
      type: 'text', value: bed.expected_note ?? '', maxlength: 120,
      placeholder: 'Guest or booking (optional)',
      oninput: onChange,
    });

    selects.push(roster);
    edits.set(bed.id, {
      id: bed.id,
      roster,
      note,
      was: { expected: bed.expected_state ?? null, note: bed.expected_note ?? null },
    });

    return { id: bed.id, label: bed.label, roster, note };
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
      { key: 'roster', label: 'Tonight the roster says' },
      { key: 'note', label: 'Who is expected' },
    ], rows, { empty: 'No beds in this room yet.' }),

    beds.length ? h('div.btn-row', { style: { marginTop: '.8rem' } },
      h('span.muted', { style: { fontSize: '.82rem' } }, 'Set every bed to:'),
      h('button.btn-sm', { onclick: () => setAll('') }, 'Not tracked'),
      h('button.btn-sm', { onclick: () => setAll('free') }, 'Should be free'),
      h('button.btn-sm', { onclick: () => setAll('occupied') }, 'Should be occupied'),
    ) : null,
  );
}
