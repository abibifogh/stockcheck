import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PERMISSION_KEYS, allows, can, defaultPermissions, effectivePermissions, isRole,
} from '../src/lib/permissions.js';
import { isEmail, parseRecipients, renderDailyEmail } from '../src/lib/email.js';

test('role defaults keep cooks away from anything with money in it', () => {
  const cook = defaultPermissions('cook');
  assert.deepEqual(cook, ['entry']);
  assert.ok(!cook.includes('reports'));
  assert.ok(!cook.includes('purchases'));
  assert.ok(!cook.includes('stock'));
});

test('managers see the operation but cannot manage people', () => {
  const manager = defaultPermissions('manager');
  assert.ok(manager.includes('reports'));
  assert.ok(manager.includes('purchases'));
  assert.ok(!manager.includes('users'));
  assert.ok(!manager.includes('setup'));
});

test('administrators get everything', () => {
  assert.deepEqual(defaultPermissions('admin').sort(), [...PERMISSION_KEYS].sort());
});

test('an unknown role falls back to the least privilege, not the most', () => {
  assert.deepEqual(defaultPermissions('wizard'), ['entry']);
  assert.equal(isRole('wizard'), false);
});

test('a per-person override replaces the role defaults', () => {
  const user = { role: 'cook', permissions: JSON.stringify(['entry', 'stock']) };
  assert.deepEqual(effectivePermissions(user), ['entry', 'stock']);
  assert.equal(can(user, 'stock'), true);
  assert.equal(can(user, 'reports'), false);
});

test('an override cannot invent a permission that does not exist', () => {
  const user = { role: 'cook', permissions: JSON.stringify(['entry', 'everything', 'reports']) };
  assert.deepEqual(effectivePermissions(user), ['entry', 'reports']);
});

test('a corrupted override falls back to the role rather than locking someone out', () => {
  const user = { role: 'manager', permissions: 'not json at all' };
  assert.deepEqual(effectivePermissions(user), defaultPermissions('manager'));
});

test('an admin always keeps access to the screen that can undo a mistake', () => {
  const user = { role: 'admin', permissions: JSON.stringify(['entry']) };
  assert.ok(effectivePermissions(user).includes('users'), 'an admin must not be able to lock themselves out');
});

// --------------------------------------------------------------- the roster --

test('the roster can be granted without the power to delete a dorm', () => {
  const desk = { role: 'receptionist', permissions: JSON.stringify(['hk_check', 'hk_roster']) };
  const list = effectivePermissions(desk);
  assert.ok(list.includes('hk_check'), 'they still walk the check');
  assert.ok(list.includes('hk_roster'), 'and they set who is expected tonight');
  assert.ok(!list.includes('hk_setup'), 'but they cannot rename or remove a room');
  assert.ok(!list.includes('hk_reports'));
});

test('anybody who can build the dorms can say who is expected in them', () => {
  // The roster sits on the setup screen as well, and a setup holder who could
  // not touch it would be looking at a control that refused them.
  const list = effectivePermissions({ role: 'housekeeper', permissions: JSON.stringify(['hk_setup']) });
  assert.ok(list.includes('hk_roster'));
});

test('a route may accept either of two permissions', () => {
  // The roster endpoint names both; the screens that rename and delete rooms
  // still name setup alone.
  assert.equal(allows(['hk_roster', 'hk_setup'], ['hk_check', 'hk_roster']), true);
  assert.equal(allows(['hk_roster', 'hk_setup'], ['hk_setup']), true);
  assert.equal(allows(['hk_roster', 'hk_setup'], ['hk_check']), false);
  assert.equal(allows('hk_setup', ['hk_roster']), false, 'the roster is not setup');
  assert.equal(allows('hk_check', ['hk_check']), true);
  // A route with nothing to check only needs somebody signed in.
  assert.equal(allows(null, []), true);
  assert.equal(allows([], []), true);
});

test('a checker is not handed the answer sheet by default', () => {
  // Somebody who knows the bed should be free before they look at it is not
  // really checking it, so neither walking role gets the roster unless it is
  // deliberately granted.
  for (const role of ['receptionist', 'housekeeper']) {
    assert.deepEqual(defaultPermissions(role), ['hk_check'], `${role} defaults`);
  }
  assert.ok(defaultPermissions('housekeeping_manager').includes('hk_roster'));
});

test('no permissions at all for someone not signed in', () => {
  assert.deepEqual(effectivePermissions(null), []);
  assert.equal(can(null, 'entry'), false);
});

// ------------------------------------------------------------------ email --

test('recipient lists are accepted as JSON or as something a human typed', () => {
  assert.deepEqual(parseRecipients('["a@b.com","c@d.com"]'), ['a@b.com', 'c@d.com']);
  assert.deepEqual(parseRecipients('a@b.com, c@d.com'), ['a@b.com', 'c@d.com']);
  assert.deepEqual(parseRecipients('a@b.com c@d.com'), ['a@b.com', 'c@d.com']);
  assert.deepEqual(parseRecipients(''), []);
  assert.deepEqual(parseRecipients(null), []);
});

test('rubbish addresses are dropped rather than sent to', () => {
  assert.deepEqual(parseRecipients('["good@example.com","not-an-address"]'), ['good@example.com']);
  assert.equal(isEmail('nope'), false);
  assert.equal(isEmail('a@b'), false);
  assert.equal(isEmail('a@b.com'), true);
});

const INSIGHT = {
  day: '2026-08-03',
  weekday: 'Monday',
  currency: 'GHS',
  today: {
    guests: 54, inhouse: 53, outside: 1, cost: 1487.09, costPerGuest: 27.54,
    revenue: 45, outsiderFee: 45, note: null,
  },
  comparisons: {
    last7: { cost: 1982.26, costPerGuest: 25, costDeltaPct: -25, costPerGuestDeltaPct: 10.2 },
    sameWeekday: { guests: 56.3, costPerGuest: 23.7, costPerGuestDeltaPct: 16.2 },
  },
  alerts: [{ level: 'high', kind: 'usage_deviation', title: 'Eggs above normal', detail: '192.98 pcs against 86.07 expected' }],
  topCosts: [{ name: 'Eggs', unit: 'pcs', qty: 192.98, cost: 341.44 }],
  completeness: { score: 100, recorded: 25, expected: 25, missing: [] },
};

test('the daily email states the numbers a manager actually acts on', () => {
  const html = renderDailyEmail({
    insight: INSIGHT,
    propertyName: 'Nice Hotel',
    siteUrl: 'https://breakfast.niceoperation.com',
    submittedBy: 'Ama',
  });

  assert.ok(html.includes('Nice Hotel'));
  assert.ok(html.includes('54'), 'guest count');
  assert.ok(html.includes('27.54'), 'cost per guest');
  assert.ok(html.includes('Eggs above normal'), 'the alert');
  assert.ok(html.includes('Ama'), 'who submitted it');
  assert.ok(html.includes('/#/daily?day=2026-08-03'), 'a link to the day');
  // Mail clients strip stylesheets, so styling has to be inline.
  assert.ok(!html.includes('<style'), 'no stylesheet block');
});

test('content from the day sheet cannot inject markup into the email', () => {
  const html = renderDailyEmail({
    insight: {
      ...INSIGHT,
      today: { ...INSIGHT.today, note: '<script>alert(1)</script>' },
    },
    propertyName: '<img src=x onerror=alert(1)>',
    siteUrl: '',
    submittedBy: 'Kwame "The Chef"',
  });

  assert.ok(!html.includes('<script>'), 'a note must not be able to inject a script tag');
  assert.ok(!html.includes('<img src=x'), 'the property name must be escaped too');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('the subject-worthy figures survive a day with no guests', () => {
  const html = renderDailyEmail({
    insight: {
      ...INSIGHT,
      today: { ...INSIGHT.today, guests: 0, costPerGuest: null, cost: 0, revenue: 0, outside: 0 },
      comparisons: {
        last7: { cost: 0, costPerGuest: null, costDeltaPct: null, costPerGuestDeltaPct: null },
        sameWeekday: { guests: 0, costPerGuest: null, costPerGuestDeltaPct: null },
      },
    },
    propertyName: 'Nice Hotel',
    siteUrl: '',
    submittedBy: null,
  });

  assert.ok(!html.includes('NaN'), 'a missing figure must render as a dash, never as NaN');
  assert.ok(html.includes('—'));
});

// ------------------------------------------------------- sending the mail --

test('the mail request carries the recipients and is authorised', async () => {
  const { sendEmail } = await import('../src/lib/email.js');
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response('{"id":"abc"}', { status: 200 });
  };

  try {
    await sendEmail({
      apiKey: 'test-key',
      from: 'Breakfast <b@niceoperation.com>',
      to: ['owner@example.com', 'chef@example.com'],
      subject: 'Morning',
      html: '<p>hi</p>',
    });
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.to, ['owner@example.com', 'chef@example.com']);
  assert.equal(body.subject, 'Morning');
});

test('a rejected send raises an error the log can record', async () => {
  const { sendEmail } = await import('../src/lib/email.js');
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"message":"domain not verified"}', { status: 403 });

  try {
    await assert.rejects(
      () => sendEmail({ apiKey: 'k', from: 'a@b.com', to: ['c@d.com'], subject: 's', html: 'h' }),
      /403.*domain not verified/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
