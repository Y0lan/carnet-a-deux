import { emptyData, validateData } from './schema.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const missing = Symbol('missing');
const isObject = value => value !== missing && value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => {
  if (a === b) return true;
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
};
const pointer = value => value.replaceAll('~', '~0').replaceAll('/', '~1');
const storageOwners = new WeakMap();

// Deletions are values during the merge, so a deleted field cannot return silently.
export function mergeThreeWay(base, local, remote) {
  const conflicts = [];
  function visit(before, ours, theirs, path) {
    if (same(ours, theirs)) return ours;
    if (same(before, ours)) return theirs;
    if (same(before, theirs)) return ours;
    if (isObject(ours) && isObject(theirs) && (isObject(before) || before === missing)) {
      const result = {};
      for (const key of new Set([...Object.keys(before === missing ? {} : before), ...Object.keys(ours), ...Object.keys(theirs)])) {
        const value = visit(before !== missing && Object.hasOwn(before, key) ? before[key] : missing, Object.hasOwn(ours, key) ? ours[key] : missing, Object.hasOwn(theirs, key) ? theirs[key] : missing, `${path}/${pointer(key)}`);
        if (value !== missing) Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
      }
      return result;
    }
    conflicts.push(path || '/');
    return ours;
  }
  let data = clone(visit(base, local, remote, ''));
  // Valid changes can interact through dates or stage references.
  if (data?.schemaVersion === 1) {
    try { validateData(data); }
    catch {
      conflicts.push('/');
      data = clone(local);
    }
  }
  return { data, conflicts: [...new Set(conflicts)] };
}

async function storageKey(endpoint, token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${endpoint}\n${token}`));
  return `carnet-europe:v1:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
function validEnvelope(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.updatedAt !== 'string' || value.updatedAt.length > 40 || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('La réponse du serveur est invalide.');
  validateData(value.data);
  return value;
}
class SyncError extends Error {
  constructor(message, status = 'error') { super(message); this.status = status; }
}

export class SyncClient {
  #token;

  constructor({ endpoint, token, storage, fetcher, onChange = () => {} }) {
    if (typeof endpoint !== 'string' || !endpoint || typeof token !== 'string' || !token) throw new Error('L’adresse du service et le code sont nécessaires.');
    this.endpoint = endpoint;
    this.#token = token;
    this.storage = storage === undefined ? globalThis.localStorage : storage;
    this.fetcher = fetcher || globalThis.fetch.bind(globalThis);
    this.onChange = onChange;
    this.data = null;
    this.base = null;
    this.pending = null;
    this.conflict = null;
    this.conflicts = [];
    this.status = 'connecting';
    this.error = null;
    this.key = null;
    this.running = false;
    this.ready = false;
    this.releaseStorage = null;
    this.busy = null;
    this.timer = null;
    this.interval = null;
    this.resume = () => {
      if (!globalThis.document || document.visibilityState !== 'hidden') void this.refresh();
    };
  }

  _emit(status, error = null) {
    this.status = status;
    this.error = error;
    this.onChange({ data: clone(this.data), revision: this.base?.revision ?? null, status, conflicts: [...this.conflicts], error });
  }

  _persist() {
    this._requireReady();
    if (!this.storage) return;
    if (!this.key) throw new SyncError('Le stockage local est en cours de préparation.');
    try {
      this.storage.setItem(this.key, JSON.stringify({ version: 1, base: this.base, local: this.data, pending: this.pending, conflict: this.conflict }));
    } catch { throw new SyncError('Le brouillon ne peut pas être enregistré sur cet appareil. Libérez de l’espace.'); }
  }

  _requireReady() {
    if (!this.running || !this.ready) throw new SyncError('Le carnet est fermé. Relancez la connexion avant de modifier les données.');
  }

  async _acquireStorage() {
    if (!this.storage) return;
    const occupied = () => new SyncError('Ce carnet est déjà ouvert dans un autre onglet. Fermez l’autre onglet, puis relancez la connexion ici.');
    if (globalThis.window) {
      if (!globalThis.navigator?.locks?.request) throw new SyncError('Ce navigateur ne protège pas les brouillons entre onglets. Utilisez un navigateur récent.');
      await new Promise((resolve, reject) => {
        navigator.locks.request(this.key, { mode: 'exclusive', ifAvailable: true }, lock => {
          if (!lock) { reject(occupied()); return; }
          const held = new Promise(release => { this.releaseStorage = release; });
          resolve();
          return held;
        }).catch(reject);
      });
      return;
    }
    // Injected stores represent isolated storage areas in local adapters/tests.
    // Instances using the same adapter object must share its editing lock.
    let owners = storageOwners.get(this.storage);
    if (!owners) { owners = new Map(); storageOwners.set(this.storage, owners); }
    if (owners.has(this.key)) throw occupied();
    owners.set(this.key, this);
    this.releaseStorage = () => {
      if (owners.get(this.key) === this) owners.delete(this.key);
    };
  }

  _restore() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return;
      if (raw.length > 4 * 1024 * 1024) throw new Error();
      const saved = JSON.parse(raw);
      if (saved.version !== 1 || Object.keys(saved).length !== 5 || !['base', 'local', 'pending', 'conflict'].every(field => Object.hasOwn(saved, field))) throw new Error();
      if (saved.base !== null) validEnvelope(saved.base);
      if (saved.local !== null) validateData(saved.local);
      if (saved.base && !saved.local) throw new Error();
      if (saved.pending !== null) {
        if (!saved.base || !saved.local || Object.keys(saved.pending).length !== 3 || !Number.isSafeInteger(saved.pending.revision) || saved.pending.revision < 0 || typeof saved.pending.writeId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(saved.pending.writeId)) throw new Error();
        validateData(saved.pending.data);
      }
      if (saved.conflict !== null) {
        if (!saved.base || !saved.local || saved.pending || Object.keys(saved.conflict).length !== 3) throw new Error();
        for (const field of ['base', 'local', 'remote']) validateData(saved.conflict[field]);
      }
      this.base = saved.base;
      this.data = saved.local;
      this.pending = saved.pending;
      this.conflict = saved.conflict;
      if (this.conflict) this.conflicts = mergeThreeWay(this.conflict.base, this.conflict.local, this.conflict.remote).conflicts;
    } catch { throw new SyncError('Le brouillon local est illisible. Il reste conservé sur cet appareil.'); }
  }

  async start() {
    if (this.running) return this.busy;
    this.running = true;
    this.ready = false;
    this._emit('connecting');
    try {
      this.key = await storageKey(this.endpoint, this.#token);
      await this._acquireStorage();
      if (!this.running) { this.stop(); return; }
      this._restore();
      this.ready = true;
      this._emit('connecting');
      this.interval = setInterval(() => void this.refresh(), 15000);
      globalThis.addEventListener?.('online', this.resume);
      globalThis.addEventListener?.('pageshow', this.resume);
      globalThis.document?.addEventListener('visibilitychange', this.resume);
      await this._exclusive(async () => {
        await this._read();
        if (this.pending) await this._send();
      });
    } catch (error) {
      this.stop();
      this._emit('error', error.message || 'La connexion est impossible.');
    }
  }

  stop() {
    this.running = false;
    this.ready = false;
    clearTimeout(this.timer);
    clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
    globalThis.removeEventListener?.('online', this.resume);
    globalThis.removeEventListener?.('pageshow', this.resume);
    globalThis.document?.removeEventListener('visibilitychange', this.resume);
    this.releaseStorage?.();
    this.releaseStorage = null;
  }

  change(data) {
    this._requireReady();
    validateData(data);
    if (!this.key) throw new SyncError('Attendez la première connexion avant de modifier le carnet.');
    this.data = clone(data);
    if (this.conflict) this.conflict.local = clone(data);
    try { this._persist(); }
    catch (error) { this._emit('error', error.message); throw error; }
    if (this.conflicts.length) this._emit('conflict');
    else {
      this._emit(this._dirty() ? 'saving' : 'saved');
      this._schedule();
    }
  }

  resolveConflict(choice) {
    this._requireReady();
    if (!['local', 'remote'].includes(choice)) throw new Error('Choisissez la version locale ou distante.');
    if (!this.conflict) return;
    const { base, local, remote } = this.conflict;
    this.data = mergeThreeWay(base, choice === 'local' ? local : remote, choice === 'local' ? remote : local).data;
    validateData(this.data);
    this.conflict = null;
    this.conflicts = [];
    try { this._persist(); }
    catch (error) { this._emit('error', error.message); throw error; }
    this._emit(this._dirty() ? 'saving' : 'saved');
    this._schedule();
  }

  _dirty() { return this.pending !== null || (this.data !== null && (this.base === null || !same(this.data, this.base.data))); }

  _schedule() {
    if (!this.running || !this.ready || this.conflicts.length || !this._dirty()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.busy) void this._exclusive(() => this._send());
    }, 300);
  }

  _exclusive(action) {
    if (this.busy) return this.busy;
    this.busy = Promise.resolve().then(action).catch(error => {
      if (this.running) this._emit(error.status || 'error', error.message || 'La synchronisation a échoué.');
    }).finally(() => {
      this.busy = null;
      // The regular refresh retries failed requests. Only acknowledged writes
      // can immediately schedule the next draft.
      if (this.status === 'saving') this._schedule();
    });
    return this.busy;
  }

  async _request(method, body) {
    let response;
    try {
      response = await this.fetcher(this.endpoint, {
        method,
        headers: { Authorization: `Bearer ${this.#token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error'
      });
    } catch { throw new SyncError('Connexion interrompue. Le brouillon reste sur cet appareil.', 'offline'); }
    if (response.status !== 200 && response.status !== 409) {
      if (response.status === 401) throw new SyncError('Le code d’accès est incorrect.');
      if (response.status === 403) throw new SyncError('Cette origine n’est pas autorisée.');
      if (response.status >= 500) throw new SyncError('Le service est indisponible. Le brouillon reste sur cet appareil.', 'offline');
      throw new SyncError('Le serveur a refusé la sauvegarde. Le brouillon reste sur cet appareil.');
    }
    try { return { status: response.status, value: clone(validEnvelope(await response.json())) }; }
    catch { throw new SyncError('La réponse du serveur est invalide. Le brouillon reste sur cet appareil.'); }
  }

  _integrate(remote) {
    // A pending request must receive its own acknowledgment before rebasing.
    if (this.pending) return;
    const before = this.base?.data || emptyData();
    const local = this.data || clone(remote.data);
    const result = mergeThreeWay(before, local, remote.data);
    if (result.conflicts.length) {
      this.conflict = { base: clone(before), local: clone(local), remote: clone(remote.data) };
      this.conflicts = result.conflicts;
    } else {
      this.conflict = null;
      this.conflicts = [];
    }
    this.base = clone(remote);
    this.data = result.data;
    this._persist();
    this._emit(this.conflicts.length ? 'conflict' : this._dirty() ? 'saving' : 'saved');
  }

  refresh() {
    if (!this.running || !this.ready) return Promise.resolve();
    return this._exclusive(async () => {
      if (this.pending) {
        await this._send();
        return;
      }
      await this._read();
    });
  }

  async _read() {
    const remote = await this._request('GET');
    if (!this.running || !this.ready) return;
    if (remote.status !== 200) throw new SyncError('La lecture du carnet a échoué.');
    if (this.pending) return;
    if (this.conflict) {
      // Keep the original common ancestor while the user chooses.
      this.conflict.remote = clone(remote.value.data);
      this.base = clone(remote.value);
      const result = mergeThreeWay(this.conflict.base, this.conflict.local, this.conflict.remote);
      this.data = result.data;
      this.conflicts = result.conflicts;
      if (!this.conflicts.length) this.conflict = null;
      this._persist();
      this._emit(this.conflicts.length ? 'conflict' : this._dirty() ? 'saving' : 'saved');
    } else this._integrate(remote.value);
  }

  async _send() {
    if (!this.running || !this.ready || this.conflicts.length || !this._dirty()) return;
    if (!this.base) {
      const remote = await this._request('GET');
      if (remote.status !== 200) throw new SyncError('La lecture du carnet a échoué.');
      this._integrate(remote.value);
      if (this.conflicts.length || !this._dirty()) return;
    }
    if (!this.pending) {
      this.pending = { revision: this.base.revision, writeId: crypto.randomUUID(), data: clone(this.data) };
    }
    this._persist();
    this._emit('saving');
    const sent = this.pending;
    const reply = await this._request('PUT', sent);
    if (!this.running || !this.ready) return;
    if (reply.status === 409) {
      this.pending = null;
      this._integrate(reply.value);
      return;
    }
    // Later edits stay in this.data. Only the sent snapshot is acknowledged.
    if (reply.value.revision <= sent.revision || !same(reply.value.data, sent.data)) throw new SyncError('L’accusé de réception ne correspond pas au brouillon.');
    this.base = reply.value;
    this.pending = null;
    this._persist();
    this._emit(this._dirty() ? 'saving' : 'saved');
  }
}
