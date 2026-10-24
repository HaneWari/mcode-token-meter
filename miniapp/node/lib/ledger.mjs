// token-meter ledger context.
//
// One place that builds the per-call ledger for a window, so the dashboard and
// the local archive are always derived from the SAME computation. The archive
// is not a second implementation of the numbers — it is the output of this one,
// kept in a place the runtime cannot delete.
//
// The runtime deletes a session outright: its usage rows, its message rows and
// its transcript all go away together (see the SessionArtifactService code in
// the Host bundle). Nothing read-only can bring them back, so the board keeps
// its own copy of every call it has ever seen.

import {
  queryUsageRows,
  queryUsageRowsSince,
  loadCatalog,
  loadTurnEnrichment,
  syncMessageFacts,
  buildLedgerWithDb,
  loadTurnMessageMeta,
  loadSessionTitles,
} from './common.mjs';
import {
  openArchive,
  syncArchive,
  readArchivedCalls,
  readArchivedSessions,
  readArchivedTurns,
  markDeletedSessions,
  archivedMaxUsageId,
  archiveStats,
  archiveFile,
} from './archive.mjs';

// The archive records the whole history once, so a session the user never
// happened to open on screen is still protected before the runtime deletes it.
// After that first pass the per-window ledger is enough: it enriches the rows
// of the window on screen, and those are the ones the user is looking at.
function needsFullArchivePass(archiveDb) {
  try {
    const row = archiveDb.prepare("SELECT v FROM archive_meta WHERE k = 'full_pass_at'").get();
    return !row || !Number(row.v);
  } catch {
    return true;
  }
}

function markFullArchivePass(archiveDb, now) {
  try {
    archiveDb
      .prepare("INSERT OR REPLACE INTO archive_meta(k, v) VALUES ('full_pass_at', ?)")
      .run(String(now));
  } catch {
    // best effort
  }
}

// Build the ledger for a window and fold in everything the local archive
// knows about calls the runtime no longer has.
//
// Returns the context used by every endpoint, plus an `archive` block
// describing what the archive did (for /api/health and the UI).
export function buildLedgerContext({ db, dataDir, pluginDataDir, startMs, endMs, now = Date.now() }) {
  const rows = queryUsageRows(db, startMs, endMs);
  const catalog = loadCatalog(dataDir);
  const { map: enrichment, filesScanned } = loadTurnEnrichment(dataDir, startMs, { now });
  const store = syncMessageFacts(db, dataDir, { now });
  const ledger = buildLedgerWithDb(db, rows, enrichment, catalog, store);
  const turnMeta = loadTurnMessageMeta(rows, store);
  const titles = loadSessionTitles(db);

  const archive = {
    available: false,
    file: archiveFile(pluginDataDir, dataDir),
    error: null,
    stats: null,
    restoredCalls: 0,
    restoredSessions: 0,
    restoredTurns: 0,
  };
  // Sessions the runtime no longer lists but the archive still knows about.
  const deletedSessions = new Set();

  let archiveDb = null;
  try {
    const opened = openArchive(pluginDataDir, dataDir);
    if (!opened.db) {
      archive.error = opened.error;
    } else {
      archiveDb = opened.db;
      archive.available = true;

      // 1. raw rows: every call the runtime has ever recorded, walked
      //    incrementally by the runtime's own row id.
      const maxId = archivedMaxUsageId(archiveDb);
      const rawRows = queryUsageRowsSince(db, maxId);

      // 2. the enriched rows of the window on screen, plus the session and
      //    turn metadata that makes a deleted session still readable.
      const turnSession = new Map();
      for (const c of ledger) {
        if (c.turnId && !turnSession.has(c.turnId)) turnSession.set(c.turnId, c.sessionId);
      }
      const turnRows = new Map();
      for (const [turnId, m] of turnMeta) {
        turnRows.set(turnId, { ...m, sessionId: turnSession.get(turnId) || null });
      }

      // 3. one full pass over the whole history, the first time only, so that
      //    calls the user never opened on screen are archived with their model,
      //    timing and status as well.
      let fullLedger = null;
      let fullRows = null;
      let fullTurns = null;
      if (needsFullArchivePass(archiveDb)) {
        try {
          fullRows = queryUsageRows(db, 0, now);
          const fullEnrichment = loadTurnEnrichment(dataDir, 0, { now });
          fullLedger = buildLedgerWithDb(db, fullRows, fullEnrichment.map, catalog, store);
          fullTurns = loadTurnMessageMeta(fullRows, store);
        } catch (err) {
          archive.error = String(err?.message || err);
          fullRows = null;
          fullLedger = null;
          fullTurns = null;
        }
      }

      syncArchive(archiveDb, {
        usageRows: fullRows || rawRows,
        ledger: fullLedger || ledger,
        sessions: titles,
        turns: fullTurns || turnRows,
      });
      if (fullRows) markFullArchivePass(archiveDb, now);

      // 4. merge back the calls the runtime no longer has.
      const seen = new Set(rows.map((r) => r.usage_id));
      const archivedCalls = readArchivedCalls(archiveDb, startMs, endMs);
      const restored = archivedCalls.filter((c) => !seen.has(c.usageId));
      if (restored.length) {
        for (const c of restored) ledger.push(c);
        ledger.sort((a, b) => a.ts - b.ts);

        // Only the sessions and turns that actually contribute to this window
        // are looked up, so the archive does not have to be read in full.
        const needSessions = new Set(restored.map((c) => c.sessionId).filter(Boolean));
        const archivedSessions = readArchivedSessions(archiveDb, needSessions);
        const gone = [];
        for (const [sid, s] of archivedSessions) {
          if (!titles.has(sid)) {
            titles.set(sid, s);
            gone.push(sid);
            deletedSessions.add(sid);
          }
        }
        try {
          markDeletedSessions(archiveDb, gone);
        } catch (err) {
          archive.error = String(err?.message || err);
        }

        const needTurns = new Set(restored.map((c) => c.turnId).filter(Boolean));
        const archivedTurns = readArchivedTurns(archiveDb, needTurns);
        for (const [turnId, t] of archivedTurns) {
          if (!turnMeta.has(turnId)) turnMeta.set(turnId, t);
        }

        archive.restoredCalls = restored.length;
        archive.restoredSessions = gone.length;
        archive.restoredTurns = restored.filter((c) => c.turnId).length;
      }

      archive.stats = archiveStats(archiveDb);
    }
  } catch (err) {
    // The archive is an enhancement, never a dependency: a failure here must
    // not take the dashboard down.
    archive.error = String(err?.message || err);
  } finally {
    if (archiveDb) {
      try { archiveDb.close(); } catch { /* already closed */ }
    }
  }

  return { rows, catalog, enrichment, ledger, turnMeta, titles, filesScanned, archive, deletedSessions };
}
