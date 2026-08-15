import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FULL_SITE_PATHS, servesPath, siteOf } from '../src/lib/site.js';
import { PERMISSIONS, ROLES, permissionsFor, rolesFor } from '../src/lib/permissions.js';

/**
 * One codebase, two deployments. These guard the line between them: what a
 * housekeeping-only site serves, and what it is allowed to hand out.
 */

test('a site is the full system unless it says otherwise', () => {
  assert.equal(siteOf({}), 'full');
  assert.equal(siteOf(undefined), 'full');
  assert.equal(siteOf({ APP_SITE: '' }), 'full');
  assert.equal(siteOf({ APP_SITE: 'breakfast' }), 'full');
  assert.equal(siteOf({ APP_SITE: 'housekeeping' }), 'housekeeping');
});

test('the housekeeping site serves the bed check and the things every site needs', () => {
  for (const path of [
    '/api/auth/login', '/api/auth/me', '/api/bootstrap',
    '/api/hk/bootstrap', '/api/hk/checks', '/api/hk/report', '/api/hk/rooms/1/detail',
    '/api/users', '/api/notifications', '/api/audit', '/api/data/summary',
  ]) {
    assert.equal(servesPath('housekeeping', path), true, `${path} should be served`);
  }
});

test('it does not serve the breakfast unit or the parts store', () => {
  for (const path of [
    '/api/days', '/api/days/2026-08-12', '/api/insights/overview', '/api/insights/stock',
    '/api/export', '/api/purchases', '/api/purchases/last-costs', '/api/deliveries',
    '/api/ingredients/4', '/api/categories', '/api/suppliers', '/api/stock-counts',
    '/api/revisions', '/api/import/days',
    '/api/mx/bootstrap', '/api/mx/issues', '/api/mx/items/template',
  ]) {
    assert.equal(servesPath('housekeeping', path), false, `${path} should be absent`);
  }
});

test('the full site serves its own work and the things every site needs', () => {
  for (const path of [...FULL_SITE_PATHS, '/api/users', '/api/bootstrap', '/api/audit']) {
    assert.equal(servesPath('full', path), true, `${path} should be served`);
  }
});

test('it does not serve the bed check, which belongs to the other site', () => {
  // The mirror of the case above. A hotel has no dorms, so answering here would
  // be answering about a database nobody on this site fills in.
  for (const path of [
    '/api/hk', '/api/hk/bootstrap', '/api/hk/checks', '/api/hk/rooms/1/detail',
    '/api/hk/roster', '/api/hk/export',
  ]) {
    assert.equal(servesPath('full', path), false, `${path} should be absent`);
  }
});

test('the prefix test is no looser going the other way', () => {
  // '/api/hksomething' is not '/api/hk', and must not be caught by it.
  assert.equal(servesPath('full', '/api/hksomething'), true);
  assert.equal(servesPath('full', '/api/hk-check'), true);
});

test('a path that merely starts with the same letters is not caught', () => {
  // '/api/daysheet' is not '/api/days', and a prefix test that cannot tell them
  // apart would silently disable an endpoint somebody added later.
  assert.equal(servesPath('housekeeping', '/api/hk/rounds'), true);
  assert.equal(servesPath('housekeeping', '/api/importantthing'), true);
});

// ------------------------------------------------------------- permissions --

const HK_KEYS = ['hk_check', 'hk_reports', 'hk_roster', 'hk_setup'];

test('the housekeeping site offers only housekeeping sections', () => {
  assert.deepEqual(permissionsFor('housekeeping').map((p) => p.key), HK_KEYS);
});

test('and the full site offers everything except those', () => {
  const keys = permissionsFor('full').map((p) => p.key);
  assert.equal(keys.length, PERMISSIONS.length - HK_KEYS.length);
  for (const key of HK_KEYS) {
    assert.ok(!keys.includes(key), `${key} is the other site's, and must not be offered here`);
  }
  // The sections this site does run are all still there.
  for (const key of ['entry', 'reports', 'stock', 'mx_issue', 'users']) {
    assert.ok(keys.includes(key), `${key} belongs to this site`);
  }
});

test('it offers only the roles built from those sections, plus administrator', () => {
  const roles = rolesFor('housekeeping');
  const keys = roles.map((r) => r.key);

  assert.deepEqual(keys, ['receptionist', 'housekeeper', 'housekeeping_manager', 'admin']);
  assert.ok(!keys.includes('cook'), 'a cook has nothing to do on this site');
  // Reception walk two of the three checks, so they are a role here.
  assert.deepEqual(roles.find((r) => r.key === 'receptionist').defaults, ['hk_check']);
  assert.ok(!keys.includes('technician'));

  // An administrator here administers this site, not a kitchen.
  const admin = roles.find((r) => r.key === 'admin');
  assert.deepEqual(admin.defaults, ['hk_check', 'hk_reports', 'hk_roster', 'hk_setup', 'users']);
  assert.ok(admin.defaults.includes('users'), 'somebody has to be able to manage people');

  assert.deepEqual(rolesFor('housekeeping').find((r) => r.key === 'housekeeper').defaults, ['hk_check']);
});

test('the full site drops the roles whose whole job is the bed check', () => {
  const roles = rolesFor('full');
  const keys = roles.map((r) => r.key);

  for (const key of ['receptionist', 'housekeeper', 'housekeeping_manager']) {
    assert.ok(!keys.includes(key), `${key} belongs to the housekeeping site`);
  }
  assert.equal(keys.length, ROLES.length - 3);
  for (const key of ['cook', 'manager', 'baker', 'technician', 'admin']) {
    assert.ok(keys.includes(key), `${key} works here`);
  }

  // An administrator here administers a hotel, so the bed check comes out of
  // their pre-ticked boxes too.
  const admin = roles.find((r) => r.key === 'admin');
  for (const key of HK_KEYS) assert.ok(!admin.defaults.includes(key));
  assert.ok(admin.defaults.includes('users'), 'somebody has to be able to manage people');
  assert.ok(admin.defaults.includes('entry'));
});

test('nothing offered on the full site names a section it does not have', () => {
  const available = new Set(permissionsFor('full').map((p) => p.key));
  for (const role of rolesFor('full')) {
    for (const key of role.defaults) {
      assert.ok(available.has(key), `${role.key} defaults to ${key}, which this site does not offer`);
    }
  }
});

test('nothing offered on the housekeeping site names a section it does not have', () => {
  const available = new Set(permissionsFor('housekeeping').map((p) => p.key));
  for (const role of rolesFor('housekeeping')) {
    for (const key of role.defaults) {
      // `users` is the one exception: managing people is not a bed-check
      // screen, but every site needs somebody who can do it.
      if (key === 'users') continue;
      assert.ok(available.has(key), `${role.key} defaults to ${key}, which this site does not offer`);
    }
  }
});
