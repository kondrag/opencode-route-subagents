# opencode-route-subagents

An [OpenCode](https://opencode.ai) V2 plugin that rewrites `general` subagent
dispatches to specialized agents — code review, plan review, or one of three
implementer tiers — and pins the configured model on every subagent dispatch
so per-agent model tiers actually hold.

## What it does

The plugin hooks `execute.before` on the `subagent` tool (OpenCode V2) and
does two things:

### 1. Routing `general` dispatches

A `general` dispatch is reclassified from its **description** alone:

| Description matches | Routed to |
| --- | --- |
| `review` + plan/spec/design-doc words | `plan-reviewer` |
| `review` (anything else) | `code-reviewer` |
| implement verb + cheap cues (`cheapest`, `mechanical`, `transcription`, `single-file`) | `implementer-cheap` |
| implement verb + deep cues (`deepest`, `most capable`, `architecture`, `design judgment`, `broad codebase`) | `implementer-deep` |
| implement verb (`implement`, `build`, `write`, `create`, `refactor`, `scaffold`, `develop`) | `implementer` |
| no review/implement verb | stays `general` |

Review wins over implement verbs, so "review the implementation plan" routes
to `plan-reviewer`, not an implementer. Tier words are evaluated cheap → deep
→ standard; with no usable cue the standard `implementer` floor applies.

Implementer prompts from the superpowers
[subagent-driven-development](https://github.com/obra/superpowers) flow carry
a `model:` tier directive. A direct agent name in the directive
(`model: implementer-deep`) wins, then tier words — from the directive first,
then the description. The prompt body is deliberately **not** scanned, so SDD
template boilerplate (self-review sections, "the plan" references) can't
pollute classification.

### 2. Pinning per-agent models

Callers tend to echo the parent session's model in the tool-level `model`
parameter, which can defeat per-agent model tiers. The plugin reads the config
itself — first existing of `ROUTE_SUBAGENTS_CONFIG`, `../opencode.jsonc`
relative to the plugin file, then `~/.config/opencode/opencode.jsonc`
(cached by path + mtime, comments and trailing commas tolerated) — and sets
`input.model` so the configured tier wins:

- on routed dispatches — the routed agent's configured model, or the override
  is dropped if that agent has none
- on direct dispatches of a named agent — the configured model wins over a
  caller-echoed one
- dispatches that stay `general`, and agents without a configured model, are
  untouched

Decisions are logged to stderr with a `[route-subagents]` prefix.

The model can be a `"providerID/modelID[#variant]"` string or the expanded
V2 object form (`{ "providerID": ..., "model": ..., "variant": ... }`) that
OpenCode's config normalizer emits. The native plural `agents` key is read
first; the legacy singular `agent` key works as a fallback. Prefer the native
key: OpenCode's normalizer silently drops `#variant` references and object
models from the legacy key, so variant pinning only survives under `agents`.

## Install

Clone as a global plugin (OpenCode auto-loads `~/.config/opencode/plugin/`):

```sh
git clone https://github.com/kondrag/opencode-route-subagents.git \
  ~/.config/opencode/plugin/route-subagents
```

The plugin expects these agents to exist, e.g. from a superpowers setup:
`code-reviewer`, `plan-reviewer`, `implementer`, `implementer-cheap`,
`implementer-deep`. It finds your `opencode.jsonc` via the search order
described above, so the layout above — plugin directory next to your global
`opencode.jsonc` — is what the model-pinning lookup expects. On other hosts
without the V2 tool domain it fails quietly and does nothing.

Alternatively, symlink just the runtime files into the plugins directory your
config references (e.g. `~/.config/opencode/plugins/`):

```sh
ln -s ~/workspace/opencode-route-subagents/route-subagents.js \
      ~/workspace/opencode-route-subagents/route-logic.mjs \
      ~/.config/opencode/plugins/
```

Symlinks work because the config search falls through to
`~/.config/opencode/opencode.jsonc` when the repo-relative path misses —
`git pull` in the checkout then updates the deployed plugin directly.

## Configuration

Per-agent model tiers in your `opencode.jsonc` (one level up from the plugin
directory). Example mirroring the tiers the tests assert against:

```jsonc
{
  "agents": {
    "code-reviewer":     { "model": "zai-coding-plan/glm-5.3#max" },
    "plan-reviewer":     { "model": "zai-coding-plan/glm-5.3#max" },
    "implementer":       { "model": "zai-coding-plan/glm-5.3-flash#high" },
    "implementer-cheap": { "model": "zai-coding-plan/glm-5.3-flash" },
    "implementer-deep":  { "model": "zai-coding-plan/glm-5.3#max" },
    // expanded V2 object form also works, with or without a variant
    "explore": { "model": { "providerID": "unsloth", "model": "Unsloth-Qwen3.8-27B", "variant": "nothink" } },
  },
}
```

Any `providerID/modelID[#variant]` string works, as does the expanded object
form above. The legacy singular `"agent": { ... }` key is still read as a
fallback, but OpenCode's normalizer strips `#variant` references and object
models from it — use the native `agents` key when pinning variants. The
config path search order is: `ROUTE_SUBAGENTS_CONFIG` env override, then
`../opencode.jsonc` relative to the plugin file, then
`$XDG_CONFIG_HOME/opencode/opencode.jsonc` (defaulting to
`~/.config/opencode/opencode.jsonc`).

## Development

```
route-subagents.js        Plugin entrypoint (V2 contract: default export { id, setup })
route-logic.mjs           Pure routing logic, unit-testable without a plugin context
route-subagents.test.mjs  node:test coverage for logic and hook wiring
```

Run the suite:

```sh
npm test
```

Requires Node ≥ 20.11 (`import.meta.dirname`). The suite is hermetic: it
writes a temporary config fixture and points `ROUTE_SUBAGENTS_CONFIG` at it,
so no external `opencode.jsonc` is needed.

## Requirements

- OpenCode v2 (hooks the `subagent` tool; V1's `task` / `subagent_type`
  shape is not handled)
- Node ≥ 20.11

## License

[MIT](LICENSE)
