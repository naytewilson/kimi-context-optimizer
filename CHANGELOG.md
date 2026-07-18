# Changelog

## 1.0.0

Initial release — full port of claude-context-optimizer (CCO) to Kimi Code CLI.

- **All 24 src modules ported** to Kimi hook events and data formats: read-cache,
  context-shield, prompt-coach (EN+RU), tracker, budget, dashboard, report, roi,
  digest, export, replay, overhead, smart-pack, anatomy, tasks, doctor,
  agentsmd-analyzer (was claudemd-analyzer), git-context, contextignore,
  file-digest, simulate-savings, and shared libs (utils, hook-io, wire-usage,
  kimi-config, notices). 77 node:test tests green.
- **Real usage from wire.jsonl**: budget % and cache economics read actual
  per-step context size (`inputCacheRead`/`inputCacheCreation`) instead of
  estimates; estimates self-calibrate against wire data.
- **Window-aware budgets**: effective budget caps to the active model's
  `max_context_size` from `~/.kimi-code/config.toml` (256K default, 1M on k3);
  `KCO_CONTEXT_WINDOW` overrides.
- **Subscription-honest metrics**: tokens + % of window are primary; dollar
  figures only via opt-in `pricePerMillionInput/Output` in config.json.
- **New tracking signals**: PostToolUseFailure health tracking and
  SubagentStart/Stop delegation attribution.
- **19 skills** under `skills/kco-*` (`/kco`, `/kco-budget`, `/kco-report`,
  `/kco-roi`, `/kco-digest`, `/kco-export`, `/kco-clean`, `/kco-doctor`,
  `/kco-replay`, `/kco-task`, `/kco-pack`, `/kco-templates`, `/kco-git`,
  `/kco-anatomy`, `/kco-shield`, `/kco-agentsmd`, `/kco-coach`,
  `/kco-overhead`, `/kco-smart-loader`) — 1:1 with the original set.
  The original `overhead.js mcp` audit and `doctor --tests` flag were dropped
  (Claude-specific / not ported).
- **agents/context-analyzer.md** reference sub-agent, `.contextignore.example`,
  and a tokens-first `benchmark/run.js` (Claude's $-priced cache-break section
  replaced with cache-bucket economics; $ shown only when pricing configured).
