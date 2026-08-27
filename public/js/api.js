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

  notices: (limit = 20) => request(`/api/notices?limit=${limit}`),
  markNoticesSeen: (lastId) => request('/api/notices/seen', { method: 'POST', body: { lastId } }),

  dataSummary: (from, to) => request(`/api/data/summary?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  eraseData: (body) => request('/api/data/erase', { method: 'POST', body }),

  saveStockCounts: (body) => request('/api/stock-counts', { method: 'POST', body }),
  pendingStockCounts: () => request('/api/stock-counts/pending'),
  reviewStockCounts: (body) => request('/api/stock-counts/review', { method: 'POST', body }),
  updateSettings: (body) => request('/api/settings', { method: 'PUT', body }),

  // ------------------------------------------------------------ maintenance --
  mxBootstrap: () => request('/api/mx/bootstrap'),
  mxIssues: (params = {}) => request(`/api/mx/issues?${new URLSearchParams(params)}`),
  mxCreateIssue: (body) => request('/api/mx/issues', { method: 'POST', body }),
  // Both ask for a change rather than making one. What comes back says so.
  mxUpdateIssue: (id, body) => request(`/api/mx/issues/${id}`, { method: 'PUT', body }),
  mxDeleteIssue: (id, reason) => request(`/api/mx/issues/${id}`, { method: 'DELETE', body: { reason } }),

  mxPurchases: (from, to) => request(`/api/mx/purchases?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  mxLastCosts: () => request('/api/mx/purchases/last-costs'),
  mxCreateDelivery: (body) => request('/api/mx/deliveries', { method: 'POST', body }),
  mxUpdatePurchase: (id, body) => request(`/api/mx/purchases/${id}`, { method: 'PUT', body }),
  mxDeletePurchase: (id, reason) => request(`/api/mx/purchases/${id}`, { method: 'DELETE', body: { reason } }),

  mxStock: (asOf) => request(`/api/mx/stock${asOf ? `?asOf=${asOf}` : ''}`),
  mxSaveCounts: (body) => request('/api/mx/counts', { method: 'POST', body }),
  mxPendingCounts: () => request('/api/mx/counts/pending'),
  mxCountHistory: () => request('/api/mx/counts/history'),
  mxReviewCounts: (body) => request('/api/mx/counts/review', { method: 'POST', body }),
  mxPendingAdjustments: () => request('/api/mx/adjustments'),
  mxReviewAdjustments: (body) => request('/api/mx/adjustments/review', { method: 'POST', body }),

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
  mxProducts: () => request('/api/mx/products'),
  mxCreateProduct: (body) => request('/api/mx/products', { method: 'POST', body }),
  mxUpdateProduct: (id, body) => request(`/api/mx/products/${id}`, { method: 'PUT', body }),
  mxAddVariant: (id, body) => request(`/api/mx/products/${id}/variants`, { method: 'POST', body }),
  mxDeleteProduct: (id) => request(`/api/mx/products/${id}`, { method: 'DELETE' }),
  mxSetItemProduct: (id, body) => request(`/api/mx/items/${id}/product`, { method: 'PUT', body }),
  mxRenameVariant: (id, body) => request(`/api/mx/items/${id}/variant`, { method: 'PUT', body }),

  mxTools: () => request('/api/mx/tools'),
  mxToolHistory: (id) => request(`/api/mx/tools/${id}/history`),
  mxIssueTool: (id, body) => request(`/api/mx/tools/${id}/issue`, { method: 'POST', body }),
  mxReturnTool: (id, body) => request(`/api/mx/tools/${id}/return`, { method: 'POST', body }),
  mxCreateTool: (body) => request('/api/mx/tools', { method: 'POST', body }),
  mxSetToolParent: (id, body) => request(`/api/mx/tools/${id}/parent`, { method: 'PUT', body }),
  mxUpdateTool: (id, body) => request(`/api/mx/tools/${id}`, { method: 'PUT', body }),
  mxRetireTool: (id) => request(`/api/mx/tools/${id}`, { method: 'DELETE' }),

  mxCreateCategory: (body) => request('/api/mx/categories', { method: 'POST', body }),
  mxPartsTemplateUrl: () => '/api/mx/items/template',
  mxImportParts: (body) => request('/api/mx/items/import', { method: 'POST', body }),
  mxRemoveItems: (ids) => request('/api/mx/items/remove', { method: 'POST', body: { ids } }),
  mxRemoveAreas: (ids) => request('/api/mx/areas/remove', { method: 'POST', body: { ids } }),

  // --------------------------------------------------------------- bakery --
  // The first two need no session: the token in the body is the whole gate.
  bakeryOpen: (token) => request('/api/bakery/open', { method: 'POST', body: { token } }),
  bakerySubmit: (body) => request('/api/bakery/submit', { method: 'POST', body }),

  bakeryForm: () => request('/api/bakery/form'),
  createProduction: (body) => request('/api/production', { method: 'POST', body }),
  productionLog: (from, to) => request(`/api/production?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  deleteProduction: (id) => request(`/api/production/${id}`, { method: 'DELETE' }),

  bakeryLinks: () => request('/api/bakery/links'),
  createBakeryLink: (label) => request('/api/bakery/links', { method: 'POST', body: { label } }),
  revokeBakeryLink: (id) => request(`/api/bakery/links/${id}`, { method: 'DELETE' }),

  // ------------------------------------------------------ notifications --
  inbox: (limit) => request(`/api/inbox${limit ? `?limit=${limit}` : ''}`),
  markInboxRead: (ids) => request('/api/inbox/read', { method: 'POST', body: { ids: ids ?? null } }),

  // -------------------------------------------------- scheduled counts --
  mxStocktakes: () => request('/api/mx/stocktakes'),
  mxMyStocktakes: () => request('/api/mx/stocktakes/mine'),
  mxCreateStocktake: (body) => request('/api/mx/stocktakes', { method: 'POST', body }),
  mxUpdateStocktake: (id, body) => request(`/api/mx/stocktakes/${id}`, { method: 'PUT', body }),
  mxDeleteStocktake: (id) => request(`/api/mx/stocktakes/${id}`, { method: 'DELETE' }),
  mxRunStocktake: (id) => request(`/api/mx/stocktakes/${id}/run`, { method: 'POST', body: {} }),
  mxCancelStocktakeTask: (id) => request(`/api/mx/stocktake-tasks/${id}/cancel`, { method: 'POST', body: {} }),

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
