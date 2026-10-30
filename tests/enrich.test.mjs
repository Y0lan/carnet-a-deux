import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mergeEnrichment, applyEnrichment } from '../tools/enrich.mjs';
import { migrateData, validateData } from '../public/schema.js';
import worker from '../worker/index.js';
import { openDatabase } from '../tools/sqlite-adapter.mjs';

function legacy() {
  return { schemaVersion: 1, trip: { title: 'Voyage de test', personA: 'A', personB: 'B' }, stages: { stop: { id: 'stop', title: 'Une étape', place: 'Un lieu', lat: 1, lng: 2, start: '2027-01-01', end: '2027-01-03', mood: 'repos', status: 'explorer', notes: 'Note existante' } }, ideas: {} };
}
function proposal() {
  return {
    stageFields: { stop: { experience: 'Prendre le temps.', imageUrl: 'https://example.invalid/photo.jpg', imageCredit: 'Photo de test', imageSource: 'https://example.invalid/source' } },
    flights: { flight: { id: 'flight', title: 'Vol à comparer', from: 'Départ', to: 'Arrivée', departure: '', arrival: '', departureZone: '', arrivalZone: '', number: '', traveler: 'both', status: 'explorer', url: '', notes: '', fromStageId: '', toStageId: 'stop' } },
    shopping: { item: { id: 'item', title: 'Un article', category: 'autre', owner: 'A', status: 'envie', url: '', cost: null, currency: 'EUR', notes: '', stageId: 'stop', voteA: false, voteB: false } },
  };
}
async function fixture(t) {
  const privateDir = await mkdtemp(join(tmpdir(), 'carnet-enrich-'));
  const db = openDatabase();
  db.exec(await readFile(new URL('../worker/migration.sql', import.meta.url), 'utf8'));
  t.after(async () => { db.close(); await rm(privateDir, { recursive: true, force: true }); });
  const endpoint = 'https://example.invalid/api/trip', token = randomUUID();
  const env = { DB: db, EDIT_TOKEN: token, ALLOWED_ORIGIN: 'https://example.invalid' };
  const fetcher = (url, options = {}) => worker.fetch(new Request(url, options), env);
  async function current() { return (await fetcher(endpoint, { headers: { Authorization: `Bearer ${token}` } })).json(); }
  async function save(data) {
    const before = await current();
    const response = await fetcher(endpoint, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: before.revision, writeId: randomUUID(), data }) });
    assert.equal(response.status, 200);
  }
  await save(legacy());
  await writeFile(join(privateDir, 'enrichment.json'), JSON.stringify(proposal()), { mode: 0o600 });
  const options = { endpoint, token, privateDir, fetcher };
  return { options, current, save, privateDir };
}

test('les ajouts migrent le document ancien sans modifier ses notes', () => {
  const original = legacy(), next = mergeEnrichment(original, proposal());
  assert.equal(original.schemaVersion, 1);
  assert.equal(next.schemaVersion, 2);
  assert.equal(next.stages.stop.notes, original.stages.stop.notes);
  assert.equal(next.stages.stop.experience, proposal().stageFields.stop.experience);
  assert.equal(Object.keys(next.flights).length, 1);
  assert.equal(Object.keys(next.shopping).length, 1);
});

test('les choix existants et le crédit photo restent ensemble', () => {
  const current = mergeEnrichment(legacy(), proposal());
  current.stages.stop.experience = 'Notre texte';
  current.stages.stop.imageUrl = '';
  current.stages.stop.imageCredit = 'Crédit en cours de saisie';
  current.shopping.item.notes = 'Notre choix';
  const next = mergeEnrichment(current, proposal());
  assert.deepEqual(next, current);
});

test('une étape supprimée ne revient pas avec ses fiches proposées', () => {
  const current = legacy(); delete current.stages.stop;
  const next = mergeEnrichment(current, proposal());
  assert.deepEqual(next.stages, {});
  assert.deepEqual(next.flights, {});
  assert.deepEqual(next.shopping, {});
});

test('import des idées : choix existants conservés, étape absente ignorée et ajout idempotent', () => {
  const old = legacy();
  old.ideas.kept = { id: 'kept', stageId: 'stop', kind: 'hotel', title: 'Hôtel déjà comparé', url: 'https://example.invalid/kept', details: 'Nos notes à conserver', cost: 160, status: 'retenu', voteA: true, voteB: true };
  const current = migrateData(old), before = structuredClone(current);
  const newIdea = { id: 'new', stageId: 'stop', kind: 'hotel', title: 'Ancienne piste', url: 'https://example.invalid/new', details: 'Piste issue d’un ancien carnet', cost: 120, status: 'explorer', voteA: false, voteB: false, priceBasis: 'historical', priceNote: 'Ancien séjour de 4 nuits : total 480 EUR, à revérifier.' };
  const enrichment = { ideas: {
    kept: { ...newIdea, id: 'kept', details: 'Ne doit pas remplacer nos notes', cost: 20, voteA: false, voteB: false },
    new: newIdea,
    detached: { ...newIdea, id: 'detached', stageId: 'removed' },
  } };
  const next = mergeEnrichment(current, enrichment);
  assert.deepEqual(current, before);
  assert.deepEqual(next.ideas.kept, before.ideas.kept);
  assert.deepEqual(Object.keys(next.ideas).sort(), ['kept', 'new']);
  assert.equal(next.ideas.new.cost, 120);
  assert.equal(next.ideas.new.priceBasis, 'historical');
  assert.equal(next.ideas.new.priceNote, newIdea.priceNote);
  assert.doesNotThrow(() => validateData(next));
  const normalized = migrateData(next);
  assert.equal(normalized.ideas.new.room, '');
  assert.equal(normalized.ideas.new.owner, 'both');
  assert.equal(normalized.ideas.new.priceBasis, 'historical');
  assert.deepEqual(mergeEnrichment(next, enrichment), next);
  newIdea.details = 'Modification de la proposition après import';
  assert.equal(next.ideas.new.details, 'Piste issue d’un ancien carnet');
});

test('les détails proposés complètent un hôtel sans changer ses choix ni mélanger les crédits', () => {
  const old = legacy();
  old.ideas.hotel = { id: 'hotel', stageId: 'stop', kind: 'hotel', title: 'Hôtel choisi', url: '', details: 'Nos notes', cost: 150, status: 'retenu', voteA: true, voteB: false };
  const current = migrateData(old);
  current.ideas.hotel.room = 'Notre chambre';
  current.ideas.hotel.imageCredit = 'Crédit en cours';
  const before = structuredClone(current);
  const fields = { room: 'Autre chambre', comfort: 'Sauna', locationNote: 'Près du centre', priceNote: 'Prix à vérifier', cost: 20, voteA: false, imageUrl: 'https://example.invalid/room.jpg', imageCredit: 'Photo officielle', imageSource: 'https://example.invalid/rooms' };
  const enrichment = { ideaFields: { hotel: fields, removed: fields } };
  const next = mergeEnrichment(current, enrichment);
  assert.deepEqual(current, before);
  assert.equal(next.ideas.hotel.room, 'Notre chambre');
  assert.equal(next.ideas.hotel.comfort, 'Sauna');
  assert.equal(next.ideas.hotel.locationNote, 'Près du centre');
  assert.equal(next.ideas.hotel.cost, 150);
  assert.equal(next.ideas.hotel.priceBasis, 'estimate');
  assert.equal(next.ideas.hotel.voteA, true);
  assert.equal(next.ideas.hotel.imageUrl, '');
  assert.equal(next.ideas.hotel.imageCredit, 'Crédit en cours');
  assert.equal(next.ideas.hotel.imageSource, '');
  assert.equal(Object.hasOwn(next.ideas, 'removed'), false);
  assert.deepEqual(mergeEnrichment(next, enrichment), next);
  current.ideas.hotel.imageCredit = '';
  const withPhoto = mergeEnrichment(current, enrichment).ideas.hotel;
  for (const key of ['imageUrl', 'imageCredit', 'imageSource']) assert.equal(withPhoto[key], fields[key]);
});

test('un ajout confirmé crée une sauvegarde privée et ne revient pas après suppression', async (t) => {
  const { options, current, save, privateDir } = await fixture(t);
  const result = await applyEnrichment(options);
  assert.equal(result.status, 'applied');
  assert.equal((await current()).data.shopping.item.title, 'Un article');
  const files = await readdir(privateDir), backups = files.filter((name) => name.startsWith('before-enrichment-'));
  assert.equal(backups.length, 1);
  assert.equal((JSON.parse(await readFile(join(privateDir, backups[0]), 'utf8'))).data.schemaVersion, 1);
  assert.equal((await stat(join(privateDir, backups[0]))).mode & 0o777, 0o600);
  const edited = (await current()).data; delete edited.shopping.item; await save(edited);
  const revision = (await current()).revision;
  assert.equal((await applyEnrichment(options)).status, 'already-applied');
  assert.equal((await current()).revision, revision);
  assert.equal((await current()).data.shopping.item, undefined);
  for (const file of files) assert.equal((await readFile(join(privateDir, file), 'utf8')).includes(options.token), false);
});

test('une édition simultanée interrompt les ajouts et une reprise relit la version actuelle', async (t) => {
  const { options, current, save, privateDir } = await fixture(t);
  let changed = false;
  const race = async (url, config) => {
    if (config.method === 'PUT' && !changed) {
      changed = true;
      const edited = (await current()).data; edited.stages.stop.notes = 'Édition simultanée'; await save(edited);
    }
    return options.fetcher(url, config);
  };
  await assert.rejects(applyEnrichment({ ...options, fetcher: race }), /changé pendant/);
  assert.equal((await readdir(privateDir)).includes('enrichment-pending.json'), false);
  assert.equal((await current()).data.schemaVersion, 1);
  await applyEnrichment(options);
  assert.equal((await current()).data.stages.stop.notes, 'Édition simultanée');
});

test('la réponse perdue reprend le même writeId sans ajouter une deuxième révision', async (t) => {
  const { options, current, privateDir } = await fixture(t);
  const loseAck = async (url, config) => {
    const response = await options.fetcher(url, config);
    if (config.method === 'PUT') throw new Error('Connexion interrompue');
    return response;
  };
  await assert.rejects(applyEnrichment({ ...options, fetcher: loseAck }), /confirmation.*interrompue/);
  const pending = JSON.parse(await readFile(join(privateDir, 'enrichment-pending.json'), 'utf8'));
  const revision = (await current()).revision;
  let replayed;
  const result = await applyEnrichment({ ...options, fetcher: (url, config) => {
    if (config.method === 'PUT') replayed = JSON.parse(config.body).writeId;
    return options.fetcher(url, config);
  } });
  assert.equal(result.status, 'applied');
  assert.equal(replayed, pending.payload.writeId);
  assert.equal((await current()).revision, revision);
});

test('une réponse perdue suivie d’une suppression ne réapplique aucun article', async (t) => {
  const { options, current, save, privateDir } = await fixture(t);
  const loseAck = async (url, config) => {
    const response = await options.fetcher(url, config);
    if (config.method === 'PUT') throw new Error('Connexion interrompue');
    return response;
  };
  await assert.rejects(applyEnrichment({ ...options, fetcher: loseAck }));
  const edited = (await current()).data; delete edited.shopping.item; await save(edited);
  await assert.rejects(applyEnrichment(options), /confirmation reste incertaine/);
  assert.equal((await current()).data.shopping.item, undefined);
  assert.equal((await readdir(privateDir)).includes('enrichment-pending.json'), true);
});

test('une lecture de contrôle interrompue reprend sans écriture', async (t) => {
  const { options, current, save } = await fixture(t);
  let written = false;
  const failReadback = async (url, config) => {
    if (written && config.method !== 'PUT') throw new Error('Lecture interrompue');
    const response = await options.fetcher(url, config);
    if (config.method === 'PUT') written = true;
    return response;
  };
  await assert.rejects(applyEnrichment({ ...options, fetcher: failReadback }), /Lecture interrompue/);
  const edited = (await current()).data; edited.stages.stop.experience = 'Nouvelle description'; delete edited.shopping.item; await save(edited);
  let puts = 0;
  await applyEnrichment({ ...options, fetcher: (url, config) => { if (config.method === 'PUT') puts++; return options.fetcher(url, config); } });
  assert.equal(puts, 0);
  assert.equal((await current()).data.stages.stop.experience, 'Nouvelle description');
  assert.equal((await current()).data.shopping.item, undefined);
});

test('un contenu invalide ne prépare aucune écriture', async (t) => {
  const { options, current, privateDir } = await fixture(t);
  const invalid = proposal(); invalid.stageFields.stop.imageUrl = 'javascript:alert(1)';
  await writeFile(join(privateDir, 'enrichment.json'), JSON.stringify(invalid));
  await assert.rejects(applyEnrichment(options), /HTTPS/);
  assert.equal((await current()).data.schemaVersion, 1);
  assert.deepEqual(await readdir(privateDir), ['enrichment.json']);
});
