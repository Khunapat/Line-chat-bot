// Calls to /api/app with the session token. Each call reports *why* it failed
// (network, timeout, http + code) so screens can say the truth instead of
// showing an empty list.

const TIMEOUT_MS = 25_000;

export class ApiError extends Error {
  constructor(kind, { status = 0, code = '', body = null } = {}) {
    super(code || kind);
    this.kind = kind; // 'network' | 'timeout' | 'http' | 'aborted'
    this.status = status;
    this.code = code;
    this.body = body;
  }

  get isAuth() { return this.status === 401; }
  get isNetwork() { return this.kind === 'network' || this.kind === 'timeout'; }
}

let token = '';
let onAuthLost = null;

export function setToken(t) { token = t || ''; }
export function onSessionLost(fn) { onAuthLost = fn; }

/**
 * request('GET', '/planner', { query, body, signal })
 * Resolves with parsed JSON; rejects with ApiError.
 */
export async function request(method, path, { query, body, signal, auth = true } = {}) {
  const url = new URL(`/api/app${path}`, location.origin);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), TIMEOUT_MS);
  const onAbort = () => ctrl.abort('aborted');
  if (signal) {
    if (signal.aborted) ctrl.abort('aborted');
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal, credentials: 'omit' });
  } catch {
    const reason = ctrl.signal.reason;
    throw new ApiError(reason === 'aborted' ? 'aborted' : reason === 'timeout' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new ApiError('http', { status: res.status, code: json?.error || `http_${res.status}`, body: json });
    if (res.status === 401 && auth && onAuthLost) onAuthLost(err);
    throw err;
  }
  return json;
}

export const api = {
  get: (p, o) => request('GET', p, o),
  post: (p, body, o) => request('POST', p, { ...o, body: body ?? {} }),
  put: (p, body, o) => request('PUT', p, { ...o, body: body ?? {} }),
  patch: (p, body, o) => request('PATCH', p, { ...o, body: body ?? {} }),
  del: (p, o) => request('DELETE', p, o),
};

/** Random idempotency key for one save attempt (kept across retries). */
export function newKey() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
