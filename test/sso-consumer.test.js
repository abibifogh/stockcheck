import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleSsoArrival, localUserFor, redeemAtHub, ssoConfig } from '../src/lib/sso-consumer.js';
import { readToken } from '../src/lib/auth.js';

/**
 * Accepting a sign-in from the group hub.
 *
 * The dangerous failures here are all failures to refuse: letting a code stand
 * in for an identity, creating an account because the hub named one, or handing
 * somebody a role the hub asked for rather than the one this database holds.
 * Each of those has a test below, and each of them would be invisible in
 * ordinary use — everything would appear to work, for the wrong person.
 */

const SESSION_SECRET = 'session-signing-secret-for-tests';
const HUB = 'https://insight.example.com/api/sso/redeem';

const ENV = {
  SESSION_SECRET,
  INSIGHT_SSO_URL: HUB,
  INSIGHT_SSO_SECRET: 'shared-with-the-hub',
};

/** The users this site has, keyed the way the query looks them up. */
function fakeDb(rows) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const statement = {
        bind(...args) {
          calls.push({ sql, args });
          return statement;
        },
        async first() {
          if (!/FROM users WHERE email/.test(sql)) return null;
          const email = calls[calls.length - 1].args[0];
          return rows.find((r) => r.email === email) ?? null;
        },
        async run() { return { success: true }; },
      };
      return statement;
    },
  };
}

const ROWS = [
  { id: 7, name: 'Ama Boateng', email: 'ama@nice.test', role: 'cook', permissions: null, active: 1 },
  { id: 8, name: 'Kofi Mensah', email: 'kofi@nice.test', role: 'admin', permissions: null, active: 0 },
];

/** A hub that answers with whatever it is told to, and records what it was asked. */
function fakeHub(answer, { status = 200 } = {}) {
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => answer,
    };
  };
  impl.seen = seen;
  return impl;
}

const arrive = (code, env = ENV, rows = ROWS) => handleSsoArrival(
  new Request(`https://breakfast.example.com/sso${code == null ? '' : `?code=${code}`}`),
  env,
  fakeDb(rows),
);

const CODE = 'a'.repeat(43);

test('a good code produces one of this site\'s own sessions', async () => {
  globalThis.fetch = fakeHub({ email: 'ama@nice.test', name: 'Ama Boateng', role: 'owner' });
  const response = await arrive(CODE);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), '/');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');

  const cookie = response.headers.get('Set-Cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/, 'an https arrival must set a secure cookie');
});

test('the role in the token is this database\'s, not the one the hub asked for', async () => {
  // The hub calls Ama an owner. Here she is a cook, and a cook is what she gets.
  globalThis.fetch = fakeHub({ email: 'ama@nice.test', name: 'Ama Boateng', role: 'owner' });
  const response = await arrive(CODE);

  const token = decodeURIComponent(/session=([^;]+)/.exec(response.headers.get('Set-Cookie'))[1]);
  const payload = await readToken(token, SESSION_SECRET);
  assert.equal(payload.uid, 7);
  assert.equal(payload.role, 'cook', 'the hub must not be able to promote anybody');
  assert.equal(payload.recovery, 0);
  assert.ok(payload.exp > Math.floor(Date.now() / 1000));
});

test('the identity travels on the back channel, never in the URL', async () => {
  const hub = fakeHub({ email: 'ama@nice.test', name: 'Ama Boateng', role: 'cook' });
  globalThis.fetch = hub;
  await arrive(CODE);

  assert.equal(hub.seen.length, 1, 'the code must be exchanged, not read');
  assert.equal(hub.seen[0].url, HUB);
  assert.equal(hub.seen[0].init.headers.Authorization, 'Bearer shared-with-the-hub');
  assert.deepEqual(hub.seen[0].body, { systemId: 'breakfast', code: CODE });
});

test('somebody the hub knows and this site does not is refused, by name', async () => {
  globalThis.fetch = fakeHub({ email: 'stranger@nice.test', name: 'A Stranger', role: 'owner' });
  const response = await arrive(CODE);

  assert.equal(response.status, 400);
  const body = await response.text();
  assert.match(body, /stranger@nice\.test/, 'say who, so an administrator knows what to create');
  assert.match(body, /nobody with that address has an account/);
  assert.equal(response.headers.get('Set-Cookie'), null, 'no session for somebody with no account');
});

test('a switched-off account stays switched off', async () => {
  globalThis.fetch = fakeHub({ email: 'kofi@nice.test', name: 'Kofi Mensah', role: 'admin' });
  const response = await arrive(CODE);

  assert.equal(response.status, 400);
  assert.match(await response.text(), /has been switched off/);
  assert.equal(response.headers.get('Set-Cookie'), null);
});

test('a code the hub refuses is an expired-or-used message, not a session', async () => {
  globalThis.fetch = fakeHub({ error: 'nope' }, { status: 400 });
  const response = await arrive(CODE);

  assert.equal(response.status, 400);
  assert.match(await response.text(), /expired or has already been used/);
  assert.equal(response.headers.get('Set-Cookie'), null);
});

test('a wrong shared secret says so, because it is a setting somebody must fix', async () => {
  globalThis.fetch = fakeHub({ error: 'no' }, { status: 401 });
  assert.match(await (await arrive(CODE)).text(), /did not recognise this site/);
});

test('a link with no code fails before anything is called', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; };
  const response = await arrive(null);

  assert.equal(response.status, 400);
  assert.match(await response.text(), /missing its sign-in code/);
  assert.equal(called, false);
});

test('a site with no hub configured says so rather than reaching out', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; };
  const response = await arrive(CODE, { SESSION_SECRET });

  assert.match(await response.text(), /not been connected to the group hub/);
  assert.equal(called, false);
});

test('a hub that cannot be reached is a sentence, not a stack trace', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const response = await arrive(CODE);

  assert.equal(response.status, 400);
  const body = await response.text();
  assert.match(body, /could not be reached/);
  assert.doesNotMatch(body, /ECONNREFUSED/, 'the network\'s vocabulary is nobody\'s business');
});

test('the failure page escapes what it repeats back', async () => {
  globalThis.fetch = fakeHub({ email: '<script>alert(1)</script>@x.test', name: 'x', role: 'cook' });
  const body = await (await arrive(CODE)).text();

  assert.doesNotMatch(body, /<script>alert/);
  assert.match(body, /&lt;script&gt;/);
});

test('a code that is obviously not a code costs no round trip', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; };
  await assert.rejects(() => redeemAtHub(ENV, 'short'), /not valid/);
  await assert.rejects(() => redeemAtHub(ENV, null), /not valid/);
  assert.equal(called, false);
});

test('the hub answering without an email is refused', async () => {
  globalThis.fetch = fakeHub({ name: 'Nobody', role: 'admin' });
  assert.match(await (await arrive(CODE)).text(), /did not say who you are/);
});

test('the housekeeping deployment redeems as itself, not as breakfast', () => {
  assert.equal(ssoConfig({ ...ENV }).systemId, 'breakfast');
  assert.equal(ssoConfig({ ...ENV, APP_SITE: 'housekeeping' }).systemId, 'housekeeping');
  // A code minted for one cannot be presented by the other: the hub is told
  // which system is asking, and it checks that against the code it issued.
  assert.notEqual(
    ssoConfig({ ...ENV }).systemId,
    ssoConfig({ ...ENV, APP_SITE: 'housekeeping' }).systemId,
  );
});

test('the address is matched case-insensitively and without stray spaces', async () => {
  assert.equal((await localUserFor(fakeDb(ROWS), '  AMA@Nice.TEST '))?.id, 7);
  assert.equal(await localUserFor(fakeDb(ROWS), ''), null);
  assert.equal(await localUserFor(fakeDb(ROWS), null), null);
});

test('a site with no SESSION_SECRET cannot sign anybody in', async () => {
  globalThis.fetch = fakeHub({ email: 'ama@nice.test', name: 'Ama', role: 'cook' });
  const response = await arrive(CODE, { ...ENV, SESSION_SECRET: '' });
  assert.match(await response.text(), /SESSION_SECRET is not set/);
});

test('an http arrival does not get a Secure cookie it cannot use', async () => {
  globalThis.fetch = fakeHub({ email: 'ama@nice.test', name: 'Ama', role: 'cook' });
  const response = await handleSsoArrival(
    new Request(`http://localhost:8787/sso?code=${CODE}`), ENV, fakeDb(ROWS),
  );
  assert.doesNotMatch(response.headers.get('Set-Cookie'), /Secure/);
});
