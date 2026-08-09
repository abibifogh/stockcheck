import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HttpError, rethrowConstraint } from '../src/lib/http.js';

/**
 * These guard a real defect: editing an ingredient's category returned
 * "something went wrong on the server". The cause was an ordinary uniqueness
 * rule, which the create path handled and the update path did not.
 */

const UNIQUE_ERR = new Error('D1_ERROR: UNIQUE constraint failed: ingredients.category_id, ingredients.name');
const FK_ERR = new Error('D1_ERROR: FOREIGN KEY constraint failed');
const REAL_FAULT = new Error('D1_ERROR: network unreachable');

test('a uniqueness failure becomes a message the person can act on', () => {
  assert.throws(
    () => rethrowConstraint(UNIQUE_ERR, { unique: 'That name is already taken in that category.' }),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 400, 'a rule being broken is the caller’s mistake, not a server fault');
      assert.equal(err.message, 'That name is already taken in that category.');
      return true;
    },
  );
});

test('a missing reference becomes its own message', () => {
  assert.throws(
    () => rethrowConstraint(FK_ERR, { foreignKey: 'That category no longer exists.' }),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.message, 'That category no longer exists.');
      return true;
    },
  );
});

test('a genuine fault is re-thrown untouched and stays loud', () => {
  assert.throws(
    () => rethrowConstraint(REAL_FAULT, { unique: 'nope', foreignKey: 'nope' }),
    (err) => {
      assert.ok(!(err instanceof HttpError), 'a real failure must not be dressed up as a bad request');
      assert.match(err.message, /network unreachable/);
      return true;
    },
  );
});

test('a constraint with no message supplied for it is re-thrown, not swallowed', () => {
  // Only `unique` is handled here, so a foreign-key failure must pass through.
  assert.throws(
    () => rethrowConstraint(FK_ERR, { unique: 'taken' }),
    (err) => {
      assert.ok(!(err instanceof HttpError));
      return true;
    },
  );
});

test('matching is specific enough not to catch unrelated wording', () => {
  const chatty = new Error('could not parse the UNIQUE word in a note field');
  assert.throws(
    () => rethrowConstraint(chatty, { unique: 'taken' }),
    (err) => {
      assert.ok(!(err instanceof HttpError), 'only a real "UNIQUE constraint" failure should match');
      return true;
    },
  );
});
