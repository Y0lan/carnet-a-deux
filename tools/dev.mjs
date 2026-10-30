import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import worker from '../worker/index.js';
import { validateData } from '../public/schema.js';
import { openDatabase } from './sqlite-adapter.mjs';

const root = resolve(import.meta.dirname, '..');
const privateDir = resolve(root, '.private');
await mkdir(privateDir, { recursive: true, mode: 0o700 }); await chmod(privateDir, 0o700);
const codePath = resolve(privateDir, 'dev-code');
let code;
try { code = (await readFile(codePath, 'utf8')).trim(); }
catch (error) { if (error.code !== 'ENOENT') throw error; code = randomBytes(32).toString('base64url'); await writeFile(codePath, code, { mode: 0o600 }); }
const db = openDatabase(resolve(privateDir, 'dev.sqlite'));
db.exec(await readFile(resolve(root, 'worker/migration.sql'), 'utf8'));
const port = Number(process.env.PORT || 4173);
const origin = `http://127.0.0.1:${port}`;
const env = { DB: db, EDIT_TOKEN: code, ALLOWED_ORIGIN: origin };
const headers = { Authorization: `Bearer ${code}`, 'Content-Type': 'application/json', Origin: origin };
const existing = await worker.fetch(new Request(`${origin}/api/trip`, { headers }), env);
if (!existing.ok) throw new Error(`Le service local ne démarre pas : HTTP ${existing.status}.`);
const snapshot = await existing.json();
if (snapshot.revision === 0) {
  let initial;
  try { initial = JSON.parse(await readFile(resolve(privateDir, 'initial.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (initial) {
    validateData(initial);
    const result = await worker.fetch(new Request(`${origin}/api/trip`, { method: 'PUT', headers, body: JSON.stringify({ revision: 0, writeId: randomUUID(), data: initial }) }), env);
    if (!result.ok) throw new Error(`L'initialisation locale a échoué : HTTP ${result.status}.`);
  }
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const publicRoot = resolve(root, 'public');
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, origin);
    if (url.pathname === '/api/trip') {
      const chunks = []; let bytes = 0;
      for await (const chunk of incoming) { bytes += chunk.length; if (bytes > 540000) { outgoing.writeHead(413); outgoing.end(); return; } chunks.push(chunk); }
      const request = new Request(url, { method: incoming.method, headers: incoming.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      const response = await worker.fetch(request, env); outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (!['GET', 'HEAD'].includes(incoming.method)) { outgoing.writeHead(405); outgoing.end(); return; }
    if (url.pathname === '/config.js') { outgoing.writeHead(200, { 'Content-Type': types['.js'], 'Cache-Control': 'no-store' }); outgoing.end(`export const API_URL = '/api/trip';\n`); return; }
    const file = resolve(publicRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!file.startsWith(publicRoot + sep)) { outgoing.writeHead(403); outgoing.end(); return; }
    const body = await readFile(file);
    outgoing.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); outgoing.end(incoming.method === 'HEAD' ? undefined : body);
  } catch (error) { outgoing.writeHead(error.code === 'ENOENT' ? 404 : 500); outgoing.end('La ressource ne peut pas être chargée.'); }
});
server.on('error', (error) => {
  console.error(`Le serveur local ne peut pas écouter sur le port ${port} (${error.code}). Vérifie les droits ou choisis un autre PORT.`);
  db.close(); process.exitCode = 1;
});
server.listen(port, '127.0.0.1', async () => {
  await writeFile(resolve(privateDir, 'dev-invitation.txt'), `${origin}/#code=${encodeURIComponent(code)}\n`, { mode: 0o600 });
  console.log(`Carnet local : ${origin}/\nLien d'accès : .private/dev-invitation.txt\nLes modifications utilisent le service partagé local et SQLite.`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => { db.close(); process.exit(0); }));
