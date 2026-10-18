// route-subagents — OpenCode V2 plugin.
//
// Rewrites `general` subagent dispatches to specialized agents (code-reviewer,
// plan-reviewer, implementer, implementer-cheap, implementer-deep) based on the
// dispatch description and the SDD `model:` directive in the prompt. Routing
// rules live in route-logic.mjs; coverage lives in route-subagents.test.mjs.
//
// Also pins the configured `agents.<name>.model` onto DIRECT dispatches of a
// named agent: the host does not apply that config to subagent dispatches
// (children inherit the parent session's model, observed on v2.0.24), so
// without this, per-agent tiers only held for the routed `general` path.
//
// V2 contract: default export { id, setup } — see
// https://opencode.ai/v2/docs/build/plugins/migrate-v1 . No @opencode/plugin
// import: this global plugin has no local node_modules to resolve it from, and
// the plain object shape is what the host validates (id + setup).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentModel, route } from "./route-logic.mjs";

// Per-agent model tiers live in opencode.jsonc (`agents.<name>.model`; the
// legacy singular `agent` key is still read as a fallback — see
// route-logic.mjs). The
// host does not apply them to subagent dispatches, so the router reads the
// config itself and sets `input.model` on routed dispatches. Cached by mtime;
// re-read when the file changes. Returns {} when unavailable. The path
// defaults to ../opencode.jsonc relative to this file (the global-config
// layout) and can be overridden with ROUTE_SUBAGENTS_CONFIG.
const configPath = process.env.ROUTE_SUBAGENTS_CONFIG
  || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "opencode.jsonc");
let _cfgCache = { mtime: -1, config: {} };
const loadConfig = () => {
  try {
    const mtime = fs.statSync(configPath).mtimeMs;
    if (mtime !== _cfgCache.mtime) {
      const raw = fs.readFileSync(configPath, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
        .replace(/,(\s*[}\]])/g, "$1");
      _cfgCache = { mtime, config: JSON.parse(raw) };
    }
  } catch (err) {
    console.error("[route-subagents] config load failed:", err?.message);
    _cfgCache = { mtime: -1, config: {} };
  }
  return _cfgCache.config;
};

export default {
  id: "route-subagents",
  async setup(ctx) {
    // Fail quietly if loaded by a host without the V2 tool domain.
    if (!ctx || typeof ctx.tool?.hook !== "function") return;

    await ctx.tool.hook("execute.before", (event) => {
      // V2 subagent dispatch: tool "subagent" with the agent name in `agent`
      // (V1 was tool "task" with `subagent_type`).
      if (event.tool !== "subagent") return;
      const input = event.input;
      if (!input || !input.agent) return;

      if (input.agent === "general") {
        const target = route({ description: input.description, prompt: input.prompt });
        if (target) {
          input.agent = target;
          // Callers tend to echo the parent session's model here, which defeats
          // the per-agent model tiers. Pin the routed agent's configured model;
          // with no configured model, drop the override so nothing stale sticks.
          const model = agentModel(target, loadConfig());
          if (model) input.model = model;
          else delete input.model;
          console.error(`[route-subagents] ${target}${model ? " " + model : ""} <- general: ${input.description}`);
        } else {
          console.error(`[route-subagents] general (no route): ${input.description}`);
        }
        return;
      }

      // Direct dispatch of a named agent (`code-reviewer`, `implementer`, ...).
      // The host does not apply `agents.<name>.model` to subagent dispatches —
      // children inherit the parent session's model — so pin the configured
      // model here too, variant included. A caller-echoed model loses to the
      // config, same as on the routed path. Agents without a configured model
      // dispatch unchanged.
      const model = agentModel(input.agent, loadConfig());
      if (model) {
        input.model = model;
        console.error(`[route-subagents] pinned ${input.agent} ${model}: ${input.description}`);
      }
    });
  },
};
