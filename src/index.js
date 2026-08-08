import {
  clearCookie, createToken, getSession, hasRole, roleForPin,
  sessionCookie, throttleCheck, throttleFail, throttleReset, tokenTtl,
} from './lib/auth.js';
import {
  HttpError, badRequest, forbidden, json, readJson, str, unauthorized,
} from './lib/http.js';
import { getDay, listDays, saveDay } from './routes/day.js';
import * as catalog from './routes/catalog.js';
import * as insights from './routes/insights.js';

/**
 * Route table. Each entry is [method, pattern, role, handler]; `:id` and
 * `:day` capture a single path segment and are passed to the handler in order.
 * `null` role means the endpoint is public.
 */
const ROUTES = [
  ['POST', '/api/auth/login', null, login],
  ['POST', '/api/auth/logout', null, logout],
  ['GET', '/api/auth/me', null, me],

  ['GET', '/api/bootstrap', 'cook', catalog.bootstrap],
  ['GET', '/api/days', 'cook', listDays],
  ['GET', '/api/days/:day', 'cook', getDay],
  ['PUT', '/api/days/:day', 'cook', saveDay],

  ['GET', '/api/insights/overview', 'manager', insights.overview],
  ['GET', '/api/insights/daily', 'manager', insights.daily],
  ['GET', '/api/insights/weekly', 'manager', insights.weekly],
  ['GET', '/api/insights/monthly', 'manager', insights.monthly],
  ['GET', '/api/insights/stock', 'manager', insights.stock],
  ['GET', '/api/export', 'manager', insights.exportCsv],

  ['POST', '/api/categories', 'manager', catalog.createCategory],
  ['PUT', '/api/categories/:id', 'manager', catalog.updateCategory],
  ['DELETE', '/api/categories/:id', 'manager', catalog.deleteCategory],

  ['POST', '/api/ingredients', 'manager', catalog.createIngredient],
  ['PUT', '/api/ingredients/:id', 'manager', catalog.updateIngredient],
  ['DELETE', '/api/ingredients/:id', 'manager', catalog.deleteIngredient],

  ['GET', '/api/purchases', 'manager', catalog.listPurchases],
  ['POST', '/api/purchases', 'manager', catalog.createPurchase],
  ['DELETE', '/api/purchases/:id', 'manager', catalog.deletePurchase],

  ['POST', '/api/stock-counts', 'manager', catalog.createStockCount],
  ['PUT', '/api/settings', 'manager', catalog.updateSettings],
];

function match(pattern, pathname) {
  const want = pattern.split('/');
  const got = pathname.split('/');
  if (want.length !== got.length) return null;
  const params = [];
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) {
      if (!got[i]) return null;
      params.push(decodeURIComponent(got[i]));
    } else if (want[i] !== got[i]) {
      return null;
    }
  }
  return params;
}

export default {
  async fetch(request, env, executionContext) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await route(request, env, url, executionContext);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message, detail: err.detail ?? null }, { status: err.status });
      }
      console.error('Unhandled error', err);
      return json({ error: 'Something went wrong on the server' }, { status: 500 });
    }
  },
};

async function route(request, env, url, executionContext) {
  if (!env.SESSION_SECRET) {
    return json(
      { error: 'Server not configured: SESSION_SECRET is missing. See the README setup steps.' },
      { status: 503 },
    );
  }
  if (!env.DB) {
    return json({ error: 'Server not configured: no database binding.' }, { status: 503 });
  }

  const method = request.method === 'HEAD' ? 'GET' : request.method;
  let allowedMethods = null;

  for (const [routeMethod, pattern, role, handler] of ROUTES) {
    const params = match(pattern, url.pathname);
    if (!params) continue;
    if (routeMethod !== method) {
      allowedMethods = allowedMethods || [];
      allowedMethods.push(routeMethod);
      continue;
    }

    const session = await getSession(request, env);
    if (role && !hasRole(session, role)) {
      throw session ? forbidden() : unauthorized();
    }

    const ctx = { request, env, url, session, db: env.DB, executionContext };
    return handler(ctx, ...params);
  }

  if (allowedMethods?.length) {
    return json({ error: `Method not allowed` }, {
      status: 405,
      headers: { Allow: [...new Set(allowedMethods)].join(', ') },
    });
  }
  return json({ error: 'Unknown endpoint' }, { status: 404 });
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

async function login(ctx) {
  const { request, env, url } = ctx;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  const gate = throttleCheck(ip);
  if (!gate.allowed) {
    return json(
      { error: `Too many attempts. Try again in ${Math.ceil(gate.retryAfter / 60)} minutes.` },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfter) } },
    );
  }

  const body = await readJson(request);
  const pin = str(body.pin, 'PIN', { required: true, max: 64 });

  if (!env.COOK_PIN && !env.MANAGER_PIN) {
    return json(
      { error: 'No PINs configured yet. Set COOK_PIN and MANAGER_PIN — see the README.' },
      { status: 503 },
    );
  }

  const role = await roleForPin(pin, env);
  if (!role) {
    throttleFail(ip);
    // A uniform delay keeps a wrong PIN from being distinguishable by timing.
    await new Promise((resolve) => setTimeout(resolve, 400));
    throw badRequest('That PIN was not recognised');
  }

  throttleReset(ip);
  const token = await createToken(
    { role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + tokenTtl(role) },
    env.SESSION_SECRET,
  );

  const secure = url.protocol === 'https:';
  return json({ ok: true, role }, {
    headers: { 'Set-Cookie': sessionCookie(token, role, secure) },
  });
}

async function logout(ctx) {
  return json({ ok: true }, {
    headers: { 'Set-Cookie': clearCookie(ctx.url.protocol === 'https:') },
  });
}

async function me(ctx) {
  const session = await getSession(ctx.request, ctx.env);
  if (!session) return json({ authenticated: false });

  const settings = await ctx.db.prepare("SELECT key, value FROM settings WHERE key IN ('property_name','currency','timezone')").all();
  return json({
    authenticated: true,
    role: session.role,
    expiresAt: session.exp,
    settings: Object.fromEntries((settings.results ?? []).map((r) => [r.key, r.value])),
  });
}
