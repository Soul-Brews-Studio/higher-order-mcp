CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','decision','lesson','context','person','project')),
  tags       TEXT NOT NULL DEFAULT '[]',
  tags_text  TEXT NOT NULL DEFAULT '',
  importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS memories_updated ON memories(updated_at DESC);
CREATE INDEX IF NOT EXISTS memories_kind ON memories(kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS memories_importance ON memories(importance DESC, updated_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title, content, tags_text,
  content='memories', content_rowid='rowid', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, content, tags_text) VALUES (new.rowid, new.title, new.content, new.tags_text);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags_text) VALUES ('delete', old.rowid, old.title, old.content, old.tags_text);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags_text) VALUES ('delete', old.rowid, old.title, old.content, old.tags_text);
  INSERT INTO memories_fts(rowid, title, content, tags_text) VALUES (new.rowid, new.title, new.content, new.tags_text);
END;
