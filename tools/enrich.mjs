import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { migrateData, validateData } from '../public/schema.js';

const same = isDeepStrictEqual;

// Les contenus proposés complètent les champs vides, sans remplacer les choix existants.
export function mergeEnrichment(current, enrichment) {
  const next = migrateData(current);
  for (const [id, values] of Object.entries(enrichment.stageFields ?? {})) {
    if (!Object.hasOwn(next.stages, id)) continue;
    const stage = next.stages[id];
    if (!stage.experience && Object.hasOwn(values, 'experience')) stage.experience = values.experience;
    if (!stage.imageUrl && !stage.imageCredit && !stage.imageSource) {
      for (const key of ['imageUrl', 'imageCredit', 'imageSource']) if (Object.hasOwn(values, key)) stage[key] = values[key];
    }
  }
  for (const [id, values] of Object.entries(enrichment.ideaFields ?? {})) {
    if (!Object.hasOwn(next.ideas, id)) continue;
    const idea = next.ideas[id];
    for (const key of ['room', 'comfort', 'locationNote', 'priceNote']) if (!idea[key] && Object.hasOwn(values, key)) idea[key] = values[key];
    if (!idea.imageUrl && !idea.imageCredit && !idea.imageSource) {
      for (const key of ['imageUrl', 'imageCredit', 'imageSource']) if (Object.hasOwn(values, key)) idea[key] = values[key];
    }
  }
  for (const table of ['ideas', 'flights', 'shopping']) {
    for (const [id, record] of Object.entries(enrichment[table] ?? {})) {
      if (Object.hasOwn(next[table], id)) continue;
      const references = table === 'flights' ? [record.fromStageId, record.toStageId] : [record.stageId];
      if (references.some((stageId) => stageId && !Object.hasOwn(next.stages, stageId))) continue;
      Object.defineProperty(next[table], id, { value: structuredClone(record), enumerable: true, configurable: true, writable: true });
    }
  }
  return migrateData(next);
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function savePrivate(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
function envelope(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.updatedAt !== 'string') throw new Error('La réponse du carnet est invalide.');
  validateData(value.data);
  return value;
}

export async function applyEnrichment({ endpoint, token, privateDir, fetcher = fetch }) {
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const raw = await readFile(join(privateDir, 'enrichment.json'), 'utf8');
  const enrichment = JSON.parse(raw), hash = createHash('sha256').update(raw).digest('hex');
  const appliedPath = join(privateDir, 'enrichment-applied.json'), pendingPath = join(privateDir, 'enrichment-pending.json');
  const applied = await readJson(appliedPath, { version: 1, endpoint, hashes: [] });
  if (applied.version !== 1 || applied.endpoint !== endpoint || !Array.isArray(applied.hashes) || applied.hashes.some((value) => typeof value !== 'string')) throw new Error('Le suivi des ajouts privés ne correspond pas à ce carnet.');
  let pending = await readJson(pendingPath, null);
  if (pending && (pending.version !== 1 || pending.endpoint !== endpoint || pending.hash !== hash || !pending.payload || !Number.isSafeInteger(pending.payload.revision) || pending.payload.revision < 0 || typeof pending.payload.writeId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(pending.payload.writeId) || (pending.acknowledgedRevision !== null && pending.acknowledgedRevision !== pending.payload.revision + 1))) throw new Error('Un ajout privé reste à confirmer. Conserve le fichier enrichment.json utilisé pour cet ajout avant de reprendre.');
  if (pending) validateData(pending.payload.data);
  if (applied.hashes.includes(hash)) {
    if (pending) await rm(pendingPath);
    return { status: 'already-applied' };
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  async function getCurrent() {
    const response = await fetcher(endpoint, { headers, cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Lecture du carnet refusée (${response.status}). Aucun ajout effectué.`);
    return envelope(await response.json());
  }
  async function finish(revision) {
    applied.hashes.push(hash);
    await savePrivate(appliedPath, applied);
    await rm(pendingPath, { force: true });
    return { status: 'applied', revision };
  }
  const resuming = Boolean(pending);
  if (!pending) {
    const current = await getCurrent(), data = mergeEnrichment(current.data, enrichment);
    if (same(current.data, data)) return finish(current.revision);
    await savePrivate(join(privateDir, `before-enrichment-${randomUUID()}.json`), current);
    pending = { version: 1, endpoint, hash, payload: { revision: current.revision, writeId: randomUUID(), data }, acknowledgedRevision: null };
    await savePrivate(pendingPath, pending);
  }
  if (pending.acknowledgedRevision === null) {
    let response;
    try { response = await fetcher(endpoint, { method: 'PUT', headers, body: JSON.stringify(pending.payload), signal: AbortSignal.timeout(30000) }); }
    catch { throw new Error('La confirmation des ajouts a été interrompue. Relance la même commande : le journal privé permet une reprise sans doublon.'); }
    if (response.status === 409) {
      if (!resuming) {
        await rm(pendingPath);
        throw new Error('Le carnet a changé pendant l’ajout. Aucun changement remplacé. Relance la commande pour reprendre depuis la version actuelle.');
      }
      throw new Error('La confirmation reste incertaine après une autre modification du carnet. Sauvegarde et journal privés conservés ; aucun ajout réappliqué.');
    }
    if (!response.ok) throw new Error(`Ajouts privés refusés (${response.status}). Le journal est conservé pour reprendre la même opération.`);
    const confirmed = envelope(await response.json());
    if (confirmed.revision !== pending.payload.revision + 1 || !same(confirmed.data, pending.payload.data)) throw new Error('La réponse ne confirme pas les ajouts attendus. Le journal privé est conservé.');
    pending.acknowledgedRevision = confirmed.revision;
    await savePrivate(pendingPath, pending);
  }
  const verified = await getCurrent();
  if (verified.revision < pending.acknowledgedRevision) throw new Error('La lecture de contrôle ne confirme pas la version enregistrée. Le journal privé est conservé.');
  return finish(pending.acknowledgedRevision);
}
