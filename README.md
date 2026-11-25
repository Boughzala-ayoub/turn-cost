# turn-cost

A lightweight **Claude Code mod** (TypeScript · Claude Code Mods API) that appends per-turn USD cost, token totals (`in / out / cache`), best-effort subagent attribution, and an estimated 5-hour quota share directly onto each turn's closing transcript line:

```text
Baked for 41s · $0.42 · ~1.8% 5h · in 12.3k out 2.1k cache 1.4M · 2 agents
```

No extra panels, banners, or UI clutter — it extends only the built-in `TurnDuration` transcript row via `ui.render`.

## How it works

- **Per-turn USD & tokens (`turn.start` / `turn.complete`):** Captures `$.session.usage()` at turn start and completion to compute exact per-turn session USD delta and fresh input, cache-write, cache-read, and output tokens.
- **Best-effort subagent attribution:** Subagent completions (`e.agentId`) fold their token usage and agent count into the active main turn (or the most recently completed turn for background subagents) and trigger `$.ui.invalidate('ui.render')`.
- **Estimated 5-hour quota share (`turn.step`):** Tracks each running session's cumulative spend in `<TEMP>/claude-turn-cost/<session-id>.json` to estimate the account's `% per dollar` factor `k` across concurrent sessions running the mod, persisting calibrated values (≥ 5 percentage points observed) via `$.store.set('k', k)`. Uncalibrated estimates are prefixed with `~`.

## Install

Clone or copy this folder into your Claude Code mods directory (`~/.claude/mods/turn-cost`) and restart Claude Code:

```sh
git clone https://github.com/Boughzala-ayoub/turn-cost.git ~/.claude/mods/turn-cost
```

## Files

- `.claude-plugin/plugin.json` — Mod manifest
- `hooks/hooks.json` — Hook registration manifest
- `hooks/register.ts` — Function hooks (`turn.start`, `turn.step`, `turn.complete`, `ui.render`)
- `tsconfig.json` — TypeScript configuration

## License

[MIT](LICENSE)
