import { api } from '../api.js';
import {
  attributeSearchText, attributeSummary, fmtDay, fmtQty, h, mount, toast, todayISO,
} from '../util.js';
import { card } from './components.js';

/**
 * Releasing parts to a room.
 *
 * This is the screen that decides whether the whole system gets used. A
 * technician is standing in a corridor holding a phone in one hand and a
 * screwdriver in the other; anything that needs typing will be done "later",
 * which means never, and the store will drift out of truth within a fortnight.
 *
 * So: tap the room, tap the parts, save. Three taps for the ordinary case.
 * Quantities default to one and are adjusted only when they are not one.
 * Nothing is required beyond the parts themselves — the room, the job number
 * and the note are all optional, because a half-recorded issue still tells you
 * the stock left the shelf.
 */
export async function renderMxIssue(params = {}) {
  const [data, recent] = await Promise.all([api.mxBootstrap(), api.mxIssues({ limit: 12 })]);

  const host = h('div');
  // Redrawing the whole screen after a request is sent, so "Just recorded"
  // shows the entry with its request now against it rather than as it was.
  const reload = async () => mount(host, await renderMxIssue({ areaId }));
  const basket = new Map(); // itemId -> qty
  // Kept across a save: somebody fixing room 214 usually has more than one
  // thing to record for room 214.
  let areaId = params.areaId ? Number(params.areaId) : null;
  let showAll = false;
  let itemFilter = '';
  let areaFilter = '';

  const jobRef = h('input', { type: 'text', placeholder: 'Job or ticket number (optional)', maxlength: 60 });
  const note = h('input', { type: 'text', placeholder: 'Note (optional)', maxlength: 300 });
  const day = h('input', { type: 'date', value: data.today, max: data.today });

  const areaHost = h('div');
  const itemHost = h('div');
  const basketHost = h('div.mx-basket');

  const rooms = data.areas.filter((a) => a.kind === 'room');
  const places = data.areas.filter((a) => a.kind === 'area');

  // ------------------------------------------------------------- where --

  const drawAreas = () => {
    const match = (a) => !areaFilter
      || a.name.toLowerCase().includes(areaFilter)
      || (a.block ?? '').toLowerCase().includes(areaFilter);

    const chip = (area) => h('button.mx-chip', {
      class: areaId === area.id ? 'mx-chip on' : 'mx-chip',
      onclick: () => { areaId = areaId === area.id ? null : area.id; drawAreas(); drawBasket(); },
    }, area.name);

    const shownRooms = rooms.filter(match);
    const shownPlaces = places.filter(match);

    mount(areaHost,
      h('input.mx-search', {
        type: 'search',
        placeholder: 'Find a room or area…',
        value: areaFilter,
        oninput: (e) => { areaFilter = e.target.value.trim().toLowerCase(); drawAreas(); },
      }),
      shownPlaces.length
        ? h('div', h('div.stat-label', { style: { margin: '.6rem 0 .35rem' } }, 'Areas'),
          h('div.mx-chips', shownPlaces.map(chip)))
        : null,
      shownRooms.length
        ? h('div', h('div.stat-label', { style: { margin: '.7rem 0 .35rem' } }, 'Rooms'),
          h('div.mx-chips', shownRooms.map(chip)))
        : null,
      !shownRooms.length && !shownPlaces.length
        ? h('p.muted', { style: { fontSize: '.87rem' } },
          rooms.length || places.length
            ? 'Nothing matches that.'
            : 'No rooms or areas set up yet. A manager can add them under Maintenance setup.')
        : null,
    );
  };

  // -------------------------------------------------------------- what --

  const add = (item, by = 1) => {
    const next = Math.round(((basket.get(item.id) ?? 0) + by) * 1000) / 1000;
    if (next <= 0) basket.delete(item.id);
    else basket.set(item.id, next);
    drawItems();
    drawBasket();
  };

  const drawItems = () => {
    const pool = showAll ? data.items : data.items.filter((i) => i.is_common);
    // Searching matches the details as well as the name: somebody looking for
    // the 9W bulb types "9W", not "LED Bulb".
    const shown = itemFilter
      ? data.items.filter((i) => i.name.toLowerCase().includes(itemFilter)
        || attributeSearchText(i.attributes).includes(itemFilter))
      : pool;

    mount(itemHost,
      h('input.mx-search', {
        type: 'search',
        placeholder: 'Find a part…',
        value: itemFilter,
        oninput: (e) => { itemFilter = e.target.value.trim().toLowerCase(); drawItems(); },
      }),
      h('div.mx-grid', shown.map((item) => {
        const qty = basket.get(item.id) ?? 0;
        return h('button.mx-tile', {
          class: qty ? 'mx-tile on' : 'mx-tile',
          onclick: () => add(item),
          title: [item.name, attributeSummary(item.attributes), `(${item.unit})`]
          .filter(Boolean).join(' · '),
        },
          h('span.mx-tile-name', item.name),
          // The variables are what tell two similar parts apart on a shelf, so
          // they belong on the tile rather than behind a tap.
          attributeSummary(item.attributes)
            ? h('span.mx-tile-attrs', attributeSummary(item.attributes))
            : null,
          h('span.mx-tile-unit', item.unit),
          qty ? h('span.mx-tile-qty', String(qty)) : null,
        );
      })),
      shown.length ? null : h('p.muted', { style: { fontSize: '.87rem' } }, 'Nothing matches that.'),
      itemFilter ? null : h('button.btn-sm', {
        style: { marginTop: '.6rem' },
        onclick: () => { showAll = !showAll; drawItems(); },
      }, showAll ? 'Show only the everyday parts' : `All items (${data.items.length})`),
    );
  };

  // ------------------------------------------------------------ basket --

  const drawBasket = () => {
    const lines = [...basket.entries()].map(([id, qty]) => ({
      item: data.items.find((i) => i.id === id),
      qty,
    })).filter((l) => l.item);

    const where = areaId ? data.areas.find((a) => a.id === areaId)?.name : null;

    mount(basketHost,
      h('div.mx-basket-inner',
        h('div.mx-basket-lines',
          lines.length
            ? lines.map(({ item, qty }) => h('div.mx-line',
              h('span.mx-line-name', item.name,
                attributeSummary(item.attributes)
                  ? h('small.muted', ` ${attributeSummary(item.attributes)}`)
                  : null),
              h('div.mx-step',
                h('button', { onclick: () => add(item, -1) }, '−'),
                h('input', {
                  type: 'number', value: String(qty), min: '0', step: 'any',
                  oninput: (e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v) || v <= 0) basket.delete(item.id);
                    else basket.set(item.id, v);
                    drawBasketCountOnly();
                  },
                  onblur: () => { drawItems(); drawBasket(); },
                }),
                h('button', { onclick: () => add(item, 1) }, '+'),
              ),
              h('span.mx-line-unit', item.unit),
              h('button.btn-ghost.btn-sm', { onclick: () => add(item, -qty) }, '✕'),
            ))
            : h('p.muted', { style: { margin: 0, fontSize: '.88rem' } },
              'Tap the parts you have used. They appear here.'),
        ),
        h('div.mx-basket-actions',
          h('div.mx-basket-where',
            where ? h('strong', where) : h('span.muted', 'No room chosen'),
            h('span.muted', ` · ${lines.length} ${lines.length === 1 ? 'item' : 'items'}`),
          ),
          h('button.btn-primary.mx-save', { disabled: !lines.length, onclick: save }, 'Record issue'),
        ),
      ),
    );
  };

  // Typing in a quantity box must not redraw the box the finger is in.
  const drawBasketCountOnly = () => {
    const label = basketHost.querySelector('.mx-basket-where span:last-child');
    if (label) label.textContent = ` · ${basket.size} ${basket.size === 1 ? 'item' : 'items'}`;
    const save = basketHost.querySelector('.mx-save');
    if (save) save.disabled = basket.size === 0;
  };

  async function save(event) {
    const lines = [...basket.entries()].map(([itemId, qty]) => ({ itemId, qty }));
    if (!lines.length) return;

    event.target.disabled = true;
    event.target.textContent = 'Saving…';
    try {
      await api.mxCreateIssue({
        areaId,
        day: day.value || data.today,
        jobRef: jobRef.value.trim() || null,
        note: note.value.trim() || null,
        lines,
      });
      const where = areaId ? data.areas.find((a) => a.id === areaId)?.name : 'the store';
      toast(`${lines.length} ${lines.length === 1 ? 'item' : 'items'} issued to ${where}`, 'good');

      basket.clear();
      jobRef.value = '';
      note.value = '';
      mount(host, await renderMxIssue({ areaId }));
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
      event.target.textContent = 'Record issue';
    }
  }

  drawAreas();
  drawItems();
  drawBasket();

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Issue parts'),
        h('div.sub', 'Tap where the work was, tap what you used, then record it'),
      ),
    ),
    h('div.grid.grid-2',
      card('Where was the work?', { note: 'Optional, but it is what makes the reports worth reading' }, areaHost),
      card('What did you use?', {}, itemHost),
    ),
    card('Details', { note: 'All optional' },
      h('div.field-row',
        h('label.field', h('span', 'Date'), day),
        h('label.field', h('span', 'Job or ticket'), jobRef),
        h('label.field', h('span', 'Note'), note),
      ),
    ),
    recentCard(recent.issues ?? [], reload),
    basketHost,
  );

  return host;
}

function recentCard(issues, reload) {
  if (!issues.length) return null;

  // Neither button acts. Parts already issued go back on the shelf only when an
  // administrator accepts it, so a technician who fitted the wrong thing asks
  // rather than quietly putting the record right.
  const ask = (issue) => async () => {
    const reason = prompt('Ask to remove this entry. Why?\n\n'
      + 'The parts stay issued until an administrator accepts it.');
    if (reason === null) return;
    try {
      await api.mxDeleteIssue(issue.id, reason.trim() || null);
      toast('Sent to an administrator — nothing has moved yet', 'good');
      reload();
    } catch (err) { toast(err.message, 'bad'); }
  };

  return card('Just recorded', { note: 'The last few, newest first' },
    h('div.mx-recent', issues.map((issue) => h('div.mx-recent-row',
      h('span.muted', fmtDay(issue.day)),
      h('strong', fmtQty(issue.qty, issue.unit)),
      h('span', issue.item_name),
      h('span.muted', '→'),
      h('span', issue.area_name || 'not recorded'),
      issue.issued_by ? h('span.muted', `· ${issue.issued_by}`) : null,
      h('button.btn-sm.btn-ghost', { style: { marginLeft: 'auto' }, onclick: ask(issue) }, 'Remove'),
    ))),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
      'Removing an entry puts those parts back on the shelf, so it goes to an administrator '
      + 'first. Until they accept it, the store still reads as it does now.'),
  );
}
