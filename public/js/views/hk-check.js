import { api } from '../api.js';
import { fmtDay, h, mount, toast } from '../util.js';
import { card } from './components.js';

/**
 * The dorm bed check.
 *
 * This screen decides whether any of the rest of this exists. A housekeeper has
 * a trolley, a stack of linen and eleven rooms to get through before the guests
 * come back; anything that costs more than a tap per bed will be done "later",
 * which means from memory at four o'clock, which is worse than not doing it.
 *
 * So: one row per bed, two buttons — Free, Occupied — and for an occupied bed
 * one more question, Name tag: yes or no. Nothing is typed. Nothing is
 * required. Answers save themselves as they are given, so a phone that dies on
 * the second floor loses nothing, and the whole round is finished by pressing
 * one button at the end.
 */
let activeFlush = null;
window.addEventListener('pagehide', () => activeFlush?.());
window.addEventListener('visibilitychange', () => { if (document.hidden) activeFlush?.(); });

export async function renderHkCheck(params = {}) {
  const data = await api.hkBootstrap({
    ...(params.day ? { day: params.day } : {}),
    ...(params.slot ? { slot: params.slot } : {}),
  });
  const host = h('div.hk-page');

  // bedId -> { state, nameTag, note }. Seeded from what is already recorded, so
  // reopening the screen half-way through a round shows the round, not a blank
  // sheet.
  const answers = new Map();
  for (const room of data.rooms) {
    for (const bed of room.beds) {
      // Each bed carries its room, so a single answer can redraw its own room
      // and nothing else.
      bed.roomId = room.roomId;
      if (bed.state) {
        answers.set(bed.bedId, {
          state: bed.state,
          nameTag: bed.nameTag === null ? null : bed.nameTag === 1,
          note: bed.note ?? null,
        });
      }
    }
  }

  const allBeds = data.rooms.flatMap((r) => r.beds);
  const pending = new Set();
  let saving = false;
  let saveTimer = null;
  let failed = false;

  const roomsHost = h('div.hk-rooms');
  const statusEl = h('span.hk-status');
  const progressEl = h('span.hk-progress');
  const submitBtn = h('button.btn-primary.hk-submit', { onclick: submit }, 'Submit the round');

  // Which rooms are open. The first room with anything left to answer starts
  // open and the rest stay shut: a list of eleven expanded dorms is a list
  // nobody scrolls to the bottom of.
  const openRooms = new Set();
  const firstUnfinished = data.rooms.find((room) => room.beds.some((b) => !answers.has(b.bedId)));
  if (firstUnfinished) openRooms.add(firstUnfinished.roomId);
  else if (data.rooms.length) openRooms.add(data.rooms[0].roomId);

  // ------------------------------------------------------------- saving --

  function scheduleFlush() {
    failed = false;
    clearTimeout(saveTimer);
    // Long enough that answering three beds in a row is one request, short
    // enough that putting the phone in a pocket saves what was just tapped.
    saveTimer = setTimeout(flush, 700);
    drawFooter();
  }

  function queue(bedId) {
    pending.add(bedId);
    scheduleFlush();
  }

  async function flush() {
    if (saving || !pending.size) return;
    const batch = [...pending];
    pending.clear();
    saving = true;
    drawFooter();

    try {
      await api.hkSaveChecks({
        day: data.day,
        slot: data.slot,
        checks: batch.map((bedId) => {
          const answer = answers.get(bedId);
          return {
            bedId,
            state: answer.state,
            nameTag: answer.state === 'occupied' ? answer.nameTag : null,
            note: answer.note || null,
          };
        }),
      });
      saving = false;
      drawFooter();
      if (pending.size) flush();
    } catch (err) {
      // Put them back: an answer that failed to reach the server is still the
      // housekeeper's answer, and it is on screen.
      saving = false;
      failed = true;
      for (const bedId of batch) pending.add(bedId);
      drawFooter();
      toast(err.message, 'bad');
      // Corridors have thin signal. Keep trying quietly rather than making
      // somebody who is already busy remember to press something.
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, 5000);
    }
  }

  // ------------------------------------------------------------ answering --

  function setState(bed, state) {
    const current = answers.get(bed.bedId);
    // Tapping the answer already given clears it, which is how somebody undoes
    // a mis-tap without hunting for an undo button.
    if (current?.state === state && (state === 'free' || current.nameTag === null)) {
      answers.delete(bed.bedId);
      drawRoom(bed.roomId);
      drawFooter();
      return;
    }

    answers.set(bed.bedId, {
      state,
      // Coming back to a bed you already answered keeps the tag answer only if
      // it still applies.
      nameTag: state === 'occupied' ? (current?.state === 'occupied' ? current.nameTag : null) : null,
      note: current?.note ?? null,
    });

    drawRoom(bed.roomId);
    // A free bed is a complete answer on its own; an occupied one is not, and
    // is not saved until it says whether it has a tag.
    if (state === 'free') queue(bed.bedId);
    drawFooter();
  }

  function setTag(bed, hasTag) {
    const current = answers.get(bed.bedId);
    if (!current) return;
    current.nameTag = current.nameTag === hasTag ? null : hasTag;
    drawRoom(bed.roomId);
    if (current.nameTag !== null) queue(bed.bedId);
    drawFooter();
  }

  function setNote(bed, text) {
    const current = answers.get(bed.bedId) ?? { state: null, nameTag: null, note: null };
    current.note = text.trim() || null;
    answers.set(bed.bedId, current);
    // A note on a bed with no answer yet has nothing to attach to, so it waits
    // until the bed is answered.
    if (complete(bed.bedId)) queue(bed.bedId);
    drawFooter();
  }

  /** Answered fully enough to be worth sending. */
  function complete(bedId) {
    const answer = answers.get(bedId);
    if (!answer) return false;
    return answer.state === 'free' || answer.nameTag !== null;
  }

  // -------------------------------------------------------------- drawing --

  const roomBodies = new Map();

  function bedRow(bed) {
    const answer = answers.get(bed.bedId);
    const state = answer?.state ?? null;
    const tag = answer?.nameTag ?? null;
    const needsTag = state === 'occupied' && tag === null;

    const choice = (label, value, cls) => h('button.hk-choice', {
      class: `hk-choice ${cls}${state === value ? ' on' : ''}`,
      onclick: () => setState(bed, value),
      'aria-pressed': state === value ? 'true' : 'false',
    }, label);

    const tagChoice = (label, value, cls) => h('button.hk-tag', {
      class: `hk-tag ${cls}${tag === value ? ' on' : ''}`,
      onclick: () => setTag(bed, value),
      'aria-pressed': tag === value ? 'true' : 'false',
    }, label);

    const noteOpen = Boolean(answer?.note);
    const noteInput = h('input.hk-note-input', {
      type: 'text',
      value: answer?.note ?? '',
      placeholder: 'Anything worth noting about this bed',
      maxlength: 300,
      onchange: (e) => setNote(bed, e.target.value),
      onblur: (e) => setNote(bed, e.target.value),
    });
    const noteBox = h('div.hk-note', noteInput);
    if (!noteOpen) noteBox.style.display = 'none';

    return h('div.hk-bed', { class: `hk-bed${state ? ` answered ${state}` : ''}${needsTag ? ' asking' : ''}` },
      h('div.hk-bed-main',
        h('div.hk-bed-label',
          h('strong', bed.label),
          answer?.note ? h('span.hk-note-dot', { title: answer.note }, '✎') : null,
          // Shown only to somebody who can see the roster; the housekeeper
          // answering is deliberately not told what the answer should be.
          bed.expectedState
            ? h('small.muted', bed.expectedState === 'occupied' ? 'rostered occupied' : 'rostered free')
            : null,
        ),
        h('div.hk-choices',
          choice('Free', 'free', 'free'),
          choice('Occupied', 'occupied', 'occupied'),
        ),
        h('button.hk-note-btn', {
          title: 'Add a note',
          onclick: () => {
            noteBox.style.display = noteBox.style.display === 'none' ? '' : 'none';
            if (noteBox.style.display === '') noteInput.focus();
          },
        }, '✎'),
      ),

      state === 'occupied'
        ? h('div.hk-followup',
          h('span.hk-followup-q', 'Does it have a name tag?'),
          h('div.hk-choices',
            tagChoice('Yes', true, 'yes'),
            tagChoice('No', false, 'no'),
          ),
        )
        : null,

      noteBox,
    );
  }

  function roomSummary(room) {
    const beds = room.beds;
    const answered = beds.filter((b) => complete(b.bedId)).length;
    const untagged = beds.filter((b) => {
      const a = answers.get(b.bedId);
      return a?.state === 'occupied' && a.nameTag === false;
    }).length;

    return h('span.hk-room-sum',
      answered === beds.length
        ? h('span.pill.good', 'done')
        : h('span.pill', `${answered}/${beds.length}`),
      untagged ? h('span.pill.bad', `${untagged} without a tag`) : null,
    );
  }

  function drawRoom(roomId) {
    const room = data.rooms.find((r) => r.roomId === roomId);
    const body = roomBodies.get(roomId);
    if (!room || !body) return;
    mount(body, room.beds.map(bedRow));

    const head = body.previousElementSibling;
    if (head) {
      const sum = head.querySelector('.hk-room-sum');
      if (sum) sum.replaceWith(roomSummary(room));
    }
  }

  function drawRooms() {
    roomBodies.clear();

    if (!data.rooms.length) {
      mount(roomsHost, h('div.card.empty',
        h('h3', 'No dorm rooms yet'),
        h('p', 'A manager adds the rooms and their beds under Housekeeping setup. '
          + 'Once they are there, this screen lists every bed to walk.'),
      ));
      return;
    }

    mount(roomsHost, data.rooms.map((room) => {
      const body = h('div.hk-beds');
      roomBodies.set(room.roomId, body);
      body.append(...room.beds.map(bedRow));
      if (!openRooms.has(room.roomId)) body.style.display = 'none';

      const head = h('button.hk-room-head', {
        class: openRooms.has(room.roomId) ? 'hk-room-head open' : 'hk-room-head',
        onclick: (event) => {
          const open = openRooms.has(room.roomId);
          if (open) openRooms.delete(room.roomId);
          else openRooms.add(room.roomId);
          body.style.display = open ? 'none' : '';
          event.currentTarget.classList.toggle('open', !open);
        },
      },
        h('span.hk-room-name',
          h('strong', room.name),
          room.block ? h('small.muted', room.block) : null,
        ),
        roomSummary(room),
        // The whole point of a dorm room in daylight: everybody is out, every
        // bed is empty, and answering that should be one tap rather than eight.
        h('span.hk-room-all', {
          title: 'Mark every bed in this room free',
          role: 'button',
          onclick: (event) => {
            event.stopPropagation();
            for (const bed of room.beds) {
              answers.set(bed.bedId, { state: 'free', nameTag: null, note: answers.get(bed.bedId)?.note ?? null });
              pending.add(bed.bedId);
            }
            drawRoom(room.roomId);
            scheduleFlush();
          },
        }, 'All free'),
        h('span.hk-caret', '▾'),
      );

      return h('section.card.hk-room', head, body);
    }));
  }

  function drawFooter() {
    const answered = allBeds.filter((b) => complete(b.bedId)).length;
    const asking = allBeds.filter((b) => {
      const a = answers.get(b.bedId);
      return a?.state === 'occupied' && a.nameTag === null;
    }).length;

    progressEl.textContent = `${answered} of ${allBeds.length} beds`;

    statusEl.className = 'hk-status';
    if (asking) {
      statusEl.textContent = `${asking} waiting on the name tag question`;
      statusEl.classList.add('warn');
    } else if (failed) {
      statusEl.textContent = 'Not saved — it will be sent again';
      statusEl.classList.add('bad');
    } else if (pending.size) {
      statusEl.textContent = 'Saving…';
    } else if (saving) {
      statusEl.textContent = 'Saving…';
    } else if (answered) {
      statusEl.textContent = data.submitted ? 'Submitted · changes saved' : 'Saved on this phone and on the server';
      statusEl.classList.add('good');
    } else {
      statusEl.textContent = 'Nothing recorded yet';
    }

    submitBtn.disabled = !answered;
    submitBtn.textContent = data.submitted
      ? 'Submit again'
      : `Submit the ${(here?.short ?? 'round').toLowerCase()} check`;
  }

  // ------------------------------------------------------------- submitting --

  async function submit(event) {
    // Anything still queued goes first: submitting a round that is missing the
    // last three beds because they were still in flight is the one way this
    // screen could lie. A save already on the wire is waited out too — an empty
    // queue is not the same as a landed one.
    clearTimeout(saveTimer);
    while (saving) await new Promise((resolve) => setTimeout(resolve, 120));
    await flush();
    if (pending.size || saving) {
      toast('Some answers have not reached the server yet. Try again in a moment.', 'bad');
      return;
    }

    const answered = allBeds.filter((b) => complete(b.bedId)).length;
    const missing = allBeds.length - answered;
    if (missing > 0) {
      const ok = window.confirm(
        `${missing} ${missing === 1 ? 'bed has' : 'beds have'} no answer yet. `
        + `They will be reported as not checked in the ${(here?.short ?? 'this').toLowerCase()} `
        + 'check. Submit anyway?',
      );
      if (!ok) return;
    }

    event.target.disabled = true;
    event.target.textContent = 'Submitting…';
    try {
      const result = await api.hkSubmitRound(data.day, data.slot);
      toast(
        result.findings
          ? `Round submitted — ${result.findings} ${result.findings === 1 ? 'bed needs' : 'beds need'} attention`
          : 'Round submitted — every bed checked was as it should be',
        result.findings ? '' : 'good',
      );
      mount(host, await renderHkCheck({ day: data.day, slot: data.slot }));
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
      drawFooter();
    }
  }

  // A round left half-finished on a locked phone is the commonest way an
  // answer is lost, so anything outstanding is pushed as the page goes away.
  // One pair of listeners for the app's lifetime, pointed at whichever round is
  // currently on screen — re-registering per render would leak a pair per
  // redraw and leave stale rounds listening.
  activeFlush = () => { if (pending.size) flush(); };

  // Which of the three this is. Read by the footer and the submit button, so it
  // has to exist before the first draw.
  const here = (data.rounds ?? []).find((r) => r.slot === data.slot);

  drawRooms();
  drawFooter();

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', here?.label ?? 'Bed check'),
        h('div.sub', `${fmtDay(data.day, { withYear: true })}`
          + `${here?.by ? ` · ${here.by}` : ''}`
          + `${data.submitted ? ` · submitted by ${data.round?.submittedBy ?? 'someone'}` : ''}`),
      ),
      h('div.btn-row',
        data.day !== data.today
          ? h('button.btn-sm', {
            onclick: async () => mount(host, await renderHkCheck({ day: data.today, slot: data.slot })),
          }, 'Back to today')
          : null,
      ),
    ),

    // Three checks a day, each its own report. The one the clock is in opens
    // by default, so the ordinary case needs no thought at all.
    h('div.hk-slots', (data.rounds ?? []).map((r) => h('button.hk-slot', {
      class: `hk-slot${r.slot === data.slot ? ' on' : ''}${r.submitted ? ' done' : ''}`,
      onclick: async () => {
        if (r.slot === data.slot) return;
        clearTimeout(saveTimer);
        await flush();
        mount(host, await renderHkCheck({ day: data.day, slot: r.slot }));
      },
    },
      h('span.hk-slot-name', r.short),
      h('span.hk-slot-by', r.by),
      h('span.hk-slot-state', r.submitted
        ? `✓ ${r.submittedBy ?? 'submitted'}`
        : r.started
          ? `${r.checked} of ${r.expected} beds`
          : 'not started'),
    ))),

    data.submitted
      ? h('div.alert.info',
        h('span.alert-icon', 'ℹ️'),
        h('div',
          h('div.alert-title', 'This round has already been submitted'),
          h('div.alert-detail', 'You can still correct an answer. Submitting again sends an updated summary.'),
        ))
      : null,

    roomsHost,

    card('Earlier rounds', { note: 'Open one to correct something' },
      h('div.hk-recent', (data.recent ?? []).map((r) => h('button.btn-sm', {
        class: r.day === data.day && r.slot === data.slot ? 'btn-sm btn-primary' : 'btn-sm',
        onclick: async () => mount(host, await renderHkCheck({ day: r.day, slot: r.slot })),
      }, `${fmtDay(r.day)} · ${r.slotLabel}`, r.submittedAt ? ' ✓' : ' …')))),

    h('div.hk-footer',
      h('div.hk-footer-inner',
        h('div.hk-footer-text', progressEl, statusEl),
        submitBtn,
      )),
  );

  return host;
}
