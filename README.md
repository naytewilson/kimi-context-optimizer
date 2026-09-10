<p align="center">
  <img src="assets/logo.svg" alt="kimi-context-optimizer" width="640"/>
</p>

<p align="center">
  <strong>Reduce avoidable Kimi Code context input without inventing savings numbers.</strong><br/>
  <sub>Observed wire usage, conservative counterfactual read estimates, current Kimi tool compatibility, zero npm dependencies.</sub>
</p>

<p align="center">
  <a href="#install"><img src="https://img.shields.io/badge/kimi--code-plugin-22d3ee?style=flat-square" alt="Kimi Code Plugin"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"/></a>
  <img src="https://img.shields.io/badge/node-18%20%7C%2020%20%7C%2022-brightgreen?style=flat-square" alt="Node 18, 20, 22"/>
  <img src="https://img.shields.io/badge/deps-zero-blue?style=flat-square" alt="Zero Dependencies"/>
  <img src="https://img.shields.io/badge/telemetry-none-critical?style=flat-square" alt="No Telemetry"/>
</p>

## What KCO measures

KCO deliberately separates quantities that are easy to blur together:

- **OBSERVED usage:** current context size, cumulative input/output, cache-read input, cache creation, model identity, and recognized wire schema from Kimi Code session transcripts.
- **ESTIMATED counterfactual savings:** the input text that a blocked redundant read would have returned, estimated from the **actual requested characters on disk** and locally calibrated.
- **ESTIMATED KCO overhead:** model-visible read-cache block feedback plus notices that are actually delivered to the model.
- **Diagnostic replay signal:** cumulative input-side processing divided by novel-side input. This can justify earlier compaction, but it is not multiplied into the savings claim.

The runtime accounting identity is intentionally boring:

```text
estimated net direct-input reduction
  = estimated blocked-read result tokens
  - estimated model-visible block-feedback tokens
  - estimated delivered KCO notice tokens
```

Negative net values are preserved. KCO does not floor an inconvenient result to zero.

**Cache-read tokens are usage telemetry, not KCO token savings.** `inputCacheRead` tells you how much input Kimi served from prompt cache. It is still input-side processing.

**The result is not a direct measurement of Kimi subscription quota or credits.** Kimi's subscription limits and cache economics are not a single public linear tokens-to-credits conversion, so KCO does not pretend raw avoided tokens equal an exact percentage of extra subscription usage.

## What it does

### Redundant-read guard

KCO intercepts both current and legacy Kimi tool names, including `ReadFile`/`Read`, `StrReplaceFile`/`Edit`, `WriteFile`/`Write`, and `Shell`/`Bash`.

For an unchanged file range that is already loaded, a repeated read is blocked and replaced with a compact structural map. Current Kimi range syntax is supported directly:

```text
ReadFile path="src/example.js" line_offset=120 n_lines=60
```

A file edit invalidates the cached read state. In quota mode, unchanged cached reads do **not** expire merely because ten minutes passed; time-based expiry is opt-in. This avoids re-reading unchanged text just because a wall clock moved, which is a rather human way to waste machine tokens.

### Quota-aware budget guard

KCO resolves the exact session transcript through Kimi's session index, parses supported usage rows, and incrementally reads appended wire data. It can use observed context size and replay behavior to recommend `/compact` earlier when continued replay is becoming expensive.

High-frequency `PostToolUse` observation hooks stay silent. Actionable budget notices are queued and only charged as KCO overhead if a later model-visible prompt phase actually delivers them.

### Wire-schema doctor

`/kco-doctor` does more than check whether a `wire.jsonl` file exists. It verifies that reachable transcripts contain a usage schema KCO actually recognizes. If Kimi changes the wire contract, doctor warns that ground-truth accounting is unavailable instead of cheerfully parsing zero rows and calling it science.

### ContextShield and Prompt Coach

ContextShield records historical unused-read patterns and can suggest `.contextignore` rules. Those historical figures are labeled **estimated historical read volume**, not guaranteed future savings.

Prompt Coach grades task prompts and can inject focused guidance. Any model-visible coaching text is included in KCO's delivered-notice overhead accounting.

## Install

Requires Kimi Code CLI and Node.js >= 18 on `PATH`.

```bash
/plugins install https://github.com/naytewilson/kimi-context-optimizer
/reload
```

For a local checkout:

```bash
/plugins install /path/to/kimi-context-optimizer
/reload
```

Then run `/kco-doctor` to verify manifest wiring, Node, configuration, transcript access, and supported wire schemas.

Kimi installs a managed copy of a plugin. Reinstall and `/reload` after updating the source checkout; doctor warns when the managed copy and source version drift.

## Main commands

| Command | Purpose |
|---|---|
| `/kco` | Context board with observed usage plus **estimated net direct-input reduction** |
| `/kco-budget` | Context-budget and compaction settings |
| `/kco-doctor` | Install health and supported-wire-schema check |
| `/kco-shield [suggest\|apply]` | Historical unused-read analysis and `.contextignore` rules |
| `/kco-coach [text]` | Prompt quality analysis |
| `/kco-overhead` | Inspect fixed session overhead from wire data where available |
| `/kco-replay [N]` | Recover compact prior-session summaries |
| `/kco-report` | Cross-session token and usage report |
| `/kco-digest [days]` | Efficiency trends |
| `/kco-export [md\|html]` | Export reports |
| `/kco-clean` | Reset stored KCO state |

## Current hook compatibility

Production hooks normalize current Kimi built-ins at one boundary rather than maintaining separate accounting implementations:

| Current Kimi name | Internal canonical name | Relevant payload support |
|---|---|---|
| `ReadFile` | `Read` | `path`, `line_offset`, `n_lines` |
| `WriteFile` | `Write` | `path` / compatible path alias |
| `StrReplaceFile` | `Edit` | `path`, nested `edit` object or array |
| `Shell` | `Bash` | shell command/output accounting |

Legacy `Read`, `Write`, `Edit`, and `Bash` payloads remain supported.

## Accounting details

### Observed wire usage

For recognized Kimi usage rows, KCO keeps these concepts separate:

```text
current context tokens
cumulative novel/input-other tokens
cumulative cache-read tokens
cumulative cache-creation tokens
cumulative output tokens
```

Current context occupancy is not the same thing as cumulative input-side processing. The dashboard never divides one by savings from another and calls the result an "effective context multiplier."

### Blocked-read estimate

A blocked result never reaches Kimi's tokenizer, so KCO cannot observe its exact provider token count after the fact. KCO therefore:

1. reads the exact requested text range from disk;
2. estimates tokens using extension-aware local ratios;
3. applies the locally learned calibration factor, bounded to avoid runaway correction;
4. labels the result `ESTIMATED`;
5. subtracts the estimated token cost of the block message shown to the model.

This is stronger than counting requested lines against an average file size, but it remains a counterfactual estimate and is presented as one.

### Notice overhead

Queued notices cost zero until delivery because text sitting in KCO's state directory is not model context. When a queued notice is flushed into a model-visible hook phase, its estimated token size is charged to the session overhead ledger exactly once.

### Replay and prompt cache

Observed cache reads and replay amplification are useful quota-efficiency signals. They are deliberately excluded from the claimed direct-input reduction because multiplying a blocked read by future replay assumes the rest of the conversation would have remained identical. That counterfactual is not defensible without a controlled A/B run.

## Synthetic benchmark

`node benchmark/run.js` runs a **synthetic counterfactual benchmark** over deterministic repository fixtures. It uses the same gross-minus-model-visible-overhead identity as runtime accounting.

The benchmark reports **ESTIMATED** direct-input reduction for those fixtures. It is not measured live Kimi subscription quota savings, does not apply a replay multiplier, and does not claim that its fixture percentage is what every real session will achieve.

For a true causal savings percentage, the required experiment is a paired Kimi A/B run with matched tasks, model, reasoning effort, tool behavior, starting context, and provider conditions. Until that exists, the synthetic benchmark stays labeled synthetic. Civilization survives another percentage chart.

## Configuration

Optional settings live in `~/.kimi-context-optimizer/config.json`.

```json
{
  "budgetTokens": 200000,
  "warnAt": [50, 70, 85, 95],
  "autoCompactAt": 90,
  "quotaMode": true,
  "readCacheTimeStalenessMs": 0,
  "pricePerMillionInput": null,
  "pricePerMillionOutput": null,
  "quiet": false
}
```

- `quotaMode: true` keeps unchanged read-cache entries from expiring on wall clock alone.
- `readCacheTimeStalenessMs: 0` means no time-only expiry in quota mode; set a positive value to opt in.
- `pricePerMillionInput/Output` are optional user-supplied rates. Dollar output is labeled a configured-rate estimate and is not treated as authoritative Kimi subscription accounting.
- `KCO_HOME` moves KCO's local data directory.
- `KCO_CONTEXT_WINDOW` explicitly overrides model-window detection.

## Data and privacy

KCO state lives locally under `~/.kimi-context-optimizer/` by default. The plugin has no telemetry and does not send KCO tracking data to an external service.

## Development

```bash
npm test
node benchmark/run.js
node src/doctor.js
```

CI runs the test suite on Node 18, 20, and 22.

Repository layout:

```text
kimi.plugin.json    production hook wiring
src/                zero-dependency ESM hook and reporting modules
skills/             /kco-* command wrappers
benchmark/          synthetic counterfactual fixtures and runner
tests/              node:test contract, accounting, compatibility, reporting tests
docs/               documentation and design notes
```

## Credits

Forked from `egorfedorov/kimi-context-optimizer`, itself derived from `claude-context-optimizer` under MIT. This branch adds current-Kimi compatibility, exact-session wire authority, schema-drift detection, quota-aware compaction signals, conservative savings accounting, and evidence-labeled reporting.
