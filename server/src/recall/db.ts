// SQLite schema for the session index. FTS5 tables are external-content over
// `turns` / `tool_events` (kept in sync by triggers) so text is stored once.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { firstHumanPrompt, lastHumanPrompt, lastReply, type ParsedSession } from './parse.js'

export const SCHEMA_VERSION = 2

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL DEFAULT '',
  git_branch TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  hub_name TEXT NOT NULL DEFAULT '',
  agent_key TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT '',
  ended_at TEXT NOT NULL DEFAULT '',
  entrypoint TEXT NOT NULL DEFAULT '',
  turn_count INTEGER NOT NULL DEFAULT 0,
  first_prompt TEXT NOT NULL DEFAULT '',
  last_prompt TEXT NOT NULL DEFAULT '',
  last_reply TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_ended ON sessions(ended_at);
CREATE TABLE IF NOT EXISTS turns (
  session_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  uuid TEXT NOT NULL DEFAULT '',
  ts TEXT NOT NULL DEFAULT '',
  user_text TEXT NOT NULL DEFAULT '',
  assistant_text TEXT NOT NULL DEFAULT '',
  tool_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, idx)
);
CREATE INDEX IF NOT EXISTS turns_uuid ON turns(uuid);
CREATE TABLE IF NOT EXISTS tool_events (
  session_id TEXT NOT NULL,
  turn_idx INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  input_summary TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  truncated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, turn_idx, seq)
);
CREATE TABLE IF NOT EXISTS files (
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  action TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, path, action)
);
CREATE INDEX IF NOT EXISTS files_path ON files(path);
CREATE TABLE IF NOT EXISTS ingest_state (
  session_id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  user_text, assistant_text, session_id UNINDEXED, idx UNINDEXED,
  content='turns', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS tools_fts USING fts5(
  input_summary, result, session_id UNINDEXED, turn_idx UNINDEXED, seq UNINDEXED,
  content='tool_events', content_rowid='rowid', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, user_text, assistant_text, session_id, idx)
  VALUES (new.rowid, new.user_text, new.assistant_text, new.session_id, new.idx);
END;
CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, user_text, assistant_text, session_id, idx)
  VALUES ('delete', old.rowid, old.user_text, old.assistant_text, old.session_id, old.idx);
END;
CREATE TRIGGER IF NOT EXISTS tools_ai AFTER INSERT ON tool_events BEGIN
  INSERT INTO tools_fts(rowid, input_summary, result, session_id, turn_idx, seq)
  VALUES (new.rowid, new.input_summary, new.result, new.session_id, new.turn_idx, new.seq);
END;
CREATE TRIGGER IF NOT EXISTS tools_ad AFTER DELETE ON tool_events BEGIN
  INSERT INTO tools_fts(tools_fts, rowid, input_summary, result, session_id, turn_idx, seq)
  VALUES ('delete', old.rowid, old.input_summary, old.result, old.session_id, old.turn_idx, old.seq);
END;
`

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(SCHEMA)
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined
  if (row && Number(row.value) !== SCHEMA_VERSION) {
    // A schema bump rebuilds from the transcripts (the index is derived data).
    db.exec(`DROP TABLE IF EXISTS turns_fts; DROP TABLE IF EXISTS tools_fts; DROP TABLE IF EXISTS tool_events; DROP TABLE IF EXISTS turns;
      DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS ingest_state`)
    db.exec('VACUUM')
    db.exec(SCHEMA)
  }
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION))
  return db
}

export interface SessionMeta {
  hubName?: string
  agentKey?: string
}

export interface IngestSource {
  path: string
  size: number
  mtimeMs: number
}

export function needsIndex(db: DatabaseSync, sessionId: string, src: IngestSource): boolean {
  const prev = db.prepare('SELECT source_path, size, mtime_ms FROM ingest_state WHERE session_id = ?').get(sessionId) as
    | { source_path: string; size: number; mtime_ms: number } | undefined
  if (!prev) return true
  return prev.source_path !== src.path || prev.size !== src.size || prev.mtime_ms !== src.mtimeMs
}

export function upsertSession(db: DatabaseSync, s: ParsedSession, src: IngestSource, meta: SessionMeta = {}, now = Date.now()): void {
  const insSession = db.prepare(`INSERT OR REPLACE INTO sessions
    (id, cwd, git_branch, title, hub_name, agent_key, started_at, ended_at, entrypoint, turn_count, first_prompt, last_prompt, last_reply)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insTurn = db.prepare('INSERT INTO turns (session_id, idx, uuid, ts, user_text, assistant_text, tool_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const insEvent = db.prepare('INSERT INTO tool_events (session_id, turn_idx, seq, name, input_summary, result, truncated) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const insFile = db.prepare('INSERT INTO files (session_id, path, action, n) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, path, action) DO UPDATE SET n = n + excluded.n')
  const insState = db.prepare('INSERT OR REPLACE INTO ingest_state (session_id, source_path, size, mtime_ms, indexed_at) VALUES (?, ?, ?, ?, ?)')

  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM tool_events WHERE session_id = ?').run(s.id)
    db.prepare('DELETE FROM turns WHERE session_id = ?').run(s.id)
    db.prepare('DELETE FROM files WHERE session_id = ?').run(s.id)
    insSession.run(
      s.id, s.cwd, s.gitBranch, s.title, meta.hubName ?? '', meta.agentKey ?? '', s.startedAt, s.endedAt, s.entrypoint,
      s.turns.length, firstHumanPrompt(s).slice(0, 2000), lastHumanPrompt(s).slice(0, 2000), lastReply(s).slice(0, 2000),
    )
    for (const t of s.turns) {
      insTurn.run(s.id, t.idx, t.uuid, t.ts, t.userText, t.assistantText, t.events.length)
      for (const e of t.events) insEvent.run(s.id, t.idx, e.seq, e.name, e.inputSummary, e.result, e.truncated ? 1 : 0)
      for (const [path, actions] of t.files) for (const a of actions) insFile.run(s.id, path, a, 1)
    }
    insState.run(s.id, src.path, src.size, src.mtimeMs, now)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function stats(db: DatabaseSync): { sessions: number; turns: number; toolEvents: number } {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  return { sessions: one('SELECT COUNT(*) n FROM sessions'), turns: one('SELECT COUNT(*) n FROM turns'), toolEvents: one('SELECT COUNT(*) n FROM tool_events') }
}
