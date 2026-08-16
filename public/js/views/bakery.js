import { api } from '../api.js';
import { fmtDay, fmtNum, h, mount, toast } from '../util.js';
import { card } from './components.js';

/**
 * The bakery form.
 *
 * Reached two ways and the same either way: through a link with no account
 * behind it, or by a signed-in baker. The link is the one that matters — a
 * report after a bake only happens if reporting takes fifteen seconds and
 * needs nothing remembered.
 *
 * So: the day is already filled in, and the quantities are the only thing
 * anybody types. There is one bake to report, and whose link it is already
 * says who is reporting, so neither is worth a question.
 */

/**
 * @param submit  ({ day, lines, note }) => Promise
 * @param data    { today, items, recent, label, propertyName }
 */
export function productionForm(data, submit) {
  const host = h('div');
  // One oven, two destinations. Breakfast's loaves reach the shelf and the
  // morning sheet draws against them; the bistro's are recorded and go nowhere
  // near breakfast's stock or its costs.
  const forBreakfast = new Map();
  const forBistro = new Map();
  const totalFor = (id) => (forBreakfast.get(id) ?? 0) + (forBistro.get(id) ?? 0);

  const day = h('input', { type: 'date', value: data.today, max: data.today });
  const note = h('input', { type: 'text', placeholder: 'Anything worth noting (optional)', maxlength: 300 });

  // Only some of what comes out of the oven goes to the bistro. If none of it
  // does, the form is a single column again and says nothing about a bistro at
  // all — labelling one box "Breakfast" explains nothing when there is no other.
  const anyBistro = data.items.some((i) => i.bistro);

  const rows = data.items.map((item) => {
    // The same stepper twice, told which basket it fills. Two near-identical
    // copies of this would be two places to fix the next time it changes.
    const stepper = (store) => {
      const box = h('input.bake-qty', {
        type: 'number', min: '0', step: String(item.step || 1),
        inputmode: 'decimal', placeholder: '0',
        oninput: (e) => {
          const value = Number(e.target.value);
          if (e.target.value === '' || !Number.isFinite(value) || value <= 0) store.delete(item.id);
          else store.set(item.id, value);
          refresh();
        },
      });

      const step = (by) => () => {
        const next = Math.max(0, Math.round(((Number(box.value) || 0) + by) * 1000) / 1000);
        box.value = next ? String(next) : '';
        if (next > 0) store.set(item.id, next); else store.delete(item.id);
        refresh();
      };

      return {
        box,
        node: h('div.mx-step',
          h('button', { type: 'button', onclick: step(-(item.step || 1)) }, '−'),
          box,
          h('button', { type: 'button', onclick: step(item.step || 1) }, '+'),
        ),
      };
    };

    const breakfast = stepper(forBreakfast);
    const bistro = item.bistro ? stepper(forBistro) : null;

    return {
      item,
      boxes: bistro ? [breakfast.box, bistro.box] : [breakfast.box],
      node: h('div.bake-row',
        h('div.bake-name', h('strong', item.name), h('span.muted', ` (${item.unit})`)),
        anyBistro
          ? h('div.bake-dests',
            h('label.bake-dest', h('span', 'Breakfast'), breakfast.node),
            // An empty cell rather than no cell, so the Breakfast boxes stay in
            // one column down a list where only one row has a second box.
            bistro
              ? h('label.bake-dest', h('span', 'Bistro'), bistro.node)
              : h('div.bake-dest'),
          )
          : breakfast.node,
      ),
    };
  });

  const summary = h('div.bake-summary');
  const button = h('button.btn-primary.bake-send', { disabled: true, onclick: send },
    'Send this report');

  const refresh = () => {
    const touched = rows.filter((r) => totalFor(r.item.id) > 0);
    button.disabled = touched.length === 0;
    button.textContent = 'Send this report';

    const list = (store) => rows
      .filter((r) => (store.get(r.item.id) ?? 0) > 0)
      .map((r) => `${fmtNum(store.get(r.item.id), 2)} ${r.item.name}`)
      .join(', ');
    const breakfastList = list(forBreakfast);
    const bistroList = list(forBistro);

    mount(summary, touched.length
      ? h('div',
        breakfastList
          ? h('div', 'Breakfast: ', h('strong', breakfastList))
          : h('div.muted', 'Nothing for breakfast.'),
        bistroList
          ? h('div', { style: { marginTop: '.2rem' } }, 'Bistro: ', h('strong', bistroList),
            h('span.muted', ' — not counted in breakfast'))
          : null,
      )
      : h('span.muted', 'Enter how many came out of the oven.'));
  };
  refresh();

  async function send(event) {
    const ids = new Set([...forBreakfast.keys(), ...forBistro.keys()]);
    if (!ids.size) return;
    event.target.disabled = true;
    event.target.textContent = 'Sending…';
    try {
      const result = await submit({
        day: day.value || data.today,
        note: note.value.trim() || null,
        lines: [...ids].map((ingredientId) => ({
          ingredientId,
          qty: forBreakfast.get(ingredientId) ?? 0,
          bistroQty: forBistro.get(ingredientId) ?? 0,
        })),
      });

      forBreakfast.clear();
      forBistro.clear();
      for (const row of rows) for (const box of row.boxes) box.value = '';
      note.value = '';
      // refresh() puts the button back to its resting label as well as its
      // resting state, so the two can never disagree.
      refresh();
      done(result);
      receipt.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
      refresh();
    }
  }

  // A confirmation that stays put. A toast disappears, and "did that go
  // through?" is the whole reason a bake gets reported twice.
  const receipt = h('div');
  const done = (result) => {
    mount(receipt, h('div.alert.good',
      h('span.alert-icon', '✅'),
      h('div',
        h('div.alert-title', `Recorded for ${fmtDay(result.day)}`
          + (result.replaced ? ' — this replaced the earlier report' : '')),
        h('div.alert-detail', `${result.summary}. It is on the breakfast shelf now — `
          + 'the kitchen will draw against it in the morning.'),
        result.bistroSummary
          ? h('div.alert-detail', { style: { marginTop: '.25rem' } },
            `For the bistro: ${result.bistroSummary}. Recorded, and kept out of breakfast.`)
          : null,
      ),
    ));
  };

  mount(host,
    receipt,
    card('What came out of the oven', {
      wide: true,
      note: data.items.length ? `${data.items.length} things you bake` : null,
    },
      data.items.length
        ? h('div',
          h('div.field-row',
            h('label.field', h('span', 'Date'), day),
          ),
          h('div.bake-list', { style: { marginTop: '1rem' } }, rows.map((r) => r.node)),
          h('label.field', { style: { marginTop: '.8rem' } }, h('span', 'Note'), note),
          h('div.bake-foot',
            summary,
            button,
          ),
        )
        : h('div.empty',
          h('p', 'Nothing has been marked as baked in-house yet.'),
          h('p.muted', { style: { fontSize: '.85rem' } },
            'A manager ticks “Made in our bakery” against the bread items under Setup, '
            + 'and they will appear here.')),
    ),
    data.recent?.length ? recentCard(data.recent) : null,
  );

  return host;
}

function recentCard(recent) {
  return card('Already sent', { note: 'So you can see whether today’s report went in' },
    h('div.mx-recent', recent.slice(0, 20).map((r) => h('div.mx-recent-row',
      h('span.muted', String(r.at ?? '').slice(11, 16)),
      // Reports sent back when the form asked which cycle still carry one, and
      // still say so. Nothing new sets it.
      r.cycle ? h('span.pill', r.cycle) : null,
      r.destination === 'bistro' ? h('span.pill', 'bistro') : null,
      h('strong', `${fmtNum(r.qty, 2)} ${r.unit}`),
      h('span', r.name),
      r.producedBy ? h('span.muted', `· ${r.producedBy}`) : null,
    ))),
  );
}

// ---------------------------------------------------------------------------
// Behind the link
// ---------------------------------------------------------------------------

/**
 * The whole page for somebody arriving on /bake?t=…
 *
 * Standalone: no menu, no sign-in, nothing else reachable from it. It is a
 * form and a confirmation, which is all a bakery needs and all this link is
 * allowed to do.
 */
export async function renderBakeryLink(token) {
  const host = h('div.bake-page');

  if (!token) {
    mount(host, brokenLink('This link is missing its code.',
      'Use the full link exactly as it was sent to you — it ends in a long string of letters.'));
    return host;
  }

  let data;
  try {
    data = await api.bakeryOpen(token);
  } catch (err) {
    mount(host, brokenLink('This link is not working', err.message));
    return host;
  }

  mount(host,
    h('header.bake-head',
      h('div.brand',
        h('span.brand-mark', '🥖'),
        h('div', data.propertyName,
          h('span.brand-sub', `Bakery — ${data.label}`)),
      ),
    ),
    h('main.bake-main',
      productionForm(
        data,
        (payload) => api.bakerySubmit({ token, ...payload }),
      ),
      h('p.muted', { style: { fontSize: '.8rem', textAlign: 'center', marginTop: '1.2rem' } },
        'This link only sends what you have baked. It shows no costs and nothing else '
        + 'about the hotel. Bookmark it — it is the same link every time.'),
    ),
  );

  return host;
}

function brokenLink(title, detail) {
  return h('div.bake-broken',
    h('div.card',
      h('h1', { style: { fontSize: '1.2rem' } }, title),
      h('p.muted', detail),
      h('p.muted', { style: { fontSize: '.85rem' } },
        'Ask whoever runs the hotel system for a new link.'),
    ),
  );
}

// ---------------------------------------------------------------------------
// Signed in
// ---------------------------------------------------------------------------

export async function renderProduction() {
  const data = await api.bakeryForm();
  const host = h('div');

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Bakery'),
        h('div.sub', 'What came out of the oven. It goes straight onto the breakfast shelf.'),
      ),
    ),
    // Deliberately not re-rendering after a send. The confirmation is the
    // point, and replacing the page would take it away at the moment somebody
    // is looking for it — which is how a bake ends up reported twice.
    productionForm(data, (payload) => api.createProduction(payload)),
  );

  return host;
}
