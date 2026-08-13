// Thin fetch wrapper. Every call goes through here so authentication failures
// and offline states are handled in exactly one place.

class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function request(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'No connection to the server. Your work is saved on this device and will sync when you are back online.');
  }

  if (response.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'Your session has expired. Sign in again.');
  }

  const type = response.headers.get('Content-Type') || '';
  if (!type.includes('application/json')) {
    if (!response.ok) throw new ApiError(response.status, `Request failed (${response.status})`);
    return response;
  }

  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data.error || `Request failed (${response.status})`, data.detail);
  return data;
}

export const api = {
  ApiError,
  login: (pin) => request('/api/auth/login', { method: 'POST', body: { pin } }),
  passwordSalt: (email) => request('/api/auth/salt', { method: 'POST', body: { email } }),
  loginWithKey: (email, passwordKey) =>
    request('/api/auth/login', { method: 'POST', body: { email, passwordKey } }),
  changeCredentials: (body) =>
    request('/api/auth/change-credentials', { method: 'POST', body }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),

  bootstrap: () => request('/api/bootstrap'),
  recentDays: (limit = 30) => request(`/api/days?limit=${limit}`),
  getDay: (day) => request(`/api/days/${day}`),
  saveDay: (day, payload) => request(`/api/days/${day}`, { method: 'PUT', body: payload }),
  deleteDay: (day) => request(`/api/days/${day}`, { method: 'DELETE' }),

  revisions: (status = 'pending') => request(`/api/revisions?status=${status}`),
  pendingCount: () => request('/api/revisions/pending-count'),
  reviewRevision: (id, body) => request(`/api/revisions/${id}/review`, { method: 'POST', body }),

  importTemplateUrl: () => '/api/import/template',
  importDays: (body) => request('/api/import/days', { method: 'POST', body }),

  locks: () => request('/api/locks'),
  createLock: (body) => request('/api/locks', { method: 'POST', body }),
  deleteLock: (id) => request(`/api/locks/${id}`, { method: 'DELETE' }),
  audit: (limit = 100) => request(`/api/audit?limit=${limit}`),

  overview: () => request('/api/insights/overview'),
  daily: (day) => request(`/api/insights/daily${day ? `?day=${day}` : ''}`),
  weekly: (week) => request(`/api/insights/weekly${week ? `?week=${week}` : ''}`),
  monthly: (month) => request(`/api/insights/monthly${month ? `?month=${month}` : ''}`),
  compare: (a, b) => request(`/api/insights/compare?${new URLSearchParams({
    aFrom: a.from, aTo: a.to, bFrom: b.from, bTo: b.to,
  })}`),
  stock: (asOf) => request(`/api/insights/stock${asOf ? `?asOf=${asOf}` : ''}`),

  createCategory: (body) => request('/api/categories', { method: 'POST', body }),
  updateCategory: (id, body) => request(`/api/categories/${id}`, { method: 'PUT', body }),
  deleteCategory: (id) => request(`/api/categories/${id}`, { method: 'DELETE' }),

  createIngredient: (body) => request('/api/ingredients', { method: 'POST', body }),
  updateIngredient: (id, body) => request(`/api/ingredients/${id}`, { method: 'PUT', body }),
  deleteIngredient: (id) => request(`/api/ingredients/${id}`, { method: 'DELETE' }),

  purchases: (from, to) => request(`/api/purchases?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`),
  createPurchase: (body) => request('/api/purchases', { method: 'POST', body }),
  createDelivery: (body) => request('/api/deliveries', { method: 'POST', body }),
  lastCosts: () => request('/api/purchases/last-costs'),
  deletePurchase: (id) => request(`/api/purchases/${id}`, { method: 'DELETE' }),

  suppliers: () => request('/api/suppliers'),
  createSupplier: (body) => request('/api/suppliers', { method: 'POST', body }),
  updateSupplier: (id, body) => request(`/api/suppliers/${id}`, { method: 'PUT', body }),
  deleteSupplier: (id) => request(`/api/suppliers/${id}`, { method: 'DELETE' }),

  users: () => request('/api/users'),
  createUser: (body) => request('/api/users', { method: 'POST', body }),
  updateUser: (id, body) => request(`/api/users/${id}`, { method: 'PUT', body }),
  deleteUser: (id) => request(`/api/users/${id}`, { method: 'DELETE' }),

  pushKey: () => request('/api/push/key'),
  pushStatus: (endpoint) => request(`/api/push/status${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`),
  pushSubscribe: (body) => request('/api/push/subscribe', { method: 'POST', body }),
  pushUnsubscribe: (body) => request('/api/push/unsubscribe', { method: 'POST', body }),
  pushTest: (body) => request('/api/push/test', { method: 'POST', body }),
  removePushDevice: (id) => request(`/api/push/devices/${id}`, { method: 'DELETE' }),

  notifications: () => request('/api/notifications'),
  updateNotifications: (body) => request('/api/notifications', { method: 'PUT', body }),
  testNotification: () => request('/api/notifications/test', { method: 'POST' }),

  dataSummary: () => request('/api/data/summary'),
  eraseData: (body) => request('/api/data/erase', { method: 'POST', body }),

  saveStockCounts: (body) => request('/api/stock-counts', { method: 'POST', body }),
  updateSettings: (body) => request('/api/settings', { method: 'PUT', body }),

  // ------------------------------------------------------------ maintenance --
  mxBootstrap: () => request('/api/mx/bootstrap'),
  mxIssues: (params = {}) => request(`/api/mx/issues?${new URLSearchParams(params)}`),
  mxCreateIssue: (body) => request('/api/mx/issues', { method: 'POST', body }),
  mxDeleteIssue: (id) => request(`/api/mx/issues/${id}`, { method: 'DELETE' }),

  mxPurchases: (from, to) => request(`/api/mx/purchases?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  mxLastCosts: () => request('/api/mx/purchases/last-costs'),
  mxCreateDelivery: (body) => request('/api/mx/deliveries', { method: 'POST', body }),
  mxDeletePurchase: (id) => request(`/api/mx/purchases/${id}`, { method: 'DELETE' }),

  mxStock: (asOf) => request(`/api/mx/stock${asOf ? `?asOf=${asOf}` : ''}`),
  mxSaveCounts: (body) => request('/api/mx/counts', { method: 'POST', body }),

  mxOverview: () => request('/api/mx/overview'),
  mxReport: (from, to) => request(`/api/mx/report?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  mxCompare: (a, b) => request(`/api/mx/compare?${new URLSearchParams({
    aFrom: a.from, aTo: a.to, bFrom: b.from, bTo: b.to,
  })}`),
  mxAreaDetail: (id) => request(`/api/mx/areas/${id}/detail`),

  mxAreas: () => request('/api/mx/areas'),
  mxCreateArea: (body) => request('/api/mx/areas', { method: 'POST', body }),
  mxCreateAreaRange: (body) => request('/api/mx/areas/range', { method: 'POST', body }),
  mxUpdateArea: (id, body) => request(`/api/mx/areas/${id}`, { method: 'PUT', body }),
  mxDeleteArea: (id) => request(`/api/mx/areas/${id}`, { method: 'DELETE' }),

  mxCreateItem: (body) => request('/api/mx/items', { method: 'POST', body }),
  mxUpdateItem: (id, body) => request(`/api/mx/items/${id}`, { method: 'PUT', body }),
  mxDeleteItem: (id) => request(`/api/mx/items/${id}`, { method: 'DELETE' }),
  mxCreateCategory: (body) => request('/api/mx/categories', { method: 'POST', body }),
  mxPartsTemplateUrl: () => '/api/mx/items/template',
  mxImportParts: (body) => request('/api/mx/items/import', { method: 'POST', body }),

  // ----------------------------------------------------------- housekeeping --
  hkBootstrap: (params = {}) => request(`/api/hk/bootstrap?${new URLSearchParams(params)}`),
  hkSaveChecks: (body) => request('/api/hk/checks', { method: 'POST', body }),
  hkSubmitRound: (day, slot, body = {}) =>
    request(`/api/hk/rounds/${day}/${slot}/submit`, { method: 'POST', body }),
  hkRounds: (limit = 30) => request(`/api/hk/rounds?limit=${limit}`),
  hkDay: (day, slot) => request(`/api/hk/day?${new URLSearchParams({
    ...(day ? { day } : {}), ...(slot ? { slot } : {}),
  })}`),

  hkOverview: () => request('/api/hk/overview'),
  hkReport: (from, to) => request(`/api/hk/report?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  hkRoom: (id, from, to) => request(`/api/hk/rooms/${id}/detail?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  hkExportUrl: (from, to) => `/api/hk/export?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`,

  hkRooms: () => request('/api/hk/rooms'),
  hkCreateRoom: (body) => request('/api/hk/rooms', { method: 'POST', body }),
  hkUpdateRoom: (id, body) => request(`/api/hk/rooms/${id}`, { method: 'PUT', body }),
  hkDeleteRoom: (id) => request(`/api/hk/rooms/${id}`, { method: 'DELETE' }),
  hkCreateBed: (body) => request('/api/hk/beds', { method: 'POST', body }),
  hkUpdateBed: (id, body) => request(`/api/hk/beds/${id}`, { method: 'PUT', body }),
  hkDeleteBed: (id) => request(`/api/hk/beds/${id}`, { method: 'DELETE' }),
  hkSaveRoster: (body) => request('/api/hk/roster', { method: 'POST', body }),
  hkUpdateSettings: (body) => request('/api/hk/settings', { method: 'PUT', body }),

  exportUrl: (type, from, to) =>
    `/api/export?${new URLSearchParams({ type, ...(from ? { from } : {}), ...(to ? { to } : {}) })}`,
};

// --------------------------------------------------------------- offline --
// Day sheets are queued locally when a save fails, so a dropped connection in
// the kitchen never costs the morning's numbers.

const QUEUE_KEY = 'bf.pendingDays';

export function queueDay(day, payload) {
  const queue = readQueue();
  queue[day] = { payload, queuedAt: Date.now() };
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function readQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function dequeueDay(day) {
  const queue = readQueue();
  delete queue[day];
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

/** Push anything queued while offline. Returns the number of days synced. */
export async function flushQueue() {
  const queue = readQueue();
  const days = Object.keys(queue);
  if (!days.length) return 0;

  let synced = 0;
  for (const day of days) {
    try {
      await api.saveDay(day, queue[day].payload);
      dequeueDay(day);
      synced += 1;
    } catch (err) {
      if (err.status === 401) throw err;
      break; // still offline — keep the rest queued and try again later
    }
  }
  return synced;
}
