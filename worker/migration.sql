CREATE TABLE IF NOT EXISTS trip (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at TEXT NOT NULL,
  document TEXT NOT NULL,
  last_write_id TEXT,
  last_write_hash TEXT
);
INSERT OR IGNORE INTO trip (id, revision, updated_at, document)
VALUES (1, 0, '1970-01-01T00:00:00.000Z', '{"schemaVersion":1,"trip":{"title":"Notre voyage en Europe","personA":"Personne A","personB":"Personne B"},"stages":{},"ideas":{}}');
