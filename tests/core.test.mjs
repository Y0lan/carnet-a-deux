import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import worker, { MAX_BODY_BYTES } from '../worker/index.js';
import { emptyData, validateData, migrateData, flightInstant, flightDurationMinutes, isCivilDate, nightsBetween, sortedStages, MAX_DOCUMENT_BYTES } from '../public/schema.js';
import { mergeThreeWay, SyncClient } from '../public/sync.js';

const token = 'a-test-access-code-at-least-32-characters';
const origin = 'https://carnet.example';
const endpoint = 'https://service.example/api/trip';
const clone = value => structuredClone(value);
const migration = readFileSync(new URL('../worker/migration.sql', import.meta.url), 'utf8');
function stage(id = 'paris', extra = {}) {
  return { id, title: 'Paris', place: 'Paris, France', lat: 48.85, lng: 2.35, start: '2027-03-27', end: '2027-03-30', mood: 'culture', status: 'explorer', notes: '', experience: '', imageUrl: '', imageCredit: '', imageSource: '', ...extra };
}
function idea(id = 'hotel', extra = {}) {
  return { id, stageId: 'paris', kind: 'hotel', title: 'Un hôtel', url: 'https://example.com/hotel', details: '', cost: 100, status: 'envie', voteA: false, voteB: false, date: '', time: '', endTime: '', address: '', owner: 'both', imageUrl: '', imageCredit: '', imageSource: '', room: '', comfort: '', locationNote: '', priceBasis: 'estimate', priceNote: '', ...extra };
}
function notebook() {
  const data = emptyData(); data.stages.paris = stage(); data.ideas.hotel = idea(); return data;
}
function adapter(db) {
  return { prepare(sql) {
    let values = [];
    return { bind(...parameters) { values = parameters; return this; }, async first() { return db.prepare(sql).get(...values) || null; } };
  } };
}
function service(t, db = new DatabaseSync(':memory:')) {
  db.exec(migration);
  t.after(() => db.close());
  const env = { DB: adapter(db), EDIT_TOKEN: token, ALLOWED_ORIGIN: origin };
  const request = (method = 'GET', body, extra = {}) => worker.fetch(new Request(endpoint, {
    method,
    headers: { Origin: origin, Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra.headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'headers'))
  }), env);
  const fetcher = (url, init) => worker.fetch(new Request(url, { ...init, headers: { Origin: origin, ...init.headers } }), env);
  return { db, env, request, fetcher };
}
class Storage {
  items = new Map();
  getItem(key) { return this.items.get(key) ?? null; }
  setItem(key, value) { this.items.set(key, value); }
}
async function until(condition, message = 'État attendu absent.') {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function client(t, fetcher, storage = new Storage(), secret = token) {
  const states = [];
  const sync = new SyncClient({ endpoint, token: secret, storage, fetcher, onChange: state => states.push(state) });
  t.after(() => sync.stop());
  return { sync, states, storage, last: () => states.at(-1) };
}

test('dates civiles, années bissextiles et nuits sans effet du fuseau horaire', () => {
  assert.equal(isCivilDate('2028-02-29'), true);
  for (const value of ['2027-02-29', '2028-04-31', '2028-13-01', '0000-01-01', '2028-2-03', '2028-01-01T00:00:00Z', null]) assert.equal(isCivilDate(value), false);
  assert.equal(isCivilDate('0001-01-01'), true);
  assert.equal(nightsBetween('2027-03-27', '2027-03-30'), 3);
  assert.equal(nightsBetween('2028-02-28', '2028-03-01'), 2);
  assert.throws(() => nightsBetween('2027-04-01', '2027-04-01'));
  assert.throws(() => nightsBetween('2027-04-03', '2027-04-01'));
});

test('validation complète et ordre des étapes', () => {
  const data = notebook();
  data.stages.rome = stage('rome', { start: '2027-03-26' }); data.stages.amsterdam = stage('amsterdam');
  assert.equal(validateData(data), data);
  assert.deepEqual(sortedStages(data).map(item => item.id), ['rome', 'amsterdam', 'paris']);
});

test('liens, références, nombres, champs inconnus et textes sont contrôlés', () => {
  for (const url of ['', 'https://example.com/a?b=1#c', 'http://example.com/']) {
    const data = notebook(); data.ideas.hotel.url = url; assert.doesNotThrow(() => validateData(data));
  }
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', '//example.com', '/local', 'https://user:pass@example.com/', ' https://example.com', 'https://example.com/\n']) {
    const data = notebook(); data.ideas.hotel.url = url; assert.throws(() => validateData(data), /lien/i);
  }
  for (const mutate of [
    data => { data.ideas.hotel.stageId = 'absent'; }, data => { data.ideas.hotel.cost = -1; },
    data => { data.ideas.hotel.cost = Infinity; }, data => { data.ideas.hotel.voteA = 'true'; },
    data => { data.stages.paris.lat = NaN; }, data => { data.stages.paris.lng = 181; },
    data => { data.stages.paris.end = data.stages.paris.start; }, data => { data.stages.paris.id = 'autre'; },
    data => { data.stages.paris.notes = 'a'.repeat(12001); }, data => { data.trip.personA = ''; },
    data => { data.ideas.hotel.kind = 'unknown'; }, data => { data.extra = true; },
    data => { data.stages.paris.extra = true; }, data => { data.ideas.hotel.extra = true; }
  ]) { const data = notebook(); mutate(data); assert.throws(() => validateData(data)); }
  const pollution = JSON.parse(JSON.stringify(emptyData()).replace('"stages":{}', '"stages":{"__proto__":{}}'));
  assert.throws(() => validateData(pollution));
  const constructor = emptyData(); constructor.stages.constructor = stage('constructor'); assert.throws(() => validateData(constructor));
});

test('limites de fiches et limite UTF-8 de 512 Kio', () => {
  const stages = emptyData();
  for (let n = 0; n < 61; n++) stages.stages[`s${n}`] = stage(`s${n}`);
  assert.throws(() => validateData(stages), /trop de fiches/);
  const ideas = notebook();
  for (let n = 0; n < 500; n++) ideas.ideas[`i${n}`] = idea(`i${n}`);
  assert.throws(() => validateData(ideas), /trop de fiches/);
  const large = emptyData();
  for (let n = 0; n < 45; n++) large.stages[`s${n}`] = stage(`s${n}`, { notes: 'é'.repeat(6000) });
  assert.ok(new TextEncoder().encode(JSON.stringify(large)).length > MAX_DOCUMENT_BYTES);
  assert.throws(() => validateData(large), /512 Kio/);
});

test('authentification, CORS, absence de cache et erreurs sans secret', async t => {
  const { request, env } = service(t);
  for (const authorization of ['', 'Bearer wrong', 'Basic xyz']) {
    const response = await request('GET', undefined, { headers: { Authorization: authorization } });
    assert.equal(response.status, 401); assert.equal((await response.text()).includes(token), false);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  const rejected = await request('GET', undefined, { headers: { Origin: 'https://evil.example' } });
  assert.equal(rejected.status, 403); assert.equal(rejected.headers.has('Access-Control-Allow-Origin'), false);
  const good = await request();
  assert.equal(good.status, 200); assert.equal(good.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(good.headers.get('Vary'), 'Origin'); assert.equal(good.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(migrateData((await good.json()).data), emptyData());
  const preflight = await request('OPTIONS', undefined, { headers: { Authorization: '', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'Authorization, Content-Type' } });
  assert.equal(preflight.status, 204);
  assert.equal((await request('OPTIONS', undefined, { headers: { 'Access-Control-Request-Method': 'DELETE' } })).status, 403);
  assert.equal((await request('OPTIONS', undefined, { headers: { 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'X-Forbidden' } })).status, 403);
  const broken = { ...env, DB: { prepare() { throw new Error(token); } } };
  const response = await worker.fetch(new Request(endpoint, { headers: { Authorization: `Bearer ${token}` } }), broken);
  assert.equal(response.status, 503); assert.equal((await response.text()).includes(token), false);
  assert.equal((await worker.fetch(new Request(endpoint), { ...env, EDIT_TOKEN: 'short' })).status, 503);
});

test('MIME, enveloppe, dates et taille des corps sont rejetés avant écriture', async t => {
  const { request, db, env } = service(t);
  const body = { revision: 0, writeId: 'first', data: notebook() };
  assert.equal((await request('PUT', body, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('PUT', '{')).status, 400);
  assert.equal((await request('PUT', { ...body, extra: true })).status, 400);
  assert.equal((await request('PUT', { ...body, revision: -1 })).status, 400);
  assert.equal((await request('PUT', { ...body, writeId: '../bad' })).status, 400);
  const bad = clone(body); bad.data.stages.paris.start = '2027-02-29';
  assert.equal((await request('PUT', bad)).status, 400);
  assert.equal((await request('PUT', body, { headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) } })).status, 413);
  let pulled = 0;
  const stream = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(128 * 1024)); if (pulled > 20) controller.close(); } });
  const streamed = new Request(endpoint, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: stream, duplex: 'half' });
  assert.equal(streamed.headers.has('Content-Length'), false); assert.equal((await worker.fetch(streamed, env)).status, 413);
  assert.ok(pulled < 10, 'La lecture doit cesser avant la fin du flux.');
  assert.equal(db.prepare('SELECT revision FROM trip').get().revision, 0);
});

test('SQLite : deux connexions concurrentes et rejeu idempotent', async t => {
  const directory = mkdtempSync(join(process.env.CARNET_TEST_TMP || '/tmp', 'carnet-core-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = service(t, new DatabaseSync(join(directory, 'trip.sqlite')));
  const second = service(t, new DatabaseSync(join(directory, 'trip.sqlite')));
  const a = notebook(); a.trip.personA = 'Alice'; const b = notebook(); b.trip.personB = 'Bob';
  const bodies = [{ revision: 0, writeId: 'writer-a', data: a }, { revision: 0, writeId: 'writer-b', data: b }];
  const responses = await Promise.all([first.request('PUT', bodies[0]), second.request('PUT', bodies[1])]);
  assert.deepEqual(responses.map(value => value.status).sort(), [200, 409]);
  const winner = responses[0].status === 200 ? 0 : 1;
  const received = await Promise.all(responses.map(value => value.json()));
  assert.equal(received[0].revision, 1); assert.deepEqual(received[0], received[1]);
  const retry = await first.request('PUT', bodies[winner]);
  assert.equal(retry.status, 200); assert.equal((await retry.json()).revision, 1);
  const reordered = clone(bodies[winner]);
  reordered.data.trip = { personB: reordered.data.trip.personB, personA: reordered.data.trip.personA, title: reordered.data.trip.title };
  assert.equal((await first.request('PUT', reordered)).status, 200);
  const reuse = clone(bodies[winner]); reuse.revision = 1; reuse.data.trip.title = 'Autre contenu';
  assert.equal((await first.request('PUT', reuse)).status, 409);
  assert.equal((await first.request('PUT', bodies[1 - winner])).status, 409);
  assert.equal(first.db.prepare('SELECT revision FROM trip').get().revision, 1);
});

test('fusion par champ, suppression et absence de mutation des entrées', () => {
  const base = notebook(); const local = clone(base); local.trip.personA = 'Alice';
  const remote = clone(base); remote.trip.personB = 'Bob';
  const merged = mergeThreeWay(base, local, remote);
  assert.deepEqual(merged.conflicts, []); assert.equal(merged.data.trip.personA, 'Alice'); assert.equal(merged.data.trip.personB, 'Bob');
  remote.trip.personA = 'Autre'; assert.deepEqual(mergeThreeWay(base, local, remote).conflicts, ['/trip/personA']);
  remote.trip.personA = 'Alice'; assert.deepEqual(mergeThreeWay(base, local, remote).conflicts, []);
  delete local.ideas.hotel; remote.ideas.hotel.title = 'Un autre hôtel';
  assert.deepEqual(mergeThreeWay(base, local, remote).conflicts, ['/ideas/hotel']);
  assert.equal(Object.hasOwn(mergeThreeWay(base, local, remote).data.ideas, 'hotel'), false);
  assert.equal(base.ideas.hotel.title, 'Un hôtel');
});

test('les interactions invalides entre références ou dates exigent un choix', () => {
  const base = notebook(); const local = clone(base); delete local.stages.paris; delete local.ideas.hotel;
  const remote = clone(base); remote.ideas.musee = idea('musee', { kind: 'activite' });
  const result = mergeThreeWay(base, local, remote);
  assert.ok(result.conflicts.includes('/')); assert.deepEqual(result.data, local); validateData(result.data);
  const a = clone(base); a.stages.paris.start = '2027-03-29'; const b = clone(base); b.stages.paris.end = '2027-03-28';
  assert.ok(mergeThreeWay(base, a, b).conflicts.includes('/'));
});

test('client : sauvegarde confirmée et brouillon écrit avant le PUT', async t => {
  const server = service(t); const storage = new Storage(); let persistedBeforeSend = false;
  const c = client(t, async (url, init) => {
    if (init.method === 'PUT') persistedBeforeSend = [...storage.items.values()].some(raw => JSON.parse(raw).pending?.writeId === JSON.parse(init.body).writeId);
    return server.fetcher(url, init);
  }, storage);
  await c.sync.start(); assert.equal(c.last().status, 'saved');
  const data = clone(c.last().data); data.trip.title = 'Départ ensemble'; c.sync.change(data);
  assert.equal(c.last().status, 'saving');
  assert.equal(JSON.parse([...storage.items.values()][0]).local.trip.title, 'Départ ensemble');
  await until(() => c.last().status === 'saved' && c.last().revision === 1);
  assert.equal(persistedBeforeSend, true);
  assert.equal((await (await server.request()).json()).data.trip.title, 'Départ ensemble');
  assert.equal([...storage.items.values()].join('').includes(token), false);
  assert.equal([...storage.items.keys()].join('').includes(token), false);
});

test('client : mutations pendant un PUT conservées après le premier accusé', async t => {
  const server = service(t); let release; let entered;
  const gate = new Promise(resolve => { entered = resolve; });
  const c = client(t, async (url, init) => {
    if (init.method === 'PUT' && !release) { entered(); await new Promise(resolve => { release = resolve; }); }
    return server.fetcher(url, init);
  });
  await c.sync.start();
  const first = clone(c.last().data); first.trip.personA = 'Alice'; c.sync.change(first); await gate;
  const second = clone(first); second.trip.personB = 'Bob'; c.sync.change(second); release();
  await until(() => c.last().status === 'saved' && c.last().revision === 2);
  assert.equal(c.last().data.trip.personB, 'Bob');
  assert.equal((await (await server.request()).json()).data.trip.personB, 'Bob');
  assert.ok(c.states.some(state => state.revision === 1 && state.status === 'saving' && state.data.trip.personB === 'Bob'));
});

test('client : deux sessions, fusion indépendante et conflit de champ', async t => {
  const server = service(t); const a = client(t, server.fetcher); const b = client(t, server.fetcher);
  await Promise.all([a.sync.start(), b.sync.start()]);
  const local = clone(a.last().data); local.trip.personA = 'Alice'; a.sync.change(local);
  const remote = clone(b.last().data); remote.trip.personB = 'Bob'; b.sync.change(remote);
  await until(() => a.last().status === 'saved' && b.last().status === 'saved' && Math.max(a.last().revision, b.last().revision) === 2);
  await a.sync.refresh(); await b.sync.refresh();
  assert.equal(a.last().data.trip.personA, 'Alice'); assert.equal(a.last().data.trip.personB, 'Bob');
  const aa = clone(a.last().data); aa.trip.title = 'Choix A'; a.sync.change(aa);
  const bb = clone(b.last().data); bb.trip.title = 'Choix B'; b.sync.change(bb);
  await until(() => a.last().status === 'conflict' || b.last().status === 'conflict');
  const conflict = a.last().status === 'conflict' ? a : b;
  assert.deepEqual(conflict.last().conflicts, ['/trip/title']);
  const chosen = conflict.last().data.trip.title; conflict.sync.resolveConflict('local');
  await until(() => conflict.last().status === 'saved');
  assert.equal((await (await server.request()).json()).data.trip.title, chosen);
});

test('client : un GET distant ne remplace pas un brouillon modifié', async t => {
  const server = service(t); const c = client(t, server.fetcher); await c.sync.start();
  const local = clone(c.last().data); local.trip.personA = 'Alice'; c.sync.change(local);
  const remote = emptyData(); remote.trip.personB = 'Bob';
  await server.request('PUT', { revision: 0, writeId: 'remote', data: remote }); await c.sync.refresh();
  assert.equal(c.last().data.trip.personA, 'Alice'); assert.equal(c.last().data.trip.personB, 'Bob'); assert.equal(c.last().status, 'saving');
  await until(() => c.last().status === 'saved' && c.last().revision === 2);
});

test('client : réponse perdue, rechargement et rejeu sans doubler la version', async t => {
  const server = service(t); const storage = new Storage(); let loseResponse = true; let writeId;
  const c = client(t, async (url, init) => {
    const response = await server.fetcher(url, init);
    if (init.method === 'PUT' && loseResponse) { writeId = JSON.parse(init.body).writeId; loseResponse = false; throw new Error('Réponse perdue.'); }
    return response;
  }, storage);
  await c.sync.start();
  const data = clone(c.last().data); data.trip.title = 'Brouillon conservé'; c.sync.change(data);
  await until(() => c.last().status === 'offline');
  assert.equal(c.last().revision, 0); assert.equal(server.db.prepare('SELECT revision FROM trip').get().revision, 1); c.sync.stop();
  const methods = []; let replay;
  const reloaded = client(t, (url, init) => { methods.push(init.method); if (init.method === 'PUT') replay = JSON.parse(init.body); return server.fetcher(url, init); }, storage);
  await reloaded.sync.start();
  assert.deepEqual(methods.slice(0, 2), ['GET', 'PUT']); assert.equal(replay.writeId, writeId);
  assert.equal(reloaded.last().status, 'saved'); assert.equal(reloaded.last().revision, 1);
  assert.equal(reloaded.last().data.trip.title, 'Brouillon conservé'); assert.equal(server.db.prepare('SELECT revision FROM trip').get().revision, 1);
});

test('client : reprise après coupure et isolation des brouillons selon le code', async t => {
  const server = service(t); const storage = new Storage(); let online = true;
  const c = client(t, (url, init) => online ? server.fetcher(url, init) : Promise.reject(new Error('offline')), storage);
  await c.sync.start(); online = false;
  const data = clone(c.last().data); data.trip.personA = 'Alice'; c.sync.change(data);
  await until(() => c.last().status === 'offline'); c.sync.stop();
  const other = client(t, server.fetcher, storage, 'another-access-code-at-least-32-chars'); await other.sync.start();
  assert.equal(other.last().status, 'error'); assert.equal(other.last().data, null); online = true;
  const resumed = client(t, server.fetcher, storage); await resumed.sync.start();
  assert.equal(resumed.last().status, 'saved'); assert.equal(resumed.last().data.trip.personA, 'Alice'); assert.equal(resumed.last().revision, 1);
});

test('client : choisir distant conserve les modifications indépendantes locales', async t => {
  const server = service(t); const c = client(t, server.fetcher); await c.sync.start();
  const local = clone(c.last().data); local.trip.title = 'Local'; local.trip.personA = 'Alice'; c.sync.change(local);
  const remote = emptyData(); remote.trip.title = 'Distant';
  await server.request('PUT', { revision: 0, writeId: 'remote', data: remote }); await c.sync.refresh(); assert.equal(c.last().status, 'conflict');
  c.sync.resolveConflict('remote'); assert.equal(c.last().data.trip.title, 'Distant'); assert.equal(c.last().data.trip.personA, 'Alice');
  await until(() => c.last().status === 'saved');
});

test('client : stockage plein, aucun envoi et conservation en mémoire', async t => {
  const server = service(t); const storage = new Storage(); const c = client(t, server.fetcher, storage); await c.sync.start();
  storage.setItem = () => { throw new Error('QuotaExceeded'); };
  const data = clone(c.last().data); data.trip.title = 'À conserver'; assert.throws(() => c.sync.change(data), /appareil/);
  assert.equal(c.last().status, 'error'); assert.equal(c.last().data.trip.title, 'À conserver');
  await new Promise(resolve => setTimeout(resolve, 350)); assert.equal(server.db.prepare('SELECT revision FROM trip').get().revision, 0);
});

test('client : brouillon corrompu conservé et arrêt des temporisateurs', async t => {
  const server = service(t); const storage = new Storage(); const c = client(t, server.fetcher, storage); await c.sync.start(); c.sync.stop();
  const key = [...storage.items.keys()][0]; storage.setItem(key, '{corrompu');
  const reloaded = client(t, server.fetcher, storage); await reloaded.sync.start();
  assert.equal(reloaded.last().status, 'error'); assert.match(reloaded.last().error, /illisible/); assert.equal(storage.getItem(key), '{corrompu');
  reloaded.sync.stop(); assert.equal(reloaded.sync.timer, null); assert.equal(reloaded.sync.interval, null);
});

test('client : édition pendant un GET et modification identique sans fausse attente', async t => {
  const server = service(t); let hold = false; let release; let entered;
  const gate = new Promise(resolve => { entered = resolve; });
  const c = client(t, async (url, init) => {
    if (init.method === 'GET' && hold) { entered(); await new Promise(resolve => { release = resolve; }); }
    return server.fetcher(url, init);
  });
  await c.sync.start(); c.sync.change(c.last().data); assert.equal(c.last().status, 'saved');
  hold = true; const reading = c.sync.refresh(); await gate;
  const data = clone(c.last().data); data.trip.personA = 'Alice'; c.sync.change(data); hold = false; release(); await reading;
  assert.equal(c.last().data.trip.personA, 'Alice'); assert.equal(c.last().status, 'saving');
  await until(() => c.last().status === 'saved' && c.last().revision === 1);
});

test('client : conflit conservé après rechargement et nouveaux changements distants', async t => {
  const server = service(t); const storage = new Storage(); const c = client(t, server.fetcher, storage); await c.sync.start();
  const local = clone(c.last().data); local.trip.title = 'Local'; local.trip.personA = 'Alice'; c.sync.change(local);
  const remote = emptyData(); remote.trip.title = 'Distant';
  await server.request('PUT', { revision: 0, writeId: 'r1', data: remote }); await c.sync.refresh();
  assert.equal(c.last().status, 'conflict'); c.sync.stop();
  const reloaded = client(t, server.fetcher, storage); await reloaded.sync.start();
  assert.equal(reloaded.last().status, 'conflict'); assert.equal(reloaded.last().data.trip.title, 'Local');
  remote.trip.personB = 'Bob'; await server.request('PUT', { revision: 1, writeId: 'r2', data: remote }); await reloaded.sync.refresh();
  assert.equal(reloaded.last().status, 'conflict'); assert.equal(reloaded.last().data.trip.personB, 'Bob');
  reloaded.sync.resolveConflict('remote'); assert.equal(reloaded.last().data.trip.personA, 'Alice');
  await until(() => reloaded.last().status === 'saved');
  const final = (await (await server.request()).json()).data;
  assert.equal(final.trip.title, 'Distant'); assert.equal(final.trip.personA, 'Alice'); assert.equal(final.trip.personB, 'Bob');
});

test('client : un accusé invalide ne confirme pas la sauvegarde', async t => {
  const server = service(t); const c = client(t, async (url, init) => {
    if (init.method === 'PUT') return Response.json({ revision: 1, updatedAt: new Date().toISOString(), data: emptyData() });
    return server.fetcher(url, init);
  });
  await c.sync.start(); const data = clone(c.last().data); data.trip.title = 'Mon brouillon'; c.sync.change(data);
  await until(() => c.last().status === 'error');
  assert.equal(c.last().revision, 0); assert.equal(c.last().data.trip.title, 'Mon brouillon');
  assert.ok(JSON.parse([...c.storage.items.values()][0]).pending);
  assert.equal(server.db.prepare('SELECT revision FROM trip').get().revision, 0);
});

test('régression : restauration refusée, refresh et écritures restent bloqués jusqu’à une reprise explicite', async t => {
  const server = service(t); const storage = new Storage();
  const initial = client(t, server.fetcher, storage); await initial.sync.start(); initial.sync.stop();
  const key = [...storage.items.keys()][0]; const valid = storage.getItem(key);
  const fragment = '{recoverable-fragment'; storage.setItem(key, fragment);
  let calls = 0;
  const restored = client(t, (url, init) => { calls++; return server.fetcher(url, init); }, storage);
  await restored.sync.start();
  assert.equal(restored.last().status, 'error'); assert.equal(restored.sync.running, false);
  assert.equal(restored.sync.ready, false); assert.equal(restored.sync.interval, null);
  await restored.sync.refresh(); restored.sync.resume(); await Promise.resolve();
  assert.throws(() => restored.sync.change(emptyData()), /fermé/);
  assert.throws(() => restored.sync.resolveConflict('remote'), /fermé/);
  assert.equal(calls, 0); assert.equal(storage.getItem(key), fragment);
  assert.equal(restored.last().status, 'error');
  // Repairing the record alone does not resume access. start() is explicit.
  storage.setItem(key, valid); await restored.sync.refresh(); assert.equal(calls, 0);
  await restored.sync.start(); assert.equal(calls, 1); assert.equal(restored.last().status, 'saved');
});

test('régression : un stockage partagé possède un seul éditeur et conserve chaque modification acceptée hors ligne', async t => {
  const server = service(t); const storage = new Storage(); let online = true;
  const fetcher = (url, init) => online ? server.fetcher(url, init) : Promise.reject(new Error('offline'));
  const a = client(t, fetcher, storage); const b = client(t, fetcher, storage);
  await Promise.all([a.sync.start(), b.sync.start()]);
  const owner = a.last().status === 'saved' ? a : b;
  const blocked = owner === a ? b : a;
  assert.equal(blocked.last().status, 'error'); assert.equal(blocked.last().data, null);
  assert.match(blocked.last().error, /autre onglet/);
  online = false;
  const draftA = clone(owner.last().data); draftA.trip.personA = 'Draft A'; owner.sync.change(draftA);
  const before = storage.getItem([...storage.items.keys()][0]);
  const rejected = emptyData(); rejected.trip.personB = 'Draft B';
  assert.throws(() => blocked.sync.change(rejected), /fermé/);
  await blocked.sync.refresh(); assert.equal(storage.getItem([...storage.items.keys()][0]), before);
  await until(() => owner.last().status === 'offline'); owner.sync.stop();
  await blocked.sync.start(); assert.equal(blocked.last().status, 'offline');
  assert.equal(blocked.last().data.trip.personA, 'Draft A');
  const draftB = clone(blocked.last().data); draftB.trip.personB = 'Draft B'; blocked.sync.change(draftB); blocked.sync.stop();
  const reloaded = client(t, fetcher, storage); await reloaded.sync.start();
  assert.equal(reloaded.last().status, 'offline'); assert.equal(reloaded.last().data.trip.personA, 'Draft A'); assert.equal(reloaded.last().data.trip.personB, 'Draft B');
  online = true; await reloaded.sync.refresh();
  await until(() => reloaded.last().status === 'saved' && reloaded.last().revision === 2);
  const saved = (await (await server.request()).json()).data;
  assert.equal(saved.trip.personA, 'Draft A'); assert.equal(saved.trip.personB, 'Draft B');
});

test('Web Locks réel : accès exclusif, libération par stop et restauration du brouillon', { skip: !globalThis.navigator?.locks?.request }, async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storage = new Storage();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
  });
  const server = service(t); let online = true;
  const fetcher = (url, init) => online ? server.fetcher(url, init) : Promise.reject(new Error('offline'));
  const a = client(t, fetcher, storage); const b = client(t, fetcher, storage);
  await a.sync.start(); await b.sync.start();
  assert.equal(a.last().status, 'saved'); assert.equal(b.last().status, 'error');
  assert.match(b.last().error, /autre onglet/); assert.equal(b.last().data, null);
  online = false;
  const draft = clone(a.last().data); draft.trip.title = 'Mon brouillon exclusif'; a.sync.change(draft); a.sync.stop();
  await b.sync.start(); assert.equal(b.last().status, 'offline'); assert.equal(b.last().data.trip.title, 'Mon brouillon exclusif');
  b.sync.stop();
});

test('navigateur sans Web Locks : refus avant lecture et écriture du cache', async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else delete globalThis.window;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
  });
  const storage = new Storage(); let calls = 0;
  const c = client(t, () => { calls++; throw new Error('Aucun accès attendu.'); }, storage);
  await c.sync.start();
  assert.equal(c.last().status, 'error'); assert.match(c.last().error, /navigateur récent/);
  await c.sync.refresh(); assert.throws(() => c.sync.change(emptyData()), /fermé/);
  assert.equal(calls, 0); assert.equal(storage.items.size, 0);
});

function legacyData(value = notebook()) {
  const data = clone(value);
  data.schemaVersion = 1;
  delete data.flights; delete data.shopping;
  for (const stage of Object.values(data.stages)) for (const field of ['experience', 'imageUrl', 'imageCredit', 'imageSource']) delete stage[field];
  for (const idea of Object.values(data.ideas)) for (const field of ['date', 'time', 'endTime', 'address', 'owner', 'imageUrl', 'imageCredit', 'imageSource', 'room', 'comfort', 'locationNote', 'priceBasis', 'priceNote']) delete idea[field];
  return data;
}
function flight(extra = {}) {
  return { id: 'f1', title: 'Premier vol', from: 'Départ', to: 'Arrivée', departure: '', arrival: '', departureZone: '', arrivalZone: '', number: '', traveler: 'both', status: 'explorer', url: '', notes: '', fromStageId: '', toStageId: '', ...extra };
}
function shopping(extra = {}) {
  return { id: 's1', title: 'Un objet', category: 'camping', owner: 'both', status: 'comparer', url: '', cost: null, currency: 'EUR', notes: '', stageId: '', voteA: false, voteB: false, ...extra };
}

test('migration v1 : mêmes notes, préférences et identifiants, sans mutation ni perte', () => {
  const legacy = legacyData(); legacy.ideas.hotel.voteB = true; legacy.stages.paris.notes = 'Note privée de test';
  const before = clone(legacy); const current = migrateData(legacy);
  assert.equal(validateData(legacy), legacy); assert.equal(current.schemaVersion, 2);
  assert.deepEqual(legacy, before); assert.deepEqual(legacyData(current).ideas, legacy.ideas);
  assert.deepEqual(current.trip, legacy.trip); assert.deepEqual(current.flights, {}); assert.deepEqual(current.shopping, {});
  assert.deepEqual(legacyData(current), legacy); assert.deepEqual(migrateData(current), current);
  assert.equal(current.stages.paris.experience, '');
});

test('vols : heures locales, changement de date, décalages fractionnaires et durée réelle', () => {
  assert.equal(flightInstant('', ''), null);
  assert.equal(flightInstant('2027-01-12T12:00', 'Europe/Paris'), Date.parse('2027-01-12T11:00:00Z'));
  assert.equal(flightInstant('2027-08-12T12:00', 'Europe/Paris'), Date.parse('2027-08-12T10:00:00Z'));
  assert.equal(flightInstant('2027-01-12T12:00', 'Asia/Kathmandu'), Date.parse('2027-01-12T06:15:00Z'));
  assert.equal(flightInstant('2027-01-12T00:00', 'Pacific/Auckland'), Date.parse('2027-01-11T11:00:00Z'));
  const overnight = flight({ departure: '2027-01-12T23:00', arrival: '2027-01-13T08:00', departureZone: 'America/New_York', arrivalZone: 'Europe/Paris' });
  assert.equal(flightDurationMinutes(overnight), 180);
  assert.equal(flightDurationMinutes(flight({ departure: '2027-01-12T23:00', departureZone: 'UTC' })), null);
  assert.throws(() => flightInstant('2027-03-28T02:30', 'Europe/Paris'), /n’existe pas/);
  assert.throws(() => flightInstant('2027-10-31T02:30', 'Europe/Paris'), /se répète/);
  for (const local of ['2027-02-29T12:00', '2027-01-01T24:00', '2027-01-01T12:60', '2027-01-01T12:00Z']) assert.throws(() => flightInstant(local, 'UTC'));
  assert.throws(() => flightInstant('2027-01-01T12:00', 'Invalid/Zone'));
});

test('validation v2 : vols, shopping, sources des photos et références', () => {
  const original = notebook(); original.flights.f1 = flight(); original.shopping.s1 = shopping();
  assert.equal(validateData(original), original);
  for (const mutate of [
    data => { data.flights.f1.departure = '2027-01-01T12:00'; },
    data => { data.flights.f1.arrivalZone = 'Invalid/Zone'; },
    data => { data.flights.f1.fromStageId = 'missing'; },
    data => { data.flights.f1.traveler = 'other'; },
    data => { data.flights.f1.status = 'paid'; },
    data => { data.flights.f1.number = 'x'.repeat(81); },
    data => { data.shopping.s1.stageId = 'missing'; },
    data => { data.shopping.s1.cost = -5; },
    data => { data.shopping.s1.currency = 'XXX'; },
    data => { data.shopping.s1.owner = ''; },
    data => { data.shopping.s1.voteA = 1; },
    data => { data.shopping.s1.category = 'unknown'; },
    data => { data.stages.paris.imageUrl = 'http://example.com/photo.jpg'; },
    data => { data.stages.paris.imageSource = 'javascript:alert(1)'; }
  ]) { const data = clone(original); mutate(data); assert.throws(() => validateData(data)); }
  const reversed = clone(original);
  Object.assign(reversed.flights.f1, { departure: '2027-01-12T18:00', arrival: '2027-01-12T21:00', departureZone: 'Europe/Paris', arrivalZone: 'Asia/Tokyo' });
  assert.throws(() => validateData(reversed), /arrivée doit suivre/);
  original.stages.paris.imageUrl = 'https://example.com/photo.jpg';
  original.stages.paris.imageSource = 'https://example.com/credit';
  original.shopping.s1.stageId = 'paris'; original.flights.f1.toStageId = 'paris';
  assert.doesNotThrow(() => validateData(original));
});

test('Worker : une ancienne interface ne peut pas effacer les nouvelles collections', async t => {
  const server = service(t);
  const old = legacyData();
  assert.equal((await server.request('PUT', { revision: 0, writeId: 'legacy', data: old })).status, 200);
  const upgraded = migrateData(old); upgraded.shopping.s1 = shopping(); upgraded.flights.f1 = flight();
  assert.equal((await server.request('PUT', { revision: 1, writeId: 'upgrade', data: upgraded })).status, 200);
  old.trip.title = 'Ancien navigateur';
  const rejected = await server.request('PUT', { revision: 2, writeId: 'legacy-late', data: old });
  assert.equal(rejected.status, 426); assert.match((await rejected.json()).error, /Recharge/);
  const after = await (await server.request()).json();
  assert.equal(after.revision, 2); assert.deepEqual(after.data, upgraded);
});

test('cache v1 : migration d’un brouillon non envoyé puis fusion avec les choix distants', async t => {
  const server = service(t); const storage = new Storage(); const first = client(t, server.fetcher, storage);
  await first.sync.start(); first.sync.stop();
  const key = [...storage.items.keys()][0]; const cache = JSON.parse(storage.getItem(key));
  cache.base.data = legacyData(); cache.local = legacyData(); cache.local.trip.personA = 'Modification locale';
  storage.setItem(key, JSON.stringify(cache));
  const remote = notebook(); remote.shopping.s1 = shopping();
  await server.request('PUT', { revision: 0, writeId: 'new-interface', data: remote });
  const restored = client(t, server.fetcher, storage); await restored.sync.start();
  await until(() => restored.last().status === 'saved');
  assert.equal(restored.last().data.schemaVersion, 2); assert.equal(restored.last().data.trip.personA, 'Modification locale');
  assert.deepEqual(restored.last().data.shopping.s1, shopping());
});

test('cache v1 : réponse perdue migrée sans réutiliser l’identifiant ni doubler une écriture', async t => {
  const server = service(t); const storage = new Storage(); const first = client(t, server.fetcher, storage);
  await first.sync.start(); first.sync.stop();
  const key = [...storage.items.keys()][0]; const cache = JSON.parse(storage.getItem(key));
  cache.base.data = legacyData(); cache.local = legacyData(); cache.local.trip.title = 'Ancien brouillon';
  cache.pending = { revision: 0, writeId: 'legacy-pending', data: clone(cache.local) };
  assert.equal((await server.request('PUT', cache.pending)).status, 200);
  storage.setItem(key, JSON.stringify(cache)); let sent;
  const restored = client(t, (url, init) => { if (init.method === 'PUT') sent = JSON.parse(init.body); return server.fetcher(url, init); }, storage);
  await restored.sync.start();
  assert.equal(restored.last().status, 'saved'); assert.equal(restored.last().revision, 1);
  assert.equal(restored.last().data.trip.title, 'Ancien brouillon');
  assert.notEqual(sent.writeId, 'legacy-pending'); assert.equal(sent.data.schemaVersion, 2);
  assert.equal(server.db.prepare('SELECT revision FROM trip').get().revision, 1);
});

test('cache v1 : conflit conservé après migration, choix explicite et données v2 préservées', async t => {
  const server = service(t); const storage = new Storage(); const first = client(t, server.fetcher, storage);
  await first.sync.start(); first.sync.stop();
  const key = [...storage.items.keys()][0]; const cache = JSON.parse(storage.getItem(key));
  cache.base.data = legacyData(); cache.base.data.trip.title = 'Distant';
  cache.local = legacyData(); cache.local.trip.title = 'Local';
  cache.conflict = { base: legacyData(), local: clone(cache.local), remote: clone(cache.base.data) };
  storage.setItem(key, JSON.stringify(cache));
  const remote = migrateData(cache.base.data); remote.shopping.s1 = shopping();
  await server.request('PUT', { revision: 0, writeId: 'new-data', data: remote });
  const restored = client(t, server.fetcher, storage); await restored.sync.start();
  assert.equal(restored.last().status, 'conflict'); assert.deepEqual(restored.last().conflicts, ['/trip/title']);
  restored.sync.resolveConflict('local'); await until(() => restored.last().status === 'saved');
  assert.equal(restored.last().data.trip.title, 'Local'); assert.deepEqual(restored.last().data.shopping.s1, shopping());
});

test('deux appareils : votes shopping et horaire du vol fusionnés sans perte', async t => {
  const server = service(t); const data = notebook(); data.shopping.s1 = shopping(); data.flights.f1 = flight();
  await server.request('PUT', { revision: 0, writeId: 'initial-v2', data });
  const a = client(t, server.fetcher); const b = client(t, server.fetcher);
  await Promise.all([a.sync.start(), b.sync.start()]);
  const left = clone(a.last().data); left.shopping.s1.voteA = true; left.flights.f1.departure = '2027-01-12T12:00'; left.flights.f1.departureZone = 'Europe/Paris';
  const right = clone(b.last().data); right.shopping.s1.voteB = true; right.flights.f1.arrival = '2027-01-12T13:00'; right.flights.f1.arrivalZone = 'Europe/London';
  a.sync.change(left); b.sync.change(right);
  await until(() => a.last().status === 'saved' && b.last().status === 'saved' && Math.max(a.last().revision, b.last().revision) === 3);
  await a.sync.refresh();
  assert.equal(a.last().data.shopping.s1.voteA, true); assert.equal(a.last().data.shopping.s1.voteB, true);
  assert.equal(flightDurationMinutes(a.last().data.flights.f1), 120);
  const base = a.last().data; const local = clone(base); const remote = clone(base);
  local.flights.f1.departure = '2027-01-12T13:00'; remote.flights.f1.departure = '2027-01-12T11:00';
  assert.deepEqual(mergeThreeWay(base, local, remote).conflicts, ['/flights/f1/departure']);
  local.flights.f1.departure = base.flights.f1.departure;
  delete local.stages.paris; delete local.ideas.hotel;
  remote.shopping.s1.stageId = 'paris';
  assert.ok(mergeThreeWay(base, local, remote).conflicts.includes('/'));
});

test('Worker : la protection v2 reste atomique pendant une écriture v1 concurrente', async t => {
  const server = service(t); const original = server.env.DB;
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  server.env.DB = { prepare(sql) {
    const statement = original.prepare(sql); let parameters = [];
    return {
      bind(...values) { parameters = values; statement.bind(...values); return this; },
      async first() {
        if (sql.startsWith('UPDATE') && parameters[2] === 'legacy-race') {
          enter(); await new Promise(resolve => { release = resolve; });
        }
        return statement.first();
      }
    };
  } };
  // A caller may announce a future revision. The schema guard must remain true at UPDATE time.
  const legacy = server.request('PUT', { revision: 1, writeId: 'legacy-race', data: legacyData() });
  await entered;
  const upgraded = notebook(); upgraded.shopping.s1 = shopping();
  const response = await server.request('PUT', { revision: 0, writeId: 'upgrade-race', data: upgraded });
  release();
  assert.equal(response.status, 200); assert.equal((await legacy).status, 426);
  const after = await (await server.request()).json();
  assert.equal(after.revision, 1); assert.deepEqual(after.data, upgraded);
});

test('agenda : nouveaux lieux, dates et horaires locaux, y compris les soirées après minuit', () => {
  const data = notebook();
  for (const kind of ['restaurant', 'boutique', 'exposition', 'lieu', 'evenement']) {
    data.ideas.hotel.kind = kind;
    Object.assign(data.ideas.hotel, { date: '2027-04-12', time: '22:00', endTime: '04:00', address: '12 rue des Exemples', owner: 'A' });
    assert.doesNotThrow(() => validateData(data));
  }
  // An activity can remain dated while a stay is moved or a route variant is explored.
  data.stages.paris.start = '2027-05-01'; data.stages.paris.end = '2027-05-03';
  assert.doesNotThrow(() => validateData(data));
  for (const changes of [
    { date: '2027-02-29' }, { date: null }, { time: '24:00' }, { time: '7:30' },
    { endTime: '19:60' }, { endTime: null }, { date: '', time: '19:00' },
    { time: '', endTime: '04:00' }, { owner: 'someone' }, { owner: null },
    { address: 'a'.repeat(501) }, { address: null }
  ]) {
    const invalid = clone(data); Object.assign(invalid.ideas.hotel, changes);
    assert.throws(() => validateData(invalid));
  }
  const malformed = clone(data); malformed.ideas.bad = null;
  assert.throws(() => validateData(malformed), error => error.name === 'ValidationError');
  const old = legacyData(data);
  assert.throws(() => validateData(old), /valeur est invalide/);
  old.ideas.hotel.kind = 'activite'; old.ideas.hotel.date = '';
  assert.throws(() => validateData(old), /champs sont invalides/);
});

test('anciennes idées v2 : valeurs agenda par défaut, aucune mutation ni faux conflit', () => {
  const old = notebook();
  for (const field of ['date', 'time', 'endTime', 'address', 'owner']) delete old.ideas.hotel[field];
  const before = clone(old); assert.doesNotThrow(() => validateData(old));
  const normalized = migrateData(old);
  assert.deepEqual(old, before); assert.deepEqual(normalized.ideas.hotel, idea());
  assert.deepEqual(migrateData(normalized), normalized);
  assert.deepEqual(mergeThreeWay(migrateData(old), migrateData(old), normalized).conflicts, []);
  const base = notebook(); base.ideas.hotel.date = '2027-01-12';
  const local = clone(base); local.ideas.hotel.date = '';
  const remote = clone(base); remote.ideas.hotel.time = '12:00';
  assert.ok(mergeThreeWay(base, local, remote).conflicts.includes('/'));
});

test('cache v2 ancien : réponse perdue puis normalisation agenda sans écriture doublée', async t => {
  const server = service(t); const storage = new Storage(); const first = client(t, server.fetcher, storage);
  await first.sync.start(); first.sync.stop();
  const key = [...storage.items.keys()][0]; const cache = JSON.parse(storage.getItem(key));
  const old = notebook(); for (const field of ['date', 'time', 'endTime', 'address', 'owner', 'imageUrl', 'imageCredit', 'imageSource', 'room', 'comfort', 'locationNote', 'priceBasis', 'priceNote']) delete old.ideas.hotel[field];
  cache.base.data = clone(old); cache.local = clone(old); cache.local.trip.title = 'Brouillon v2 ancien';
  cache.pending = { revision: 0, writeId: 'old-v2-pending', data: clone(cache.local) };
  assert.equal((await server.request('PUT', cache.pending)).status, 200);
  storage.setItem(key, JSON.stringify(cache)); let sent;
  const restored = client(t, (url, init) => { if (init.method === 'PUT') sent = JSON.parse(init.body); return server.fetcher(url, init); }, storage);
  await restored.sync.start();
  assert.equal(restored.last().status, 'saved'); assert.equal(restored.last().revision, 1);
  assert.notEqual(sent.writeId, 'old-v2-pending');
  assert.equal(restored.last().data.ideas.hotel.owner, 'both');
  assert.equal(restored.last().data.ideas.hotel.priceBasis, 'estimate');
  assert.equal(restored.last().data.ideas.hotel.room, '');
  assert.equal(restored.last().data.trip.title, 'Brouillon v2 ancien');
  assert.equal(server.db.prepare('SELECT revision FROM trip').get().revision, 1);
  await restored.sync.refresh(); assert.equal(restored.last().status, 'saved');
});

test('comparatif : photos, prestations et origine des prix contrôlées à la frontière du carnet', () => {
  const data = notebook();
  Object.assign(data.ideas.hotel, {
    imageUrl: 'https://images.example/hotel.jpg', imageCredit: 'Photo de démonstration', imageSource: 'https://example.com/photos',
    room: 'Chambre double, lit à confirmer', comfort: 'Piscine annoncée dans la source', locationNote: 'Quartier à comparer',
    priceBasis: 'historical', priceNote: 'Ancien total divisé par le nombre de nuits, conditions à revérifier.',
  });
  assert.doesNotThrow(() => validateData(data));
  assert.deepEqual(migrateData(data), data);
  for (const changes of [
    { imageUrl: 'http://images.example/hotel.jpg' }, { imageUrl: 'javascript:alert(1)' },
    { imageUrl: 'https://user:secret@images.example/a.jpg' }, { imageUrl: 'https://images.example/a\n.jpg' },
    { imageSource: 'data:text/html,source' }, { imageCredit: null }, { imageCredit: 'x'.repeat(241) },
    { room: 'x'.repeat(501) }, { room: null }, { comfort: 'x'.repeat(1001) },
    { locationNote: 'x'.repeat(1001) }, { priceNote: 'x'.repeat(2001) }, { priceNote: null },
    { priceBasis: 'confirmed' }, { priceBasis: null },
  ]) {
    const invalid = clone(data); Object.assign(invalid.ideas.hotel, changes);
    assert.throws(() => validateData(invalid), error => error.name === 'ValidationError');
  }
  const checked = clone(data); checked.ideas.hotel.priceBasis = 'checked';
  checked.ideas.hotel.priceNote = 'Montant consulté le 12 janvier 2027 pour une chambre double.';
  assert.doesNotThrow(() => validateData(checked));
  for (const changes of [{ cost: null }, { url: '' }, { priceNote: '   ' }]) {
    const invalid = clone(checked); Object.assign(invalid.ideas.hotel, changes);
    assert.throws(() => validateData(invalid), /prix vérifié/);
  }
  const legacy = legacyData(data); legacy.ideas.hotel.room = 'Une chambre';
  assert.throws(() => validateData(legacy), /champs sont invalides/);
});

test('comparatif : migration des anciens montants sans inventer de tarif vérifié ou historique', () => {
  const before = legacyData();
  const priced = migrateData(before);
  assert.deepEqual(legacyData(priced), before);
  assert.equal(priced.ideas.hotel.cost, 100);
  assert.equal(priced.ideas.hotel.priceBasis, 'estimate');
  assert.equal(priced.ideas.hotel.priceNote, '');
  assert.equal(priced.ideas.hotel.imageUrl, '');
  assert.deepEqual(migrateData(priced), priced);
  const oldV2 = notebook();
  for (const field of ['imageUrl', 'imageCredit', 'imageSource', 'room', 'comfort', 'locationNote', 'priceBasis', 'priceNote']) delete oldV2.ideas.hotel[field];
  oldV2.ideas.hotel.cost = null;
  const original = clone(oldV2), unknown = migrateData(oldV2);
  assert.deepEqual(oldV2, original);
  assert.equal(unknown.ideas.hotel.priceBasis, 'unknown');
  assert.equal(unknown.ideas.hotel.room, '');
  oldV2.ideas.hotel.cost = 0;
  assert.equal(migrateData(oldV2).ideas.hotel.priceBasis, 'estimate');
  const explicit = clone(priced); explicit.ideas.hotel.priceBasis = 'historical'; explicit.ideas.hotel.priceNote = 'Ancien tarif saisi par les voyageurs.';
  assert.equal(migrateData(explicit).ideas.hotel.priceBasis, 'historical');
  assert.equal(migrateData(explicit).ideas.hotel.priceNote, explicit.ideas.hotel.priceNote);
});
