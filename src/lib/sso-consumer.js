import { createToken, normaliseEmail, sessionCookie, tokenTtl } from './auth.js';
import { isMissingTable } from './http.js';
import { siteOf } from './site.js';

/**
 * Arriving here already signed in, from the group's hub.
 *
 * The hub does not send us a person. It sends an opaque code, and we call the
 * hub back — server to server — with that code and our own shared secret, and
 * it tells us who the code was for. Then we make one of our own ordinary
 * sessions, exactly as if they had typed their password on this site.
 *
 * Three things this deliberately does not do.
 *
 * It does not trust anything in the URL. The code carries no identity; it is
 * thirty-two random bytes the hub is willing to exchange, once, for a name and
 * an address. A URL ends up in a browser history, a proxy log and a `Referer`
 * header, and none of those should ever have held somebody's identity.
 *
 * It does not create accounts. If the hub says "this is ama@example.com" and
 * nobody here is ama@example.com, the answer is no — with a message saying so.
 * Auto-provisioning would mean whoever controls the hub can mint themselves an
 * account in the breakfast unit's records, and the whole point of a separate
 * grant per system is that reaching one is not reaching all of them.
 *
 * It does not widen anybody. The role the hub sends is ignored: what somebody
 * may do here is what their row in this database says, as it always was. The
 * hand-off decides *whether* they get in, never *as what*.
 */

/**
 * Which system this deployment answers to on the hub.
 *
 * One codebase, two deployments — the breakfast unit and housekeeping — and the
 * hub holds a separate secret and a separate grant for each. Deriving it from
 * `APP_SITE` rather than asking for a third setting means the two can never
 * drift apart, and a housekeeping Worker cannot redeem a breakfast code even if
 * somebody pastes the wrong secret into it.
 */
export function ssoConfig(env) {
  return {
    redeemUrl: env?.INSIGHT_SSO_URL || '',
    secret: env?.INSIGHT_SSO_SECRET || '',
    systemId: env?.INSIGHT_SSO_SYSTEM || (siteOf(env) === 'housekeeping' ? 'housekeeping' : 'breakfast'),
    configured: Boolean(env?.INSIGHT_SSO_URL && env?.INSIGHT_SSO_SECRET),
  };
}

/**
 * Swap a code for an identity.
 *
 * Every failure comes back as a short sentence a person can act on, because
 * this runs in front of somebody staring at a page wondering why the button did
 * not work.
 */
export async function redeemAtHub(env, code, { timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const config = ssoConfig(env);
  if (!config.configured) {
    throw new Error('This site has not been connected to the group hub yet.');
  }
  // Length only. The code is opaque to us — the hub decides whether it is real
  // — but a two-character "code" is a mistake, not an attempt, and there is no
  // sense spending a round trip on it.
  if (typeof code !== 'string' || code.length < 20 || code.length > 300) {
    throw new Error('That sign-in link is not valid.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(config.redeemUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.secret}`,
      },
      body: JSON.stringify({ systemId: config.systemId, code }),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('The group hub did not answer in time. Try again.');
    throw new Error('The group hub could not be reached.');
  } finally {
    clearTimeout(timer);
  }

  // A wrong secret is a setting somebody has to fix, not an attack, so it is
  // worth naming. Everything else is deliberately one answer: telling a caller
  // which kind of bad code they hold tells them something about codes they do
  // not hold.
  if (response.status === 401) {
    throw new Error('The group hub did not recognise this site. Its shared secret is wrong or missing.');
  }
  if (!response.ok) {
    throw new Error('That sign-in link has expired or has already been used. Go back to the hub and click through again.');
  }

  let identity;
  try {
    identity = await response.json();
  } catch {
    throw new Error('The group hub answered with something unreadable.');
  }
  if (!identity?.email) throw new Error('The group hub did not say who you are.');
  return identity;
}

/**
 * Find the person the hub named, in this site's own user table.
 *
 * Matched on email address, which is the only identifier the two systems share.
 * Most people here sign in with a PIN and have no address at all; those accounts
 * simply cannot be handed over, which is correct — a PIN is shared knowledge in
 * a kitchen, and an address is one person.
 */
export async function localUserFor(db, email) {
  const normalised = normaliseEmail(email);
  if (!normalised) return null;
  try {
    return await db.prepare(
      'SELECT id, name, role, permissions, active FROM users WHERE email = ?',
    ).bind(normalised).first();
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

/**
 * The whole hand-off, from code to a session cookie.
 *
 * Returns a `Response` either way: a redirect to the app on success, and a
 * small readable page on failure. It has to be a page rather than JSON, because
 * whoever hits this is a person following a link, not a script.
 */
export async function handleSsoArrival(request, env, db) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  try {
    if (!code) throw new Error('That link is missing its sign-in code.');
    if (!env?.SESSION_SECRET) throw new Error('This site cannot sign anybody in: SESSION_SECRET is not set.');

    const identity = await redeemAtHub(env, code);
    const user = await localUserFor(db, identity.email);

    if (!user) {
      throw new Error(`The group hub signed you in as ${identity.email}, but nobody with that address has an account on this site yet. An administrator can add one under Settings → People.`);
    }
    if (!user.active) {
      throw new Error(`The account for ${identity.email} on this site has been switched off.`);
    }

    const now = Math.floor(Date.now() / 1000);
    const token = await createToken({
      uid: user.id,
      role: user.role,
      recovery: 0,
      iat: now,
      exp: now + tokenTtl(user.role),
    }, env.SESSION_SECRET);

    await db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?")
      .bind(user.id).run().catch(() => {});

    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': sessionCookie(token, user.role, url.protocol === 'https:'),
        'Cache-Control': 'no-store',
        // A code is single-use and ninety seconds old, but there is still no
        // reason for the address that carried it to travel anywhere else.
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch (err) {
    return problemPage(String(err?.message ?? err));
  }
}

function problemPage(message) {
  const escaped = String(message).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Could not sign you in</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f7f6f3;
         color: #1e1b16; margin: 0; display: grid; place-items: center; min-height: 100vh; padding: 1.5rem; }
  main { background: #fff; border: 1px solid rgba(0,0,0,.1); border-radius: 10px;
         padding: 1.75rem; max-width: 30rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .6rem; }
  p { margin: 0 0 1rem; line-height: 1.55; color: #5b544a; }
  a { color: #9a5b16; }
  @media (prefers-color-scheme: dark) {
    body { background: #12100d; color: #f0ece5; }
    main { background: #1c1915; border-color: rgba(255,255,255,.12); }
    p { color: #a8a094; } a { color: #e0a45c; }
  }
</style></head>
<body><main>
  <h1>Could not sign you in</h1>
  <p>${escaped}</p>
  <p><a href="/">Sign in on this site instead</a></p>
</main></body></html>`, {
    status: 400,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
