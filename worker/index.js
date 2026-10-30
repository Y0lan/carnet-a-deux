import { MAX_DOCUMENT_BYTES, ValidationError, validateData } from '../public/schema.js';

export const MAX_BODY_BYTES = MAX_DOCUMENT_BYTES + 4096;
const encoder = new TextEncoder();
const readSql = 'SELECT revision, updated_at, document, last_write_id, last_write_hash FROM trip WHERE id = 1';

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}
async function tokenMatches(actual, expected) {
  const [a, b] = await Promise.all([digest(actual), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
function canonical(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function envelope(row) {
  if (!row) throw new Error('Stockage indisponible.');
  return { revision: row.revision, updatedAt: row.updated_at, data: JSON.parse(row.document) };
}
async function readBody(request) {
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new HttpError(413, 'Le document est trop volumineux.');
  if (!request.body) throw new HttpError(400, 'Le corps JSON est absent.');
  const reader = request.body.getReader();
  let lengthRead = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lengthRead += value.byteLength;
      if (lengthRead > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, 'Le document est trop volumineux.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(lengthRead);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, 'Le corps JSON est invalide.'); }
}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function fetchHandler(request, env) {
  const origin = request.headers.get('Origin');
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' });
  const reply = (status, value) => {
    if (value === undefined) return new Response(null, { status, headers });
    headers.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(value), { status, headers });
  };
  try {
    if (new URL(request.url).pathname !== '/api/trip') return reply(404, { error: 'Cette adresse est inconnue.' });
    if (!env.ALLOWED_ORIGIN || !/^https?:\/\/[^/]+$/.test(env.ALLOWED_ORIGIN)) throw new HttpError(503, 'Le service est indisponible.');
    if (origin !== null && origin !== env.ALLOWED_ORIGIN) throw new HttpError(403, 'Cette origine n’est pas autorisée.');
    if (origin === env.ALLOWED_ORIGIN) headers.set('Access-Control-Allow-Origin', origin);
    if (request.method === 'OPTIONS') {
      const method = request.headers.get('Access-Control-Request-Method');
      const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (!origin || !['GET', 'PUT'].includes(method) || requestedHeaders.some(value => !['authorization', 'content-type'].includes(value))) throw new HttpError(403, 'Cette requête n’est pas autorisée.');
      headers.set('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      return reply(204);
    }
    if (!['GET', 'PUT'].includes(request.method)) {
      headers.set('Allow', 'GET, PUT, OPTIONS');
      throw new HttpError(405, 'Cette méthode n’est pas autorisée.');
    }
    if (typeof env.EDIT_TOKEN !== 'string' || env.EDIT_TOKEN.length < 32 || !env.DB) throw new HttpError(503, 'Le service est indisponible.');
    const authorization = request.headers.get('Authorization') || '';
    const candidate = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!await tokenMatches(candidate, env.EDIT_TOKEN)) throw new HttpError(401, 'Le code d’accès est incorrect.');
    if (request.method === 'GET') return reply(200, envelope(await env.DB.prepare(readSql).first()));
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') || '')) throw new HttpError(415, 'Le corps doit être au format JSON.');
    const body = await readBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 3 || !Object.hasOwn(body, 'revision') || !Object.hasOwn(body, 'writeId') || !Object.hasOwn(body, 'data')) throw new HttpError(400, 'Les champs de la requête sont invalides.');
    if (!Number.isSafeInteger(body.revision) || body.revision < 0 || typeof body.writeId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.writeId)) throw new HttpError(400, 'La version ou l’identifiant d’écriture est invalide.');
    validateData(body.data);
    const document = canonical(body.data);
    const hash = Array.from(await digest(document), byte => byte.toString(16).padStart(2, '0')).join('');
    let current = await env.DB.prepare(readSql).first();
    if (!current) throw new Error('Stockage indisponible.');
    if (current.last_write_id === body.writeId) return reply(current.last_write_hash === hash ? 200 : 409, envelope(current));
    const updatedAt = new Date().toISOString();
    const result = await env.DB.prepare('UPDATE trip SET revision = revision + 1, updated_at = ?, document = ?, last_write_id = ?, last_write_hash = ? WHERE id = 1 AND revision = ? AND (last_write_id IS NULL OR last_write_id <> ?) RETURNING revision, updated_at, document, last_write_id, last_write_hash')
      .bind(updatedAt, document, body.writeId, hash, body.revision, body.writeId).first();
    if (result) return reply(200, envelope(result));
    current = await env.DB.prepare(readSql).first();
    return reply(current.last_write_id === body.writeId && current.last_write_hash === hash ? 200 : 409, envelope(current));
  } catch (error) {
    if (error instanceof ValidationError) return reply(400, { error: error.message });
    if (error instanceof HttpError) return reply(error.status, { error: error.message });
    return reply(503, { error: 'Le service est indisponible. Réessayez plus tard.' });
  }
}

export default { fetch: fetchHandler };
