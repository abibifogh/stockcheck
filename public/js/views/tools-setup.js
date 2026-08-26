import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { card, table } from './components.js';

/**
 * The tool register: which tools exist, not where they are.
 *
 * Its own screen rather than a card on the parts store's setup, because a tool
 * store is its own thing. The two share the rooms and areas — a drill is taken
 * to the same Room 214 a tap washer is fitted in, and keeping two lists of the
 * property's rooms would guarantee they disagreed — and share nothing else.
 */
export async function renderToolsSetup() {
  const [loaded, bootstrap] = await Promise.all([
    api.tools().catch(() => null),
    // Only for the category list. A tool store with no parts store still works;
    // it simply offers no categories.
    api.mxBootstrap().catch(() => ({ categories: [] })),
  ]);
  const host = h('div');
  const reload = async () => mount(host, await renderToolsSetup());

  const head = h('div.page-head',
    h('div',
      h('h1', 'Tool register'),
      h('div.sub', 'Which tools exist. Where they are is the tool store.'),
    ));

  if (!loaded || loaded.ready === false) {
    mount(host, head,
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

  const tools = loaded.tools ?? [];
  const categories = bootstrap.categories ?? [];

  const name = h('input', { type: 'text', placeholder: 'e.g. Impact drill', maxlength: 100 });
  const tag = h('input', { type: 'text', placeholder: 'Asset tag (optional)', maxlength: 40 });
  const category = h('select',
    h('option', { value: '' }, 'No category'),
    categories.map((c) => h('option', { value: String(c.id) }, c.name)));
  const note = h('input', { type: 'text', placeholder: 'Anything worth knowing', maxlength: 300 });

  const add = async (event) => {
    if (!name.value.trim()) { toast('Give the tool a name', 'bad'); return; }
    event.target.disabled = true;
    try {
      await api.createTool({
        name: name.value.trim(),
        tag: tag.value.trim() || null,
        categoryId: category.value || null,
        note: note.value.trim() || null,
      });
      toast('Tool added', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const retire = (tool) => async () => {
    if (!confirm(`Retire ${tool.name}?\n\n`
      + 'It leaves the register, and every journey it has made is kept.')) return;
    try {
      await api.retireTool(tool.id);
      toast('Retired — its history is kept', 'good');
      reload();
    } catch (err) { toast(err.message, 'bad'); }
  };

  mount(host, head,
    card('Add a tool', {
      wide: true,
      note: 'Something that comes back, as opposed to a part that is used up',
    },
      h('div.field-row',
        h('label.field', h('span', 'Name'), name),
        h('label.field', h('span', 'Asset tag'), tag),
        h('label.field', h('span', 'Category'), category),
        h('label.field', h('span', 'Note'), note),
      ),
      h('button.btn-primary', { style: { marginTop: '.8rem' }, onclick: add }, 'Add tool'),
      h('p.muted', { style: { fontSize: '.82rem', marginTop: '.8rem', marginBottom: 0 } },
        'Two identical drills are two tools. The asset tag is what tells them apart on a shelf '
        + 'and in a report, so a store with more than one of anything wants them stencilled.'),
    ),

    card('Every tool', { wide: true, note: `${tools.length} in the register` },
      table([
        { key: 'name', label: 'Tool', cls: 'wrap' },
        { key: 'tag', label: 'Tag', format: (v) => (v ? h('code.mono', v) : h('span.muted', '—')) },
        { key: 'categoryName', label: 'Category', cls: 'wrap', format: (v) => v || h('span.muted', '—') },
        {
          key: 'out',
          label: 'Where',
          cls: 'wrap',
          format: (v) => (v
            ? h('span', h('span.pill.warn', 'out'), ` with ${v.issuedTo}`)
            : h('span.muted', 'in the store')),
        },
        { key: 'note', label: 'Note', cls: 'wrap', format: (v) => v || h('span.muted', '—') },
        {
          key: 'id',
          label: '',
          format: (_v, t) => h('button.btn-sm.btn-ghost', { onclick: retire(t) }, 'Retire'),
        },
      ], tools, { empty: 'No tools yet. Add the first one above.' }),
      h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
        'A tool that is out cannot be retired until it comes back — it is in somebody’s van, and '
        + 'saying otherwise would lose the only record of that. Retiring keeps every journey it '
        + 'has made: who had it, where, and for how long.'),
    ),
  );

  return host;
}
