import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROSTER_STATES } from '../public/js/views/hk-roster.js';

/**
 * The colour the roster is read by.
 *
 * A class name that nothing in the stylesheet matches does not break anything
 * loudly — the control simply comes out grey, and whoever is scanning a page
 * of beds loses the one thing that made it scannable. So the names are checked
 * against the stylesheet here.
 */

const CSS = readFileSync(join(import.meta.dirname, '..', 'public', 'styles.css'), 'utf8');

test('every roster state has a colour defined for it', () => {
  for (const [key, state] of Object.entries(ROSTER_STATES)) {
    assert.ok(state.cls, `${key} has no class`);
    assert.ok(CSS.includes(`.${state.cls}`), `${state.cls} is not styled anywhere`);
  }
});

test('the select and the pill are both covered', () => {
  // The same state is shown as a dropdown on the roster screen and as a pill on
  // a room's page. Styling one and not the other is how they drift apart.
  for (const state of Object.values(ROSTER_STATES)) {
    assert.ok(CSS.includes(`.roster-select.${state.cls}`) || state.cls === 'roster-none',
      `${state.cls} has no dropdown colour`);
    assert.ok(CSS.includes(`.pill.${state.cls}`), `${state.cls} has no pill colour`);
  }
});

test('the three states are the three the database can hold', () => {
  // hk_beds.expected_state is 'free', 'occupied' or null. A fourth option here
  // would be one the server refuses to save.
  assert.deepEqual(Object.keys(ROSTER_STATES).sort(), ['free', 'none', 'occupied']);
});

test('each state says the same thing in long and short form', () => {
  for (const [key, state] of Object.entries(ROSTER_STATES)) {
    assert.ok(state.label && state.short, `${key} is missing a label`);
    if (key === 'none') continue;
    assert.match(state.label, new RegExp(key));
    assert.match(state.short, new RegExp(key));
  }
});
