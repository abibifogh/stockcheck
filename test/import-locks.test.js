import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv } from '../src/routes/importing.js';
import { lockCovering, locksOverlapping } from '../src/lib/locks.js';

// ------------------------------------------------------------ CSV reading --

test('a plain spreadsheet export is read into rows', () => {
  const rows = parseCsv('Date,Guests\n2026-08-01,48\n2026-08-02,52\n');
  assert.deepEqual(rows, [
    ['Date', 'Guests'],
    ['2026-08-01', '48'],
    ['2026-08-02', '52'],
  ]);
});

test('quoted fields keep their commas', () => {
  const rows = parseCsv('Date,Note\n2026-08-01,"Buffet changed, extra eggs"\n');
  assert.equal(rows[1][1], 'Buffet changed, extra eggs');
});

test('escaped quotes survive', () => {
  const rows = parseCsv('Note\n"He said ""no bacon"" today"\n');
  assert.equal(rows[1][0], 'He said "no bacon" today');
});

test('a newline inside a quoted note does not split the row', () => {
  const rows = parseCsv('Date,Note\n2026-08-01,"line one\nline two"\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], 'line one\nline two');
});

test('Windows line endings and a byte-order mark are handled', () => {
  const rows = parseCsv('﻿Date,Guests\r\n2026-08-01,48\r\n');
  assert.equal(rows[0][0], 'Date', 'the BOM must not corrupt the first heading');
  assert.deepEqual(rows[1], ['2026-08-01', '48']);
});

test('blank lines are ignored rather than imported as empty days', () => {
  const rows = parseCsv('Date,Guests\n\n2026-08-01,48\n\n\n');
  assert.equal(rows.length, 2);
});

test('a file with no trailing newline still yields its last row', () => {
  const rows = parseCsv('Date,Guests\n2026-08-01,48');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ['2026-08-01', '48']);
});

test('empty cells are preserved so column positions stay aligned', () => {
  const rows = parseCsv('A,B,C\n1,,3\n');
  assert.deepEqual(rows[1], ['1', '', '3']);
});

// -------------------------------------------------------------- locks ------

const LOCKS = [
  { id: 1, from_day: '2026-07-01', to_day: '2026-07-31', reason: 'July closed' },
  { id: 2, from_day: '2026-09-01', to_day: '2026-09-30', reason: null },
];

test('a day inside a closed period is identified', () => {
  assert.equal(lockCovering(LOCKS, '2026-07-15')?.id, 1);
  assert.equal(lockCovering(LOCKS, '2026-09-30')?.id, 2, 'the last day is inside the lock');
  assert.equal(lockCovering(LOCKS, '2026-07-01')?.id, 1, 'the first day is inside the lock');
});

test('a day outside every closed period is free', () => {
  assert.equal(lockCovering(LOCKS, '2026-08-15'), null);
  assert.equal(lockCovering(LOCKS, '2026-06-30'), null);
  assert.equal(lockCovering(LOCKS, '2026-10-01'), null);
});

test('a range is blocked if it touches a lock at all', () => {
  // Fully inside
  assert.equal(locksOverlapping(LOCKS, '2026-07-10', '2026-07-20').length, 1);
  // Straddling the start
  assert.equal(locksOverlapping(LOCKS, '2026-06-25', '2026-07-05').length, 1);
  // Straddling the end
  assert.equal(locksOverlapping(LOCKS, '2026-07-25', '2026-08-05').length, 1);
  // Swallowing the whole lock
  assert.equal(locksOverlapping(LOCKS, '2026-06-01', '2026-08-31').length, 1);
  // Spanning both locks
  assert.equal(locksOverlapping(LOCKS, '2026-07-01', '2026-09-30').length, 2);
});

test('a range that misses every lock is allowed', () => {
  assert.deepEqual(locksOverlapping(LOCKS, '2026-08-01', '2026-08-31'), []);
  assert.deepEqual(locksOverlapping(LOCKS, '2026-10-01', '2026-12-31'), []);
});
