import { api } from '../api.js';
import { confirmAction, h, mount, toast } from '../util.js';
import { card, table } from './components.js';

/**
 * The dorms and their beds.
 *
 * Just the furniture. The roster used to sit here too, when it was one standing
 * value per bed — but a roster is a different thing now, written per night and
 * confirmed the next morning, and it changes several times a day while this
 * screen changes a few times a year. They belong apart, and the Roster screen
 * is where it lives.
 */
export async function renderHkSetup() {
  const [data, me] = await Promise.all([api.hkRooms(), api.me()]);
  const host = h('div');
  const reload = async () => mount(host, await renderHkSetup());

  const totalBeds = data.rooms.reduce((n, r) => n + r.beds.filter((b) => b.active).length, 0);

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Housekeeping setup'),
        h('div.sub', `${data.rooms.filter((r) => r.active).length} rooms · ${totalBeds} beds`),
      ),
    ),

    propertyCard(me.settings ?? {}),
    addRoomCard(reload),

    ...data.rooms.map((room) => roomCard(room, reload)),

    data.rooms.length ? null : h('div.card.empty',
      h('h3', 'No dorm rooms yet'),
      h('p', 'Add the first room above. Give it its beds at the same time — the check screen '
        + 'lists beds, so a room without them has nothing to walk.'),
    ),
  );

  return host;
}

/**
 * What this property is called, and where it is.
 *
 * On the full site these live in the breakfast setup screen; here that screen
 * does not exist, and both matter too much to leave unreachable. The name is on
 * every page and every email. The timezone decides which day a round belongs
 * to — set it wrong and this morning's check files itself against yesterday.
 */
function propertyCard(settings) {
  const name = h('input', {
    type: 'text', value: settings.property_name ?? '', maxlength: 100,
    placeholder: 'e.g. Abibifogh Hostel',
  });
  const timezone = h('input', {
    type: 'text', value: settings.timezone ?? 'Africa/Accra', maxlength: 60,
    placeholder: 'Africa/Accra',
  });

  const save = async (event) => {
    event.target.disabled = true;
    try {
      await api.hkUpdateSettings({
        propertyName: name.value.trim(),
        timezone: timezone.value.trim() || 'Africa/Accra',
      });
      toast('Saved — reload to see the new name at the top', 'good');
    } catch (err) {
      toast(err.message, 'bad');
    }
    event.target.disabled = false;
  };

  return card('This property', { note: 'Shown at the top of every screen and on every email' },
    h('div.field-row',
      h('label.field', h('span', 'Name'), name),
      h('label.field', h('span', 'Timezone'), timezone),
      h('div.field', h('span', ' '), h('button.btn-primary', { onclick: save }, 'Save')),
    ),
  );
}

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

function addRoomCard(reload) {
  const name = h('input', { type: 'text', placeholder: 'e.g. Dorm E', maxlength: 80 });
  const block = h('input', { type: 'text', placeholder: 'Floor or wing (optional)', maxlength: 60 });
  const bedCount = h('input', { type: 'number', value: '6', min: '0', max: '60' });
  const prefix = h('input', { type: 'text', value: 'Bed', maxlength: 30 });

  const add = async (event) => {
    if (!name.value.trim()) { toast('Give the room a name', 'bad'); return; }
    event.target.disabled = true;
    try {
      const result = await api.hkCreateRoom({
        name: name.value.trim(),
        block: block.value.trim() || null,
        bedCount: Number(bedCount.value) || 0,
        bedPrefix: prefix.value.trim() || 'Bed',
      });
      toast(`${result.room.name} added with ${result.beds} beds`, 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  return card('Add a dorm room', {
    note: 'The beds are numbered for you — six beds means Bed 1 through Bed 6',
  },
    h('div.field-row',
      h('label.field', h('span', 'Room name'), name),
      h('label.field', h('span', 'Floor or wing'), block),
      h('label.field', h('span', 'How many beds'), bedCount),
      h('label.field', h('span', 'Called'), prefix),
      h('div.field', h('span', ' '), h('button.btn-primary', { onclick: add }, 'Add room')),
    ),
  );
}

// ---------------------------------------------------------------------------
// One room
// ---------------------------------------------------------------------------

function roomCard(room, reload) {
  const beds = room.beds.filter((b) => b.active);

  // Every editable control for this room, held by bed id, so one Save button
  // can send the whole room in one pass rather than one request per keystroke.
  const labels = new Map();

  const bedRows = beds.map((bed) => {
    const label = h('input', { type: 'text', value: bed.label, maxlength: 40 });
    labels.set(bed.id, label);

    return {
      id: bed.id,
      label,
      remove: h('button.btn-ghost.btn-sm', {
        title: `Remove ${bed.label}`,
        onclick: async () => {
          if (!confirmAction(`Remove ${bed.label} from ${room.name}?`)) return;
          try {
            const result = await api.hkDeleteBed(bed.id);
            toast(result.retired
              ? `${bed.label} closed — its past checks are kept`
              : `${bed.label} removed`, 'good');
            reload();
          } catch (err) {
            toast(err.message, 'bad');
          }
        },
      }, '✕'),
    };
  });

  const save = async (event) => {
    event.target.disabled = true;
    event.target.textContent = 'Saving…';
    try {
      // Only the names that actually changed are sent.
      const renamed = beds.filter((bed) => labels.get(bed.id).value.trim() !== bed.label);
      for (const bed of renamed) {
        await api.hkUpdateBed(bed.id, {
          label: labels.get(bed.id).value.trim(),
          sortOrder: bed.sort_order,
          active: true,
        });
      }

      toast(renamed.length ? `${room.name} saved` : 'Nothing to save', renamed.length ? 'good' : 'warn');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
      event.target.textContent = 'Save this room';
    }
  };

  const newBed = h('input', { type: 'text', placeholder: 'e.g. Bed 7', maxlength: 40 });
  const addBed = async (event) => {
    if (!newBed.value.trim()) { toast('Give the bed a name', 'bad'); return; }
    event.target.disabled = true;
    try {
      await api.hkCreateBed({
        roomId: room.id,
        label: newBed.value.trim(),
        sortOrder: (beds.at(-1)?.sort_order ?? 0) + 10,
      });
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const bedTable = table([
    { key: 'label', label: 'Bed' },
    { key: 'remove', label: '', align: 'right' },
  ], bedRows, { empty: 'No beds in this room yet — add the first one below.' });

  return card(room.name, {
    wide: true,
    note: room.active
      ? `${beds.length} ${beds.length === 1 ? 'bed' : 'beds'}${room.block ? ` · ${room.block}` : ''}`
      : 'closed',
    actions: h('div.btn-row',
      h('button.btn-sm', { onclick: () => openRoomDialog(room, reload) }, 'Edit room'),
      h('button.btn-danger.btn-sm', {
        onclick: async () => {
          if (!confirmAction(`Remove ${room.name} and its beds?`)) return;
          try {
            const result = await api.hkDeleteRoom(room.id);
            toast(result.retired
              ? `${room.name} closed — its past checks are kept`
              : `${room.name} removed`, 'good');
            reload();
          } catch (err) {
            toast(err.message, 'bad');
          }
        },
      }, 'Remove'),
    ),
  },
    bedTable,

    h('div.field-row', { style: { marginTop: '.8rem' } },
      h('label.field', h('span', 'Add another bed'), newBed),
      h('div.field', h('span', ' '), h('button.btn-sm', { onclick: addBed }, 'Add bed')),
      h('div.field', h('span', ' '), h('button.btn-primary', { onclick: save }, 'Save this room')),
    ),

    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
      'Who is expected in each bed is set on the Roster screen, night by night — it changes daily, '
      + 'and this screen barely changes at all.'),
  );
}

function openRoomDialog(room, reload) {
  const name = h('input', { type: 'text', value: room.name, maxlength: 80 });
  const block = h('input', { type: 'text', value: room.block ?? '', maxlength: 60 });
  const order = h('input', { type: 'number', value: String(room.sort_order ?? 100), min: '0' });
  const note = h('input', { type: 'text', value: room.note ?? '', maxlength: 300, placeholder: 'Anything worth knowing about this room' });
  const active = h('select',
    h('option', { value: '1' }, 'In use'),
    h('option', { value: '0' }, 'Closed — leave out of the check'),
  );
  active.value = room.active ? '1' : '0';

  const dialog = h('dialog', {
    style: {
      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      background: 'var(--surface)', color: 'var(--text)',
      maxWidth: '560px', width: '92vw', padding: '1.2rem',
    },
  },
    h('div.card-head',
      h('h2', `Edit ${room.name}`),
      h('button.btn-sm.btn-ghost', { onclick: () => dialog.close() }, '✕'),
    ),
    h('div.field-row',
      h('label.field', h('span', 'Name'), name),
      h('label.field', h('span', 'Floor or wing'), block),
      h('label.field', h('span', 'Order in the list'), order),
      h('label.field', h('span', 'Status'), active),
    ),
    h('label.field', h('span', 'Note'), note),
    h('div.btn-row', { style: { marginTop: '1rem', justifyContent: 'flex-end' } },
      h('button', { onclick: () => dialog.close() }, 'Cancel'),
      h('button.btn-primary', {
        onclick: async (event) => {
          event.target.disabled = true;
          try {
            await api.hkUpdateRoom(room.id, {
              name: name.value.trim(),
              block: block.value.trim() || null,
              sortOrder: Number(order.value) || 100,
              note: note.value.trim() || null,
              active: active.value === '1',
            });
            dialog.close();
            toast('Room saved', 'good');
            reload();
          } catch (err) {
            toast(err.message, 'bad');
            event.target.disabled = false;
          }
        },
      }, 'Save'),
    ),
  );

  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}
