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

  notifications: () => request('/api/notifications'),
  updateNotifications: (body) => request('/api/notifications', { method: 'PUT', body }),
  testNotification: () => request('/api/notifications/test', { method: 'POST' }),

  dataSummary: () => request('/api/data/summary'),
  eraseData: (body) => request('/api/data/erase', { method: 'POST', body }),

  saveStockCounts: (body) => request('/api/stock-counts', { method: 'POST', body }),
  updateSettings: (body) => request('/api/settings', { method: 'PUT', body }),

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
