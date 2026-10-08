// token-meter-board SessionEnd hook: append one per-session usage snapshot line
// to the canonical archive <dataDir>/v2/plugin-data/hooks/token-meter/snapshots.jsonl
// (the same file the retired standalone token-meter plugin wrote, so the
// archive stays one continuous timeline). Side-effect only: no stdout, always exit 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function failOpen() {
  process.exit(0);
}

// Prefer the runtime-injected PLUGIN_ROOT; fall back to <package>/scripts/<this file>.
function resolvePluginRoot() {
  const fromEnv = process.env.PLUGIN_ROOT;
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'miniapp', 'node', 'lib', 'common.mjs'))) return fromEnv;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..');
}

const common = await import(
  pathToFileURL(path.join(resolvePluginRoot(), 'miniapp', 'node', 'lib', 'common.mjs')).href
);
const {
  resolveDataDir,
  openDb,
  hookDataDir,
  loadCatalog,
  loadTurnEnrichment,
  resolveRowIdentity,
  emptyMetrics,
  addRow,
  finalize,
  sortGroups,
} = common;

function recordError(outDir, err) {
  try {
    fs.writeFileSync(
      path.join(outDir, 'last-error.json'),
      JSON.stringify({ at: new Date().toISOString(), message: String(err?.message || err) }, null, 2) + '\n',
    );
  } catch {
    // ignore
  }
}

// Rotate an overgrown snapshot log with a staging-file rename (no torn writes).
const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_KEEP_BYTES = 4 * 1024 * 1024;
function rotateIfNeeded(file) {
  try {
    const size = fs.statSync(file).size;
    if (size <= SNAPSHOT_MAX_BYTES) return;
    const fd = fs.openSync(file, 'r');
    let tail;
    try {
      const start = Math.max(0, size - SNAPSHOT_KEEP_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      tail = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const firstNewline = tail.indexOf('\n');
    if (firstNewline >= 0) tail = tail.slice(firstNewline + 1);
    const staging = `${file}.staging`;
    fs.writeFileSync(staging, tail, 'utf8');
    fs.renameSync(staging, file);
  } catch {
    // rotation is best-effort
  }
}

let input = '';
try {
  // Tolerate leading BOM/whitespace from shell pipelines.
  input = fs.readFileSync(0, 'utf8').replace(/^[\uFEFF\s]+/, '');
} catch {
  failOpen();
}

let payload = null;
try {
  payload = JSON.parse(input);
} catch {
  failOpen();
}
if (!payload || payload.hook_event_name !== 'SessionEnd' || !payload.session_id) {
  failOpen();
}

const dataDir = resolveDataDir();
// Always write the canonical token-meter archive, regardless of which plugin
// package this hook ships in — the board reads exactly this file.
let outDir = hookDataDir(dataDir);

try {
  fs.mkdirSync(outDir, { recursive: true });
  // Canonicalize before writing (symlink containment on all platforms).
  outDir = fs.realpathSync(outDir);

  const { db, error } = openDb(dataDir);
  if (!db) {
    recordError(outDir, new Error(error || 'database unavailable'));
    failOpen();
  }

  const rows = db
    .prepare(
      `SELECT session_id, agent_name, turn_id, model, ts,
              input_tokens, output_tokens, reasoning_tokens,
              cache_read_tokens, cache_write_tokens, cost_usd
         FROM local_runtime_token_usage
        WHERE session_id = ?
        ORDER BY ts`,
    )
    .all(payload.session_id);

  if (!rows.length) {
    db.close();
    failOpen();
  }

  const minTs = rows[0].ts;
  const catalog = loadCatalog(dataDir);
  // Enrichment selects hourly log files by name covering the session span —
  // cheap enough for the SessionEnd budget (files are small and hourly).
  const { map: enrichment } = loadTurnEnrichment(dataDir, minTs, {
    maxBytesPerFile: 2 * 1024 * 1024,
  });

  const total = emptyMetrics();
  const groups = new Map();
  for (const row of rows) {
    addRow(total, row);
    const id = resolveRowIdentity(row, enrichment, catalog);
    const key = `${id.provider}|${id.model}`;
    if (!groups.has(key)) {
      groups.set(key, {
        provider: id.provider,
        providerName: id.providerName,
        model: id.model,
        modelName: id.modelName,
        custom: id.custom,
        metrics: emptyMetrics(),
      });
    }
    addRow(groups.get(key).metrics, row);
  }

  let title = null;
  try {
    const info = db
      .prepare('SELECT title FROM local_runtime_sessions WHERE session_id = ?')
      .get(payload.session_id);
    title = info?.title || null;
  } catch {
    // title optional
  }
  db.close();

  const snapshot = {
    v: 1,
    sessionId: payload.session_id,
    reason: payload.reason ?? null,
    agentName: rows[0].agent_name || null,
    title,
    startedAt: new Date(minTs).toISOString(),
    endedAt: new Date().toISOString(),
    ...finalize(total),
    byModel: sortGroups(
      [...groups.values()].map((g) => ({ ...g, ...finalize(g.metrics), metrics: undefined })),
    ),
  };

  const file = path.join(outDir, 'snapshots.jsonl');
  fs.appendFileSync(file, `${JSON.stringify(snapshot)}\n`);
  rotateIfNeeded(file);
  process.exit(0);
} catch (err) {
  recordError(outDir, err);
  process.exit(0);
}
