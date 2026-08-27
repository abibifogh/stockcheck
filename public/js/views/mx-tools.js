import { api } from '../api.js';
import { can } from '../app.js';
import { fmtDay, h, mount, toast } from '../util.js';
import { card, modal, nextSort, sortHeader, sorted, statTile, table } from './components.js';

/**
 * The tool store: what is out, with whom, and where.
 *
 * Ordered by that question rather than by the register. A store keeper opening
 * this wants to know what has not come back — the alphabetical list of every
 * spanner is the thing they look at second.
 */
export async function renderMxTools() {
  const [data, areas] = await Promise.all([
    api.mxTools().catch(() => null),
    api.mxAreas().catch(() => ({ areas: [] })),
  ]);
  const host = h('div');
  const reload = async () => mount(host, await renderMxTools());

  if (!data || data.ready === false) {
    mount(host,
      h('div.page-head', h('div', h('h1', 'Tools'))),
      card('Tools', { wide: true, note: 'Waiting on a database update' },
        h('div.alert.warn',
          h('span.alert-icon', '⚠️'),
          h('div',
            h('div.alert-title', 'This part of the site is ready, its tables are not'),
            h('div.alert-detail',
              'Run 0019_mx_tools.sql and 0020_tool_accessories.sql from migrations/console/ against '
              + 'the database, and the tool store will start working. Nothing else is affected.'),
          )),
      ));
    return host;
  }

  const tools = data.tools ?? [];
  // Accessories are nested under their parent for display and counted in the
  // flat list for everything else — "3 of 11 out" means eleven things that can
  // go missing, not eleven drills.
  const flat = data.all ?? tools;
  const byId = new Map(flat.map((t) => [t.id, t]));
  const out = flat.filter((t) => t.out);
  const now = Date.now();
  const isLate = (t) => t.out && new Date(`${t.out.dueBackAt.replace(' ', 'T')}Z`).getTime() < now;
  const late = out.filter(isLate);

  let sort = { key: null, dir: 'asc' };
  const onSort = (key) => { sort = nextSort(sort, key, { numeric: [] }); paint(); };

  const issueTool = (tool) => () => openIssue(tool, areas.areas ?? [], reload);
  const returnTool = (tool) => () => openReturn(tool, byId, reload);

  const showHistory = (tool) => async () => {
    try {
      const { movements } = await api.mxToolHistory(tool.id);
      openHistory(tool, movements);
    } catch (err) { toast(err.message, 'bad'); }
  };

  const whoCell = (_v, t) => (t.out
    ? h('div',
      h('div', h('strong', t.out.issuedTo)),
      h('small.muted', t.out.areaName ?? 'not on site'))
    : h('span.muted', 'in the store'));

  const paint = () => {
    // Sorting flattens the tree deliberately: "show me everything overdue"
    // is a question about tools, and hiding a late charger under a drill that
    // came back on time would be answering a different one.
    const rows = sort.key
      ? sorted(flat, sort, {
        value: (t, k) => {
          if (k === 'who') return t.out?.issuedTo ?? '';
          if (k === 'since') return t.out?.issuedAt ?? '';
          return t[k];
        },
      })
      : [...tools.filter((t) => t.out && isLate(t)), ...tools.filter((t) => t.out && !isLate(t)),
        ...tools.filter((t) => !t.out)]
        .flatMap((t) => [t, ...(t.accessories ?? [])]);

    mount(host,
      h('div.page-head',
        h('div',
          h('h1', 'Tools'),
          h('div.sub', 'What is out, with whom, and where they are working'),
        ),
      ),

      h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
        statTile({ label: 'Out now', value: String(out.length), sub: `of ${flat.length} tools` }),
        statTile({
          label: 'Overdue',
          value: String(late.length),
          sub: late.length ? `past ${data.graceHours} hours` : 'nothing late',
          accent: late.length ? 'var(--bad)' : 'var(--good)',
        }),
        statTile({ label: 'In the store', value: String(flat.length - out.length), sub: 'on the shelf' }),
      ),

      late.length
        ? h('div.alert.warn', { style: { marginBottom: '1rem' } },
          h('span.alert-icon', '⚠️'),
          h('div',
            h('div.alert-title', `${late.length} ${late.length === 1 ? 'tool has' : 'tools have'} not come back`),
            h('div.alert-detail', late.map((t) => `${t.name} — ${t.out.issuedTo}`).join('; ')),
          ))
        : null,

      card('The tool store', {
        wide: true,
        note: 'Unsorted shows the late ones first, then what else is out',
      },
        table([
          {
            key: 'name',
            label: sortHeader('Tool', 'name', sort, onSort),
            cls: 'wrap',
            format: (v, t) => (t.parentToolId == null
              ? h('span', v, (t.accessories ?? []).length
                ? h('span.muted', { style: { fontWeight: '400' } },
                  ` +${t.accessories.length}`)
                : null)
              : h('span', { style: { paddingLeft: '1.1rem' } },
                h('span.muted', '\u21b3 '), v)),
          },
          { key: 'tag', label: sortHeader('Tag', 'tag', sort, onSort), format: (v) => (v ? h('code.mono', v) : h('span.muted', '—')) },
          { key: 'who', label: sortHeader('With', 'who', sort, onSort), cls: 'wrap', format: whoCell },
          {
            key: 'since',
            label: sortHeader('Since', 'since', sort, onSort),
            format: (_v, t) => (t.out
              ? h('div',
                h('div', fmtDay(t.out.issuedAt.slice(0, 10))),
                h('small.muted', t.out.issuedAt.slice(11, 16)))
              : h('span.muted', '—')),
          },
          {
            key: 'id',
            label: 'Due back',
            format: (_v, t) => {
              if (!t.out) return h('span.muted', '—');
              return isLate(t)
                ? h('span.pill.bad', 'overdue')
                : h('span.muted', String(t.out.dueBackAt).slice(0, 16));
            },
          },
          {
            key: 'id',
            label: '',
            format: (_v, t) => h('div.btn-row',
              t.out
                ? h('button.btn-sm.btn-primary', { onclick: returnTool(t) }, 'Take back')
                : h('button.btn-sm', { onclick: issueTool(t) }, 'Issue'),
              h('button.btn-sm.btn-ghost', { onclick: showHistory(t) }, 'History'),
            ),
          },
        ], rows, { empty: 'No tools in the register yet.' }),
        can('mx_setup')
          ? h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
            'Add and retire tools under Maintenance setup. A tool that is out cannot be retired '
            + 'until it comes back.')
          : null,
      ),
    );
  };

  paint();
  return host;
}

/** Everywhere one tool has been. */
function openHistory(tool, movements) {
  const dialog = h('dialog', {
    style: {
      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      background: 'var(--surface)', color: 'var(--text)',
      maxWidth: '720px', width: '94vw', padding: '1.2rem',
    },
  },
    h('div.card-head',
      h('h2', tool.name, tool.tag ? h('span.muted', ` · ${tool.tag}`) : null),
      h('button.btn-sm.btn-ghost', { onclick: () => dialog.close() }, '✕'),
    ),
    movements.length
      ? table([
        {
          key: 'issuedTo',
          label: 'Taken by',
          cls: 'wrap',
          format: (v, m) => h('div', h('div', v), h('small.muted', m.areaName ?? 'not on site')),
        },
        { key: 'issuedAt', label: 'Out', format: (v) => String(v).slice(0, 16) },
        {
          key: 'returnedAt',
          label: 'Back',
          format: (v, m) => (v
            ? h('div', h('div', String(v).slice(0, 16)),
              m.receivedBy ? h('small.muted', `to ${m.receivedBy}`) : null)
            : h('span.pill.warn', 'still out')),
        },
        {
          key: 'wasChased',
          label: '',
          format: (v) => (v ? h('span.pill.bad', 'was chased') : null),
        },
        {
          key: 'returnNote',
          label: 'Note',
          cls: 'wrap',
          format: (v, m) => v || m.note || h('span.muted', '—'),
        },
      ], movements)
      : h('div.empty', h('p', 'This tool has never left the store.')),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
      'Newest first. A tool that is chased every time it goes out is telling you something '
      + 'about a habit rather than about one afternoon.'),
    h('div.btn-row', { style: { marginTop: '1rem' } },
      h('button', { onclick: () => dialog.close() }, 'Close')),
  );

  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/**
 * Hand a tool over, and whatever goes with it.
 *
 * A form rather than the chain of prompts this used to be. The reason is the
 * accessories: "does the case go too" is a question with tick boxes, and three
 * prompts in a row is how somebody cancels half way and leaves a drill issued
 * to nobody.
 *
 * An accessory already out with somebody else is shown, ticked off and
 * explained, rather than hidden. Hiding it would make the case look like it had
 * never existed on the day somebody needs to know where it went.
 */
function openIssue(tool, areas, reload) {
  const who = h('input', { type: 'text', placeholder: 'Name of whoever is taking it', maxlength: 80 });
  const live = areas.filter((a) => a.active);
  const where = h('select',
    h('option', { value: '' }, 'Not on site / not recorded'),
    ...live.map((a) => h('option', { value: String(a.id) }, a.block ? `${a.name} — ${a.block}` : a.name)));
  const note = h('input', { type: 'text', placeholder: 'Anything worth noting (optional)', maxlength: 300 });
  const error = h('p.form-error');

  const spare = (tool.accessories ?? []).filter((a) => !a.out);
  const gone = (tool.accessories ?? []).filter((a) => a.out);
  const boxes = spare.map((a) => ({
    id: a.id,
    box: h('input', { type: 'checkbox', checked: true }),
    name: a.name,
  }));

  const save = async (event, dialog) => {
    if (!who.value.trim()) { error.textContent = 'Say who is taking it'; return; }
    event.target.disabled = true;
    try {
      const result = await api.mxIssueTool(tool.id, {
        issuedTo: who.value.trim(),
        areaId: where.value || null,
        note: note.value.trim() || null,
        accessoryIds: boxes.filter((b) => b.box.checked).map((b) => b.id),
      });
      const went = result.accessories?.length
        ? ` with ${result.accessories.length} ${result.accessories.length === 1 ? 'accessory' : 'accessories'}`
        : '';
      toast(`${tool.name}${went} out to ${who.value.trim()} — due back ${String(result.dueBackAt).slice(0, 16)}`, 'good');
      // Said separately and after, because it is the part somebody has to act
      // on: they are standing at the counter one item short.
      if (result.missed?.length) toast(result.missed.join('; '), 'bad');
      dialog.close();
      reload();
    } catch (err) {
      error.textContent = err.message;
      event.target.disabled = false;
    }
  };

  modal(`Issue ${tool.name}`, [
    h('label.field', h('span', 'Who is taking it'), who),
    h('label.field', h('span', 'Where they are working'), where),
    h('label.field', h('span', 'Note'), note),

    boxes.length
      ? h('div', { style: { marginTop: '.8rem' } },
        h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Goes with it'),
        ...boxes.map((b) => h('label.field.field-inline', b.box, h('span', b.name))),
        h('p.muted', { style: { fontSize: '.8rem', margin: '.4rem 0 0' } },
          'Each one is recorded as its own journey, so anything that does not come back with the '
          + 'tool can still be found.'))
      : null,

    gone.length
      ? h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem' } },
        `${gone.map((a) => `${a.name} is already out with ${a.out.issuedTo}`).join('; ')}.`)
      : null,

    error,
  ], save, { saveLabel: 'Issue' });
}

/**
 * Take it back in, and by default whatever went out on the same trip.
 *
 * Default, not forced. A charger left on a job overnight while the drill comes
 * back is an ordinary Tuesday, and the store keeper is the one who can see
 * which it is.
 */
function openReturn(tool, byId, reload) {
  const note = h('input', { type: 'text', placeholder: 'Condition, damage, anything owed (optional)', maxlength: 300 });
  const error = h('p.form-error');

  // What went out on this trip and is still out. Worked out here rather than
  // asked of the server, because the screen already knows.
  const alongside = (tool.accessories ?? [])
    .filter((a) => a.out && a.out.withMovementId === tool.out.movementId);
  const together = h('input', { type: 'checkbox', checked: true });

  const save = async (event, dialog) => {
    event.target.disabled = true;
    try {
      const result = await api.mxReturnTool(tool.id, {
        returnNote: note.value.trim() || null,
        withAccessories: alongside.length ? together.checked : undefined,
      });
      const also = result.accessories?.length ? ` and ${result.accessories.length} with it` : '';
      toast(result.wasOverdue
        ? `${tool.name} back${also} — it had been chased`
        : `${tool.name} back${also}`, 'good');
      if (result.stillOut?.length) toast(`Still out: ${result.stillOut.join(', ')}`, 'warn');
      dialog.close();
      reload();
    } catch (err) {
      error.textContent = err.message;
      event.target.disabled = false;
    }
  };

  modal(`Take ${tool.name} back`, [
    h('p.muted', { style: { marginTop: 0 } },
      `Out with ${tool.out.issuedTo}${tool.out.areaName ? ` at ${tool.out.areaName}` : ''} since `
      + `${String(tool.out.issuedAt).slice(0, 16)}.`),
    h('label.field', h('span', 'Note'), note),

    alongside.length
      ? h('div', { style: { marginTop: '.6rem' } },
        h('label.field.field-inline', together,
          h('span', `Take back the ${alongside.length === 1 ? 'accessory' : `${alongside.length} accessories`} `
            + 'that went out with it')),
        h('p.muted', { style: { fontSize: '.8rem', margin: '.3rem 0 0' } },
          alongside.map((a) => a.name).join(', ')))
      : null,

    error,
  ], save, { saveLabel: 'Take back' });
}
