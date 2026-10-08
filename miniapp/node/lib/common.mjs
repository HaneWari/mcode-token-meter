// token-meter shared helpers: data-dir resolution, catalog parsing, log enrichment, metrics.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

export const PLUGIN_NAME = 'token-meter';

export const SQLITE_REQUIREMENT =
  'token-meter requires Node.js 23.4+ (24 LTS recommended) so that the built-in node:sqlite module is available without flags.';

// node:sqlite is unflagged only on Node.js >= 23.4. Load it lazily so that an
// unsupported runtime gets a clear tool error instead of a process crash.
let sqliteModule;
let sqliteError;
function loadSqlite() {
  if (sqliteModule === undefined && sqliteError === undefined) {
    try {
      sqliteModule = createRequire(import.meta.url)('node:sqlite');
    } catch (err) {
      sqliteModule = null;
      sqliteError = err;
    }
  }
  return { sqlite: sqliteModule, error: sqliteError ?? null };
}

export function resolveDataDir(env = process.env) {
  if (env.MINIMAX_DATA_DIR && fs.existsSync(env.MINIMAX_DATA_DIR)) {
    return path.resolve(env.MINIMAX_DATA_DIR);
  }
  if (env.PLUGIN_DATA) {
    // <dataDir>/v2/plugin-data/<kind>/<name> -> dataDir is four levels up.
    const candidate = path.resolve(env.PLUGIN_DATA, '..', '..', '..', '..');
    if (fs.existsSync(path.join(candidate, 'v2'))) return candidate;
  }
  return path.join(os.homedir(), '.minimax');
}

export function dbPath(dataDir) {
  return path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
}

export function hookDataDir(dataDir) {
  return path.join(dataDir, 'v2', 'plugin-data', 'hooks', PLUGIN_NAME);
}

export function snapshotFile(dataDir) {
  return path.join(hookDataDir(dataDir), 'snapshots.jsonl');
}

// Open the runtime state database read-only.
// Returns { db, error }: exactly one of the two is non-null.
export function openDb(dataDir) {
  const { sqlite, error: sqliteErr } = loadSqlite();
  if (!sqlite) {
    return { db: null, error: `${SQLITE_REQUIREMENT} (${sqliteErr?.code || sqliteErr?.message || 'node:sqlite unavailable'})` };
  }
  const file = dbPath(dataDir);
  if (!fs.existsSync(file)) {
    return { db: null, error: `runtime state database not found at ${file} — is this a MiniMax Code data directory with recorded usage?` };
  }
  try {
    return { db: new sqlite.DatabaseSync(file, { readOnly: true }), error: null };
  } catch (err) {
    return { db: null, error: `failed to open runtime state database read-only: ${err.message}` };
  }
}

// Query raw usage rows in [startMs, endMs] ascending by ts.
export function queryUsageRows(db, startMs, endMs) {
  return db
    .prepare(
      `SELECT session_id, agent_name, turn_id, model, ts,
              input_tokens, output_tokens, reasoning_tokens,
              cache_read_tokens, cache_write_tokens, cost_usd
         FROM local_runtime_token_usage
        WHERE ts >= ? AND ts <= ?
        ORDER BY ts`,
    )
    .all(startMs, endMs);
}

export function dayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Resolve a query window. Either explicit startDate/endDate (YYYY-MM-DD, inclusive,
// local time) or `days` = trailing N days including today.
export function resolveWindow({ days, startDate, endDate } = {}, now = Date.now()) {
  if (startDate) {
    const start = new Date(`${startDate}T00:00:00`);
    const endBase = endDate ? new Date(`${endDate}T23:59:59.999`) : new Date(start.getTime() + 86400000 - 1);
    if (Number.isNaN(start.getTime()) || Number.isNaN(endBase.getTime())) {
      throw new Error(`invalid startDate/endDate: ${startDate} ${endDate || ''}`.trim());
    }
    const startMs = start.getTime();
    const endMs = Math.min(endBase.getTime(), now);
    if (endMs < startMs) throw new Error('window end is before start');
    return { startMs, endMs, label: `${dayKey(startMs)}..${dayKey(endMs)}` };
  }
  const n = clampInt(days ?? 1, 1, 90, 1);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const startMs = todayStart.getTime() - (n - 1) * 86400000;
  return { startMs, endMs: now, label: n === 1 ? dayKey(startMs) : `${dayKey(startMs)}..${dayKey(now)}` };
}

// --- config.yaml catalog (provider/model display names) ----------------------

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

// Minimal line-based YAML reader targeting only the provider sections we need.
// Returns { providers: Map<id, {name, kind}>, modelNames: Map<'providerId/modelId', name>,
//           modelToProvider: Map<modelId, providerId> }.
export function loadCatalog(dataDir) {
  const providers = new Map();
  const modelNames = new Map();
  const modelToProvider = new Map();
  const file = path.join(dataDir, 'config.yaml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { providers, modelNames, modelToProvider };
  }
  try {
    // ctx: null | { section: 'custom'|'builtin', providerId, providerIndent, inModels, modelId, modelIndent }
    let ctx = null;
    for (const rawLine of text.split('\n')) {
      if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
      const indent = rawLine.length - rawLine.trimStart().length;
      const line = rawLine.trim();

      if (indent === 0) {
        if (line === 'custom_provider:') {
          ctx = { section: 'custom', providerId: null, providerIndent: -1, inModels: false, modelId: null };
        } else if (line === 'provider:') {
          ctx = { section: 'builtin', providerId: null, providerIndent: -1, inModels: false, modelId: null };
        } else if (!line.startsWith('-')) {
          ctx = null; // left the provider sections
        }
        continue;
      }
      if (!ctx) continue;

      // Provider entry: "  provider-c582e6:" or "  minimax:"
      if (ctx.providerId === null || indent <= ctx.providerIndent) {
        const m = line.match(/^([A-Za-z0-9._-]+):\s*$/);
        if (m && indent >= 2) {
          ctx.providerId = m[1];
          ctx.providerIndent = indent;
          ctx.inModels = false;
          ctx.modelId = null;
          if (!providers.has(ctx.providerId)) {
            providers.set(ctx.providerId, { name: ctx.providerId, kind: ctx.section });
          }
          continue;
        }
      }
      if (!ctx.providerId) continue;

      const kv = line.match(/^([A-Za-z0-9._-]+):\s*(.*)$/);
      if (!kv) continue;
      const [, key, rest] = kv;

      if (key === 'models' && rest === '') {
        ctx.inModels = true;
        ctx.modelId = null;
        ctx.modelIndent = -1;
        continue;
      }
      if (!ctx.inModels && key === 'name' && rest) {
        providers.get(ctx.providerId).name = unquote(rest);
        continue;
      }
      if (ctx.inModels) {
        if (ctx.modelId === null || indent <= ctx.modelIndent) {
          const mm = line.match(/^([A-Za-z0-9._-]+):\s*$/);
          if (mm) {
            ctx.modelId = mm[1];
            ctx.modelIndent = indent;
            modelToProvider.set(ctx.modelId, ctx.providerId);
            continue;
          }
        }
        if (ctx.modelId && key === 'name' && rest) {
          modelNames.set(`${ctx.providerId}/${ctx.modelId}`, unquote(rest));
        }
      }
    }
  } catch {
    // tolerate partial catalog
  }
  return { providers, modelNames, modelToProvider };
}

// --- runtime log enrichment (turn_id -> provider/model, per-call status) -----
//
// Log files rotate hourly: runtime-YYYYMMDDHH.log (local time). Select files by
// filename hour intersecting the window (plus 1h look-behind for stragglers),
// so coverage spans the whole window instead of just the newest few files.
// Each llm_response_identifiers line contributes one call record with its own
// timestamp and response_status; a turn produces one line per LLM call.

const LOG_LINE_TS = /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/;

export function loadTurnEnrichment(dataDir, windowStartMs, options = {}) {
  const maxBytesPerFile = options.maxBytesPerFile ?? 12 * 1024 * 1024;
  const now = options.now ?? Date.now();
  const map = new Map();
  const dir = path.join(dataDir, 'v2', 'observability', 'logs');
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => /^runtime-\d+\.log$/.test(f));
  } catch {
    return { map, filesScanned: 0 };
  }
  const firstHour = new Date(windowStartMs - 3600000);
  firstHour.setMinutes(0, 0, 0);
  let filesScanned = 0;
  for (const name of names) {
    const m = name.match(/^runtime-(\d{4})(\d{2})(\d{2})(\d{2})\.log$/);
    if (!m) continue;
    const fileHourMs = new Date(+m[1], +m[2] - 1, +m[3], +m[4]).getTime();
    if (fileHourMs < firstHour.getTime() || fileHourMs > now + 3600000) continue;
    const p = path.join(dir, name);
    let text;
    try {
      const st = fs.statSync(p);
      const fd = fs.openSync(p, 'r');
      try {
        const start = st.size > maxBytesPerFile ? st.size - maxBytesPerFile : 0;
        const buf = Buffer.alloc(st.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    filesScanned += 1;
    const dayBase = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    for (const line of text.split('\n')) {
      const i = line.indexOf('llm_response_identifiers ');
      if (i < 0) continue;
      const j = line.indexOf('{', i);
      if (j < 0) continue;
      let obj;
      try {
        obj = JSON.parse(line.slice(j));
      } catch {
        continue; // partial tail line or unexpected shape
      }
      if (!obj || !obj.turn_id) continue;
      const tm = line.slice(0, i).match(LOG_LINE_TS);
      const ts = tm
        ? dayBase + (+tm[1] * 3600 + +tm[2] * 60 + +tm[3]) * 1000 + +tm[4]
        : null;
      if (!map.has(obj.turn_id)) map.set(obj.turn_id, { provider: null, model: null, calls: [] });
      const entry = map.get(obj.turn_id);
      if (!entry.provider && obj.provider) entry.provider = obj.provider;
      if (!entry.model && obj.model) entry.model = obj.model;
      entry.calls.push({ ts, status: typeof obj.response_status === 'number' ? obj.response_status : null });
    }
  }
  for (const entry of map.values()) entry.calls.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return { map, filesScanned };
}

// --- row identity + metrics ---------------------------------------------------

export function resolveRowIdentity(row, enrichment, catalog) {
  let model = row.model || null;
  let provider = null;
  const hit = row.turn_id ? enrichment.get(row.turn_id) : null;
  if (hit) {
    provider = hit.provider || null;
    model = model || hit.model || null;
  }
  let providerId = null;
  let custom = false;
  if (provider && provider.startsWith('custom_provider:')) {
    providerId = provider.slice('custom_provider:'.length);
    custom = true;
  } else if (provider) {
    providerId = provider;
    custom = catalog.providers.get(providerId)?.kind === 'custom';
  }
  if (!providerId && model && catalog.modelToProvider.has(model)) {
    providerId = catalog.modelToProvider.get(model);
    custom = catalog.providers.get(providerId)?.kind === 'custom';
    provider = custom ? `custom_provider:${providerId}` : providerId;
  }
  const modelKey = providerId && model ? `${providerId}/${model}` : null;
  return {
    provider: provider || 'unknown',
    providerId: providerId || 'unknown',
    model: model || '(unknown)',
    custom,
    providerName: (providerId && catalog.providers.get(providerId)?.name) || provider || 'unknown',
    modelName: (modelKey && catalog.modelNames.get(modelKey)) || model || '(unknown)',
  };
}

export function emptyMetrics() {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cacheHitRate: null,
    costUsd: 0,
  };
}

export function addRow(m, r) {
  m.calls += 1;
  m.inputTokens += r.input_tokens || 0;
  m.outputTokens += r.output_tokens || 0;
  m.reasoningTokens += r.reasoning_tokens || 0;
  m.cacheReadTokens += r.cache_read_tokens || 0;
  m.cacheWriteTokens += r.cache_write_tokens || 0;
  m.costUsd += r.cost_usd || 0;
}

export function finalize(m) {
  m.totalTokens = m.inputTokens + m.outputTokens + m.reasoningTokens + m.cacheReadTokens + m.cacheWriteTokens;
  const denom = m.inputTokens + m.cacheReadTokens;
  m.cacheHitRate = denom > 0 ? Math.round((m.cacheReadTokens / denom) * 10000) / 10000 : null;
  m.costUsd = Math.round(m.costUsd * 1e6) / 1e6;
  return m;
}

export function sortGroups(groups) {
  return groups.sort((a, b) => {
    if (a.custom !== b.custom) return a.custom ? -1 : 1;
    return b.totalTokens - a.totalTokens;
  });
}

// --- per-call ledger (usage rows joined with message timing + log status) ----
//
// local_runtime_token_usage never stores the model and has no call duration.
// One side source completes the picture: assistant message rows
// (local_runtime_message_rows.data_json) carry the very timings MiniMax Code
// itself uses for pi_llm_tokens_per_second — usage.request_duration_ms (request
// start → stream end) and usage.decode_duration_ms (first token → stream end) —
// plus finish_reason. Log lines additionally carry response_status.
//
// Pairing: within a turn the two sequences are strictly interleaved —
// usage row[i].ts equals message[i-1].created_at_ms exactly, i.e. a usage row
// is stamped when its call STARTS and the matching assistant message is written
// when that call ENDS. So row[i] pairs with message[i] by index, never by
// nearest timestamp (nearest-neighbour shifts by one and inflates the rate).

const PAIR_MAX_GAP_MS = 5 * 60 * 1000; // call longer than this with no matching message is treated as unmeasured

export function loadAssistantCallDetails(db, rows) {
  const pairSet = new Set();
  const turnIds = new Set();
  for (const r of rows) {
    if (!r.turn_id) continue;
    pairSet.add(`${r.session_id}|${r.turn_id}`);
    turnIds.add(r.turn_id);
  }
  const byTurn = new Map(); // key `${session_id}|${turn_id}` -> [{ts, decodeMs, requestMs, finishReason}]
  if (!turnIds.size) return byTurn;
  const ids = [...turnIds];
  const CHUNK = 250;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    let stmt;
    try {
      stmt = db.prepare(
        `SELECT session_id, turn_id, created_at_ms, data_json
           FROM local_runtime_message_rows
          WHERE role = 'assistant' AND turn_id IN (${placeholders})
          ORDER BY created_at_ms`,
      );
    } catch {
      return byTurn; // message table missing on older runtimes
    }
    for (const m of stmt.iterate(...slice)) {
      const key = `${m.session_id}|${m.turn_id}`;
      if (!pairSet.has(key)) continue;
      let decodeMs = null;
      let requestMs = null;
      let finishReason = null;
      try {
        const d = JSON.parse(m.data_json);
        if (d && d.usage) {
          if (typeof d.usage.decode_duration_ms === 'number') decodeMs = d.usage.decode_duration_ms;
          if (typeof d.usage.request_duration_ms === 'number') requestMs = d.usage.request_duration_ms;
        }
        if (d && typeof d.finish_reason === 'string') finishReason = d.finish_reason;
      } catch {
        // malformed message payload — timing unavailable for this call
      }
      if (!byTurn.has(key)) byTurn.set(key, []);
      byTurn.get(key).push({ ts: m.created_at_ms, decodeMs, requestMs, finishReason, used: false });
    }
  }
  return byTurn;
}

function nearestByTime(list, ts, tolerance) {
  // list is sorted by ts; linear scan with an early exit is fine (per-turn lists are short)
  let best = null;
  let bestDelta = Infinity;
  for (const item of list) {
    if (item.ts == null) continue;
    const delta = Math.abs(item.ts - ts);
    if (delta < bestDelta) {
      best = item;
      bestDelta = delta;
    }
    if (item.ts > ts && item.ts - ts > bestDelta) break;
  }
  return bestDelta <= tolerance ? best : null;
}

// Build one ledger entry per usage row, ordered by ts.
// Message pairing is by index inside the turn (see loadAssistantCallDetails);
// only log status lines are matched by time. rate = output_tokens / decode_duration.
export function buildCallLedger(rows, enrichment, assistantByTurn, catalog) {
  const ledger = [];
  const cursor = new Map(); // turn key -> next assistant message index
  for (const row of rows) {
    const id = resolveRowIdentity(row, enrichment, catalog);
    const key = `${row.session_id}|${row.turn_id}`;
    // index pairing: row[i] <-> message[i]; fall back to time only when the turn
    // has more rows than messages (a call whose message row never landed).
    let msg = null;
    const list = row.turn_id ? assistantByTurn.get(key) : null;
    if (list && list.length) {
      const idx = cursor.get(key) || 0;
      const candidate = list[idx];
      if (candidate) {
        // the matching message must start at/after the call start and end soon after
        const gap = candidate.ts - row.ts;
        if (gap >= -2000 && gap <= PAIR_MAX_GAP_MS) {
          msg = candidate;
          cursor.set(key, idx + 1);
        } else {
          // sequences diverged (extra/missing row) — keep the cursor aligned by time
          const byTime = nearestByTime(list.slice(idx), row.ts, PAIR_MAX_GAP_MS);
          if (byTime) {
            msg = byTime;
            cursor.set(key, list.indexOf(byTime, idx) + 1);
          }
        }
      }
    }
    const enrichEntry = row.turn_id ? enrichment.get(row.turn_id) : null;
    // status lines are only used to exclude failures; pick any within tolerance
    const statusHit = enrichEntry ? nearestByTime(enrichEntry.calls, row.ts, 3 * 60 * 1000) : null;
    const status = statusHit ? statusHit.status : null;
    const decodeMs = msg ? msg.decodeMs : null;
    const requestMs = msg ? msg.requestMs : null;
    const output = row.output_tokens || 0;
    const succeeded = status == null || status === 200; // a recorded usage row implies a completed call
    // Official rate (matches MiniMax Code's pi_llm_tokens_per_second and CC Switch's
    // "speed"): output tokens ÷ whole API call duration (request start → stream end).
    const rate = succeeded && requestMs > 0 && output > 0 ? Math.round((output / (requestMs / 1000)) * 100) / 100 : null;
    // Pure generation speed (first token → stream end), shown as the reference column;
    // the gap between the two is time-to-first-token plus queueing.
    const decodeRate =
      succeeded && decodeMs > 0 && output > 0 ? Math.round((output / (decodeMs / 1000)) * 100) / 100 : null;
    ledger.push({
      ts: row.ts,
      sessionId: row.session_id,
      agentName: row.agent_name || null,
      turnId: row.turn_id || null,
      // identity (from resolveRowIdentity)
      provider: id.provider,
      providerId: id.providerId,
      model: id.model,
      custom: id.custom,
      providerName: id.providerName,
      modelName: id.modelName,
      // snake_case token fields keep addRow() compatibility
      input_tokens: row.input_tokens || 0,
      output_tokens: row.output_tokens || 0,
      reasoning_tokens: row.reasoning_tokens || 0,
      cache_read_tokens: row.cache_read_tokens || 0,
      cache_write_tokens: row.cache_write_tokens || 0,
      cost_usd: row.cost_usd || 0,
      decodeMs,
      requestMs,
      finishReason: msg ? msg.finishReason : null,
      status,
      rate,
      decodeRate,
    });
  }
  return ledger;
}

export function buildLedgerWithDb(db, rows, enrichment, catalog) {
  return buildCallLedger(rows, enrichment, loadAssistantCallDetails(db, rows), catalog);
}

// --- rate aggregation ---------------------------------------------------------
//
// The primary rate follows MiniMax Code's own definition
// (agent-core/pi-turn-runner/metrics.js: pi_llm_tokens_per_second = output tokens
// ÷ whole API call duration), which CC Switch mirrors as its "speed". That number
// is produced by the runtime itself, so it needs no trimming.
//
// Only the auxiliary decode rate can be corrupt: a truncated stream leaves a
// ~100ms timer that yields thousands of tok/s. Such calls keep their (correct)
// primary rate and their raw decode value is simply left out of decode stats.

export function collectDecodeRates(calls) {
  const out = [];
  for (const c of calls) {
    if (typeof c.decodeRate !== 'number') continue;
    // decode longer than the request it belongs to is structurally impossible
    if (c.decodeMs != null && c.requestMs != null && c.decodeMs > c.requestMs) continue;
    out.push(c.decodeRate);
  }
  return out;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

function stats(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    mean: round2(sum / sorted.length),
    p50: round2(percentile(sorted, 0.5)),
    p90: round2(percentile(sorted, 0.9)),
    max: round2(sorted[sorted.length - 1]),
    n: sorted.length,
  };
}

// Primary rate summary over every measured call (mean + percentiles).
export function rateStats(calls) {
  const values = [];
  for (const c of calls) if (typeof c.rate === 'number') values.push(c.rate);
  return stats(values);
}

// Mean of the primary (official) per-call rate.
export function meanCallRate(calls) {
  return rateStats(calls)?.mean ?? null;
}

export function countRatedCalls(calls) {
  let n = 0;
  for (const c of calls) if (typeof c.rate === 'number') n += 1;
  return n;
}

// Reference decode-rate summary (pure generation speed, first token → stream end).
export function decodeRateStats(calls) {
  return stats(collectDecodeRates(calls));
}
