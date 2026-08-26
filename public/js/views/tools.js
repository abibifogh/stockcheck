import { api } from '../api.js';
import { can } from '../app.js';
import { fmtDay, h, mount, toast } from '../util.js';
import { card, nextSort, sortHeader, sorted, statTile, table } from './components.js';

/**
 * The tool store: what is out, with whom, and where.
 *
 * Ordered by that question rather than by the register. A store keeper opening
 * this wants to know what has not come back — the alphabetical list of every
 * spanner is the thing they look at second.
 */
export async function renderMxTools() {
  const [data, areas] = await Promise.all([
    api.tools().catch(() => null),
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
              'Run 0019_tools.sql from migrations/console/ against the database, and the tool '
              + 'register will start working. Nothing else is affected.'),
          )),
      ));
    return host;
  }

  const tools = data.tools ?? [];
  const out = tools.filter((t) => t.out);
  const now = Date.now();
  const isLate = (t) => t.out && new Date(`${t.out.dueBackAt.replace(' ', 'T')}Z`).getTime() < now;
  const late = out.filter(isLate);

  let sort = { key: null, dir: 'asc' };
  const onSort = (key) => { sort = nextSort(sort, key, { numeric: [] }); paint(); };

  const issueTool = (tool) => async () => {
    const who = prompt(`Who is taking ${tool.name}?`);
    if (who === null || !who.trim()) return;

    const list = (areas.areas ?? []).filter((a) => a.active);
    const where = list.length
      ? prompt(`Where are they working?\n\n${list.slice(0, 30).map((a) => a.name).join(', ')}`
        + '\n\nType the room or area, or leave blank if it is not on site.')
      : null;
    if (where === null && list.length) return;

    const match = list.find((a) => a.name.toLowerCase() === String(where ?? '').trim().toLowerCase());
    if (where && where.trim() && !match) {
      toast(`No room or area called “${where.trim()}”`, 'bad');
      return;
    }

    try {
      const result = await api.issueTool(tool.id, {
        issuedTo: who.trim(),
        areaId: match?.id ?? null,
      });
      toast(`${tool.name} out to ${who.trim()} — due back ${String(result.dueBackAt).slice(0, 16)}`, 'good');
      reload();
    } catch (err) { toast(err.message, 'bad'); }
  };

  const returnTool = (tool) => async () => {
    const note = prompt(`Take ${tool.name} back from ${tool.out.issuedTo}?\n\n`
      + 'Anything worth noting about its condition (optional):');
    if (note === null) return;
    try {
      const result = await api.returnTool(tool.id, { returnNote: note.trim() || null });
      toast(result.wasOverdue ? `${tool.name} back — it had been chased` : `${tool.name} back`, 'good');
      reload();
    } catch (err) { toast(err.message, 'bad'); }
  };

  const showHistory = (tool) => async () => {
    try {
      const { movements } = await api.toolHistory(tool.id);
      openHistory(tool, movements);
    } catch (err) { toast(err.message, 'bad'); }
  };

  const whoCell = (_v, t) => (t.out
    ? h('div',
      h('div', h('strong', t.out.issuedTo)),
      h('small.muted', t.out.areaName ?? 'not on site'))
    : h('span.muted', 'in the store'));

  const paint = () => {
    const rows = sort.key
      ? sorted(tools, sort, {
        value: (t, k) => {
          if (k === 'who') return t.out?.issuedTo ?? '';
          if (k === 'since') return t.out?.issuedAt ?? '';
          return t[k];
        },
      })
      : [...out.filter(isLate), ...out.filter((t) => !isLate(t)), ...tools.filter((t) => !t.out)];

    mount(host,
      h('div.page-head',
        h('div',
          h('h1', 'Tools'),
          h('div.sub', 'What is out, with whom, and where they are working'),
        ),
      ),

      h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
        statTile({ label: 'Out now', value: String(out.length), sub: `of ${tools.length} tools` }),
        statTile({
          label: 'Overdue',
          value: String(late.length),
          sub: late.length ? `past ${data.graceHours} hours` : 'nothing late',
          accent: late.length ? 'var(--bad)' : 'var(--good)',
        }),
        statTile({ label: 'In the store', value: String(tools.length - out.length), sub: 'on the shelf' }),
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
          { key: 'name', label: sortHeader('Tool', 'name', sort, onSort), cls: 'wrap' },
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
        can('tools_setup')
          ? h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
            'Add and retire tools under Tools → Register. A tool that is out cannot be retired '
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
