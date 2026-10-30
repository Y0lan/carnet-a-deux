import { DatabaseSync } from 'node:sqlite';

// Le serveur local utilise les mêmes requêtes que la liaison D1 du Worker.
export function openDatabase(filename = ':memory:') {
  const sqlite = new DatabaseSync(filename);
  return {
    exec(sql) { sqlite.exec(sql); },
    close() { sqlite.close(); },
    prepare(sql) {
      const prepare = (values = []) => ({
        bind(...nextValues) { return prepare(nextValues); },
        async first(column) { const row = sqlite.prepare(sql).get(...values); return column ? row?.[column] ?? null : row ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...values), success: true }; },
        async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
      });
      return prepare();
    },
  };
}
