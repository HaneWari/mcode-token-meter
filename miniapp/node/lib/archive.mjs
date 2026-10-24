// token-meter local archive.
//
// WHY THIS EXISTS
// Deleting a session in MiniMax Code is a hard delete, not an archive. The
// runtime's own source (app.asar, SessionArtifactService.deleteSession) does:
//
//   () => this.owners.usage.deleteSession(sessionId)      // local_runtime_token_usage
//   () => this.owners.messages.deleteSessionData(sessionId)
//   () => this.deleteLegacyHistory(sessionId)
//   () => this.owners.canonicalHistory.delete(sessionId)  // the transcript directory
//
// so the usage rows, the message rows AND the transcript all disappear at
// once. There is no read-only source left to reconstruct them from: the
// transcript is gone with them.
//
// A dashboard that reports "what this machine actually spent" therefore needs
// its own copy, otherwise deleting a chat silently rewrites history — the
// totals drop and the board no longer matches reality.
//
// WHAT IS STORED
// One row per model call, in the plugin's OWN data directory
// (<dataDir>/v2/plugin-data/liveboards/<plugin-id>/archive.sqlite), which the
// Host provides as the plugin's writable, host-owned persistent state. The
// runtime's own database is never written to — it is only ever read.
//
// The archive is additive: the runtime remains the source of truth for every
// session that still exists. Archived rows are merged back ONLY for calls the
// runtime no longer has, and the merge is keyed on the runtime's own usage-row
// id, so a live session can never be counted twice.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (
  usage_id           INTEGER PRIMARY KEY,
  session_id         TEXT    NOT NULL,
  agent_name         TEXT,
  turn_id            TEXT,
  provider           TEXT,
  provider_name      TEXT,
  provider_id        TEXT,
  model              TEXT,
  model_name         TEXT,
  custom             INTEGER,
  ts                 INTEGER NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL,
  decode_ms          INTEGER,
  request_ms         INTEGER,
  status             INTEGER,
  finish_reason      TEXT,
  rate               REAL,
  request_rate       REAL,
  enriched_at        INTEGER
);
CREATE INDEX IF NOT EXISTS usage_ts_idx     ON usage(ts);
CREATE INDEX IF NOT EXISTS usage_session_idx ON usage(session_id);

CREATE TABLE IF NOT EXISTS sessions (
  session_id     TEXT PRIMARY KEY,
  title          TEXT,
  agent_name     TEXT,
  workspace_dir  TEXT,
  first_seen_at  INTEGER,
  last_seen_at   INTEGER,
  deleted_at     INTEGER
);

CREATE TABLE IF NOT EXISTS turns (
  turn_id         TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  user_ts         INTEGER,
  user_preview    TEXT,
  last_ts         INTEGER,
  assistant_count INTEGER,
  finish_reason   TEXT
);

CREATE TABLE IF NOT EXISTS archive_meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

function loadSqlite() {
  try {
    return { sqlite: createRequire(import.meta.url)('node:sqlite'), error: null };
  } catch (err) {
    return { sqlite: null, error: err };
  }
}

// Where the archive lives. The Host hands the Mini App a writable, host-owned
// directory for exactly this purpose; if that is somehow not available we fall
// back to the same path the Host itself computes.
export function archiveDir(pluginDataDir, dataDir) {
  if (pluginDataDir && fs.existsSync(pluginDataDir)) return pluginDataDir;
  const fromEnv = process.env.PLUGIN_DATA;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return path.join(dataDir, 'v2', 'plugin-data', 'liveboards', 'token-meter-board');
}

export function archiveFile(pluginDataDir, dataDir) {
  return path.join(archiveDir(pluginDataDir, dataDir), 'archive.sqlite');
}

// Open (creating if needed) the archive database in read-write mode.
// Returns { db, error }: exactly one of the two is non-null.
export function openArchive(pluginDataDir, dataDir) {
  const { sqlite, error: sqliteErr } = loadSqlite();
  if (!sqlite) return { db: null, error: `archive needs node:sqlite (${sqliteErr?.message || 'unavailable'})` };
  const file = archiveFile(pluginDataDir, dataDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (err) {
    return { db: null, error: `cannot create archive directory: ${err.message}` };
  }
  try {
    const db = new sqlite.DatabaseSync(file);
    db.exec(SCHEMA);
    db.prepare('INSERT OR REPLACE INTO archive_meta(k, v) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    return { db, error: null, file };
  } catch (err) {
    return { db: null, error: `cannot open archive: ${err.message}`, file };
  }
}

function getMeta(db, key, fallback = null) {
  try {
    const row = db.prepare('SELECT v FROM archive_meta WHERE k = ?').get(key);
    return row ? row.v : fallback;
  } catch {
    return fallback;
  }
}

function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO archive_meta(k, v) VALUES (?, ?)').run(key, String(value));
}

// Highest runtime usage-row id already archived.
export function archivedMaxUsageId(db) {
  const v = getMeta(db, 'max_usage_id', '0');
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const INSERT_USAGE = `
INSERT INTO usage (
  usage_id, session_id, agent_name, turn_id, provider, provider_name, provider_id,
  model, model_name, custom, ts, input_tokens, output_tokens, reasoning_tokens,
  cache_read_tokens, cache_write_tokens, cost_usd
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(usage_id) DO NOTHING
`;

const UPDATE_USAGE_ENRICHED = `
UPDATE usage SET
  provider = COALESCE(?, provider),
  provider_name = COALESCE(?, provider_name),
  provider_id = COALESCE(?, provider_id),
  model = COALESCE(?, model),
  model_name = COALESCE(?, model_name),
  custom = COALESCE(?, custom),
  decode_ms = COALESCE(?, decode_ms),
  request_ms = COALESCE(?, request_ms),
  status = COALESCE(?, status),
  finish_reason = COALESCE(?, finish_reason),
  rate = COALESCE(?, rate),
  request_rate = COALESCE(?, request_rate),
  enriched_at = ?
WHERE usage_id = ?
`;

const UPSERT_SESSION = `
INSERT INTO sessions (session_id, title, agent_name, workspace_dir, first_seen_at, last_seen_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  title = COALESCE(excluded.title, title),
  agent_name = COALESCE(excluded.agent_name, agent_name),
  workspace_dir = COALESCE(excluded.workspace_dir, workspace_dir),
  first_seen_at = MIN(COALESCE(first_seen_at, excluded.first_seen_at), COALESCE(excluded.first_seen_at, first_seen_at)),
  last_seen_at = MAX(COALESCE(last_seen_at, excluded.last_seen_at), COALESCE(excluded.last_seen_at, last_seen_at)),
  deleted_at = NULL
`;

const UPSERT_TURN = `
INSERT INTO turns (turn_id, session_id, user_ts, user_preview, last_ts, assistant_count, finish_reason)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(turn_id) DO UPDATE SET
  user_ts = COALESCE(excluded.user_ts, user_ts),
  user_preview = COALESCE(excluded.user_preview, user_preview),
  last_ts = COALESCE(excluded.last_ts, last_ts),
  assistant_count = COALESCE(excluded.assistant_count, assistant_count),
  finish_reason = COALESCE(excluded.finish_reason, finish_reason)
`;

// Archive what the board can see.
//
//   usageRows  raw rows straight from local_runtime_token_usage (all history,
//              incremental by the runtime's own row id) — these carry the
//              token counts, which are the part that must never be lost.
//   ledger     the enriched rows for the window on screen (provider, model,
//              decode/request timing, HTTP status, rate).
//   sessions   session title / agent / workspace, so a deleted session still
//              shows its name in the ranking.
//   turns      per-turn message facts (the user's own message preview), so a
//              deleted session's conversation table is still readable.
//
// Everything is best-effort: a failure here must never take the dashboard
// down, so the caller treats the archive as optional.
export function syncArchive(db, { usageRows = [], ledger = [], sessions = [], turns = [] } = {}) {
  const stats = { rawRows: 0, enrichedRows: 0, sessions: 0, turns: 0, maxUsageId: archivedMaxUsageId(db) };
  const now = Date.now();

  const insert = db.prepare(INSERT_USAGE);
  const enrich = db.prepare(UPDATE_USAGE_ENRICHED);
  const upsertSession = db.prepare(UPSERT_SESSION);
  const upsertTurn = db.prepare(UPSERT_TURN);

  // A SAVEPOINT nests safely, whether or not a transaction is already open.
  db.exec('SAVEPOINT sync_archive');
  try {
    let maxId = stats.maxUsageId;
    for (const r of usageRows) {
      const id = Number(r.usage_id ?? r.id);
      if (!Number.isFinite(id)) continue;
      insert.run(
        id,
        r.session_id ?? r.sessionId ?? '',
        r.agent_name ?? r.agentName ?? null,
        r.turn_id ?? r.turnId ?? null,
        null, null, null,
        r.model ?? null,
        null,
        null,
        Number(r.ts),
        r.input_tokens ?? r.inputTokens ?? 0,
        r.output_tokens ?? r.outputTokens ?? 0,
        r.reasoning_tokens ?? r.reasoningTokens ?? 0,
        r.cache_read_tokens ?? r.cacheReadTokens ?? 0,
        r.cache_write_tokens ?? r.cacheWriteTokens ?? 0,
        r.cost_usd ?? r.costUsd ?? 0,
      );
      stats.rawRows += 1;
      if (id > maxId) maxId = id;
    }
    stats.maxUsageId = maxId;

    for (const c of ledger) {
      const id = Number(c.usageId);
      if (!Number.isFinite(id)) continue;
      enrich.run(
        c.provider ?? null,
        c.providerName ?? null,
        c.providerId ?? null,
        c.model ?? null,
        c.modelName ?? null,
        c.custom == null ? null : c.custom ? 1 : 0,
        c.decodeMs ?? null,
        c.requestMs ?? null,
        c.status ?? null,
        c.finishReason ?? null,
        c.rate ?? null,
        c.requestRate ?? null,
        now,
        id,
      );
      stats.enrichedRows += 1;
    }

    for (const [sessionId, s] of sessions) {
      if (!sessionId) continue;
      const ts = Number(s.created_at_ms ?? s.firstSeenAt ?? 0) || null;
      upsertSession.run(
        sessionId,
        s.title ?? null,
        s.agent_name ?? s.agentName ?? null,
        s.workspace_dir ?? s.workspaceDir ?? null,
        ts,
        ts,
      );
      stats.sessions += 1;
    }

    for (const [turnId, t] of turns) {
      if (!turnId) continue;
      upsertTurn.run(
        turnId,
        t.sessionId ?? t.session_id ?? '',
        t.userTs ?? null,
        t.userPreview ?? null,
        t.lastTs ?? null,
        t.assistantCount ?? null,
        t.finishReason ?? null,
      );
      stats.turns += 1;
    }

    setMeta(db, 'max_usage_id', maxId);
    setMeta(db, 'last_sync_at', now);
    db.exec('RELEASE sync_archive');
  } catch (err) {
    try { db.exec('ROLLBACK TO sync_archive'); db.exec('RELEASE sync_archive'); } catch { /* already closed */ }
    throw err;
  }
  return stats;
}

// Archived calls inside a window, as ledger-shaped rows.
export function readArchivedCalls(db, startMs, endMs) {
  const rows = db
    .prepare(
      `SELECT usage_id, session_id, agent_name, turn_id, provider, provider_name, provider_id,
              model, model_name, custom, ts, input_tokens, output_tokens, reasoning_tokens,
              cache_read_tokens, cache_write_tokens, cost_usd,
              decode_ms, request_ms, status, finish_reason, rate, request_rate
         FROM usage
        WHERE ts >= ? AND ts <= ?
        ORDER BY ts`,
    )
    .all(startMs, endMs);
  return rows.map((r) => ({
    usageId: r.usage_id,
    ts: r.ts,
    sessionId: r.session_id,
    agentName: r.agent_name,
    turnId: r.turn_id,
    provider: r.provider,
    providerId: r.provider_id,
    model: r.model,
    custom: r.custom == null ? null : r.custom !== 0,
    providerName: r.provider_name,
    modelName: r.model_name,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    reasoning_tokens: r.reasoning_tokens,
    cache_read_tokens: r.cache_read_tokens,
    cache_write_tokens: r.cache_write_tokens,
    cost_usd: r.cost_usd,
    decodeMs: r.decode_ms,
    requestMs: r.request_ms,
    status: r.status,
    finishReason: r.finish_reason,
    rate: r.rate,
    requestRate: r.request_rate,
    fromArchive: true,
  }));
}

// Archived session metadata, for sessions the runtime no longer lists.
// `sessionIds` scopes the read to the sessions that actually need it, so the
// cost does not grow with the size of the archive.
export function readArchivedSessions(db, sessionIds) {
  if (!sessionIds || !sessionIds.size) return new Map();
  const map = new Map();
  const stmt = db.prepare('SELECT session_id, title, agent_name, workspace_dir FROM sessions WHERE session_id = ?');
  for (const id of sessionIds) {
    const r = stmt.get(id);
    if (r) {
      map.set(r.session_id, {
        session_id: r.session_id,
        title: r.title,
        agent_name: r.agent_name,
        workspace_dir: r.workspace_dir,
      });
    }
  }
  return map;
}

// Archived turn facts, for the turns of sessions the runtime no longer lists.
// Scoped the same way: one lookup per turn that is actually on screen.
export function readArchivedTurns(db, turnIds) {
  if (!turnIds || !turnIds.size) return new Map();
  const map = new Map();
  const stmt = db.prepare(
    `SELECT turn_id, session_id, user_ts, user_preview, last_ts, assistant_count, finish_reason
       FROM turns WHERE turn_id = ?`,
  );
  for (const id of turnIds) {
    const r = stmt.get(id);
    if (r) {
      map.set(r.turn_id, {
        sessionId: r.session_id,
        userTs: r.user_ts,
        userPreview: r.user_preview,
        lastTs: r.last_ts,
        assistantCount: r.assistant_count,
        finishReason: r.finish_reason,
      });
    }
  }
  return map;
}

// Mark sessions the runtime no longer lists, so the UI can say "deleted".
// A single UPDATE is atomic on its own; no explicit transaction here, because
// the caller may already be inside one.
export function markDeletedSessions(db, sessionIds) {
  if (!sessionIds || !sessionIds.length) return 0;
  const now = Date.now();
  const stmt = db.prepare('UPDATE sessions SET deleted_at = ? WHERE session_id = ? AND deleted_at IS NULL');
  let n = 0;
  for (const id of sessionIds) n += stmt.run(now, id).changes ?? 0;
  return n;
}

export function archiveStats(db) {
  if (!db) return null;
  try {
    const calls = db.prepare('SELECT COUNT(*) c FROM usage').get().c;
    const sessions = db.prepare('SELECT COUNT(*) c FROM sessions').get().c;
    const deleted = db.prepare('SELECT COUNT(*) c FROM sessions WHERE deleted_at IS NOT NULL').get().c;
    const turns = db.prepare('SELECT COUNT(*) c FROM turns').get().c;
    return {
      calls,
      sessions,
      deletedSessions: deleted,
      turns,
      maxUsageId: archivedMaxUsageId(db),
      lastSyncAt: Number(getMeta(db, 'last_sync_at', '0')) || 0,
    };
  } catch {
    return null;
  }
}
