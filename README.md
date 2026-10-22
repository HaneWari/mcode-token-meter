# Token Meter Board

English | [简体中文](README.zh-CN.md)

A near-real-time token-usage dashboard for MiniMax Code, running entirely on your own machine. It reads the runtime's own per-call ledger and observability logs, so the numbers it shows are the ones the client actually recorded — not an estimate reconstructed from transcript files.

Author: [HaneWari](https://github.com/HaneWari) · Version: `1.8.0` · License: [Apache-2.0](LICENSE)

![Token Meter Board, synthetic data](docs/preview.png)

*The preview uses synthetic sessions and usage data. The app interface is currently in Chinese.*

## What you get

- **Usage trend** — stacked bars per model, with the cache-hit-rate and output-speed curves drawn on top. Buckets adapt from minutes to hours to days as the window grows.
- **Five detail tables** — per-model breakdown, daily totals, a 12-column **per-call ledger**, a **conversation (turn) table**, and a session ranking.
- **Conversation detail** — one row per question you asked. The row shows your own message text, the outcome, wall-clock duration, how many model calls the turn took, the tokens, and the rate. A turn that is still running is marked as unfinished and grows live — you do **not** have to close the session first.
- **Per-call ledger** — every single model call with its exact timestamp, model, all five token classes, output speed, whole-request speed, decode duration, request duration, and status code.
- **Time windows** — last hour / today / last 7 days / last 30 days, or any custom start and end. The time bar is laid out in two rows so the native date picker can never cover the *Apply* button, and pressing Enter inside a time field applies the window too.
- **5-second auto refresh** with a manual refresh button. Switching a window never blanks the tables and never waits: the previous window stays on screen until the new values arrive, and a late response from an older window is discarded rather than overwriting the newer one.

## Why this one

Most token boards in this ecosystem answer "how much did I spend". This one also answers "where did it go, and is the number I am looking at the number the client shows?".

- **It reads the ledger, not the transcripts.** Numbers come from the runtime's own per-call usage table plus the observability logs, not from reconstructing usage out of session transcript files. A transcript file carries one aggregate usage block per assistant message and no timing information at all, so any board that reads it silently drops a large and day-dependent share of the real calls (measured on a reference machine: between 24% and 63% of calls, and up to 83% of cache-read tokens, depending on the day).
- **The output speed matches the client.** Output speed is `Σ output tokens ÷ Σ decode duration` — the decode phase only, from the first token to the end of the stream — which is the same basis the MiniMax Code interface uses. The whole-request speed is shown next to it as a comparison column, so you can see how much of each call was spent waiting for the first token. A speed computed over the whole request instead reports a number roughly 2.4× lower and does not line up with the interface.
- **Totals add up to five terms.** `total = input + output + reasoning + cacheRead + cacheWrite`. Boards that stop at three terms silently drop cache writes and reasoning tokens.
- **Turn-level granularity.** One question becomes one row, with the call count and the tokens that question actually cost. Nothing has to be closed or archived first.
- **No Python, no extra process, no dependency.** Pure Node, zero third-party runtime code except a vendored copy of Chart.js. Another board in this ecosystem requires Python 3.8+ and spawns a Python process per query.
- **Milliseconds, not seconds.** After the caching rework in v1.7.0 a full page refresh went from ~8.5 s to ~30 ms, and switching to a 7-day window takes ~50 ms on a reference machine with a 1.7 M-row message table.
- **Strictly read-only.** The Mini App writes nothing, sends nothing, and has no telemetry. No account, no API key, no configuration.

## Install

Copy this entire directory into the MiniMax Code data directory. By default `<dataDir>` is `.minimax` in your home folder (`~/.minimax`), so the default path is:

```text
<dataDir>/plugins/token-meter-board/
```

| System | Target path |
| --- | --- |
| Windows | `C:\Users\<you>\.minimax\plugins\token-meter-board` |
| macOS | `/Users/<you>/.minimax/plugins/token-meter-board` |
| Linux | `/home/<you>/.minimax/plugins/token-meter-board` |

Keep the hidden `.minimax-plugin` directory — the plugin is recognised by it. If you set a custom data directory (`MINIMAX_DATA_DIR`), use that directory's `plugins/` folder instead.

Restart MiniMax Code, confirm the plugin is enabled, then open **Token 仪表盘** (Token Meter Board), or just ask the Agent to open it.

## Use it

Pick a window (preset or custom), and read the trend, the KPI strip, and the five tables below it. Model chips filter the charts and tables; the sessions ranking and the daily table have their own independent range selectors, so changing the main window never disturbs them. The page refreshes every 5 seconds, and the refresh button forces an immediate reload.

Example prompts, and what you get back:

- **"打开 Token 仪表盘"** → the dashboard opens on the current window.
- **"查看我的模型用量趋势"** → the trend chart with the per-model stacked bars, the cache-hit-rate curve and the output-speed curve.
- **"哪个自定义模型的缓存命中率最高？"** → the per-model table with the cache hit rate per provider and model.

The board also offers **让 Agent 分析此窗口** (let the Agent analyse this window): it appends the current window's totals, call count, cache hit rate and output speed to the chat input so you can ask follow-up questions about the same numbers you were just looking at.

## Data & access

**Files read (read-only, never modified):**

| Path | Used for |
| --- | --- |
| `<dataDir>/v2/sqlite/runtime-state.sqlite` | The per-call usage ledger and the assistant/user message rows (decode timings, finish reason, message text). Opened with `node:sqlite` in read-only mode. |
| `<dataDir>/v2/observability/logs/runtime-*.log` | Provider, model, and response status, correlated per turn. The usage table itself does not store the model name, so the logs are what make custom (BYOK) providers show up as themselves instead of "unknown". |
| `<dataDir>/config.yaml` | Provider and model display names, so the tables read "MiniMax-M3.1-Flash" rather than a raw id. |

The location is resolved from the Host-provided `context.dataDir` (the active MiniMax Code data directory), falling back to `~/.minimax`. **These paths and the column layout of the runtime database are not a published API** — they are the client's internal storage, so a future client release may change them. When that happens the board shows an explicit error instead of an empty dashboard.

**Nothing is written.** No files are created or modified, no data leaves the machine, and there is no telemetry. The only cache lives in the process memory of the running Mini App. The page does display real session titles and model names, so mind your screenshots when sharing them.

**Network:** none. The Mini App serves one page on `127.0.0.1` and answers its own API routes. It never contacts a remote host, and it makes no request other than to its own origin.

**Subprocess:** normally none. If the host's Node runtime does not expose `node:sqlite`, the Mini App re-runs the identical read-only queries in a child process: it spawns its own executable with `ELECTRON_RUN_AS_NODE=1`, falling back to `node` on `PATH`, and passes the query mode and parameters as an argv array — never through a shell. The child prints one JSON document on stdout and exits.

**Node.js:** the in-process path needs `node:sqlite`, which is unflagged from Node.js 23.4. The bundled runtime used for testing is Node.js v24.18.0. If neither the in-process runtime nor the child process has it, the board reports the requirement instead of failing silently.

## Metrics

| Metric | Definition |
| --- | --- |
| Total tokens | `input + output + reasoning + cacheRead + cacheWrite` |
| Cache hit rate | `cacheRead / (cacheRead + input)` — the share of the prompt that came from cache. Cache writes are not in the denominator. |
| Output speed | `Σ output tokens ÷ Σ decode duration`, weighted by time. Single call: `output tokens ÷ decode duration` (first token → end of stream). P50 and P90 are shown alongside. |
| Whole-request speed | `output tokens ÷ request_duration_ms` (request sent → end of stream). The difference against output speed is the first-token wait and queueing. |
| Conversation (turn) | One user message plus however many model calls the agent needed before answering. Duration is wall-clock span and is shown for information only; it does not enter the rate calculation. |

Calls whose decode duration exceeds the request duration are excluded from the speed aggregate (that combination means the first token arrived before the request was sent — a timestamp artefact that would otherwise inflate the denominator). They are still listed individually in the ledger. A turn that is still in flight is marked unfinished and its rate is computed from what has arrived so far.

## Tested environment

- MiniMax Code Desktop **3.1.4** (build 186), Windows 11 (10.0.22631, x64)
- Bundled Node.js **v24.18.0**, `node:sqlite` available
- Verified in the desktop client: plugin install, window switching, custom start/end windows, per-call ledger, live turn growth, auto refresh, light and dark themes, and the error path when the runtime database is missing.
- macOS and Linux are **not** verified. Nothing in the code is platform-specific — the data paths are resolved from `context.dataDir` — but treat the other platforms as untested.

## Limitations

- This is a **local observation tool**, not an invoice. Billing and quota are the product's own "usage" page, which is computed server-side and may catch up later.
- Numbers cover what the client recorded locally. Usage on another machine, or usage from a client that was never running locally, is not visible here.
- The runtime database and the observability log format are internal to the client and can change without notice.

## Third-party components

- [Chart.js](https://www.chartjs.org/) v4.4.3 — vendored at `miniapp/client/vendor/chart.umd.min.js` for offline use. MIT License, © Chart.js Contributors.

## Source layout

```text
miniapp/
  client/index.html              The whole page: markup, styles, and the client script
  client/vendor/                Chart.js (MIT), vendored for offline use
  node/server.mjs                HTTP server, routing, and the subprocess fallback
  node/lib/common.mjs            Data-dir resolution, config catalog, log enrichment, metrics
  node/lib/facts.mjs             Incremental message-fact cache (SQL-side JSON extraction)
  node/lib/queries.mjs           Window, summary, session, daily, call, and turn queries
  node/lib/trend.mjs             Window resolution and bucketing
  node/lib/db-child.mjs          Query runner for the subprocess fallback
```

No build step is required: the page and the Node service are used as they are.

## License

[Apache-2.0](LICENSE) — see the file for the full text.
