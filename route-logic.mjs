// Pure routing logic for the route-subagents plugin.
//
// Kept separate from the OpenCode plugin entrypoint so it can be unit-tested
// without a plugin context (see route-subagents.test.mjs).

const RE = {
  review:    /\breview/,
  code:      /\bcodes?\b|\bdiffs?\b|\bpatches?\b/,
  plan:      /\bplan(s|ning|ned|ner)?\b|\bspec(s|ification)?\b|\bdesign doc\b/,
  implement: /\bimplement|\bbuild|\bwrite|\bcreate|\brefactor|\bscaffold|\bdevelop/,
};

// Tier vocabulary from SKILL.md "Model Selection" (superpowers
// subagent-driven-development).
const TIER = {
  cheap:    /\bcheap(est)?\b|\bmechanical\b|transcription|single-file/,
  deep:     /\bdeep(est)?\b|most capable|architecture|design judgment|broad codebase/,
  standard: /\bstandard\b|\bmid-?tier\b|integration|judgment/,
};

// Superpowers implementer prompts carry a `model:` directive expressing the
// tier the skill chose (per SKILL.md Model Selection). The subagent tool's
// agent name can't express that choice, so we read the directive here and map
// it to the matching implementer agent variant.
const modelDirective = (prompt) => {
  const m = (prompt || "").match(/model:\s*([^\n]*)/);
  return m ? m[1] : "";
};

// Resolve the model for a routed agent. OpenCode v2.0.24 subagent children
// inherit the parent session's model; the `agents.<name>.model` entry in
// opencode.jsonc is not applied to subagent dispatches. To honor the per-agent
// model tiers, the router sets `input.model` explicitly from that config.
// Reads both the native `agents` key and the legacy `agent` key. The model may
// be a "provider/model#variant" string or the expanded V2 object form.
// Returns undefined when the config has no model for the agent.
export const agentModel = (target, config) => {
  const entry = config?.agents?.[target] ?? config?.agent?.[target];
  const model = entry?.model;
  if (typeof model === "string" && model) return model;
  if (
    model && typeof model === "object" &&
    model.providerID && typeof model.model === "string" && model.model
  ) {
    return model.variant
      ? `${model.providerID}/${model.model}#${model.variant}`
      : `${model.providerID}/${model.model}`;
  }
  return undefined;
};

export const resolveImplementerTier = ({ description, prompt } = {}) => {
  const directive = modelDirective(prompt);
  const desc = (description || "").toLowerCase();

  // 1. Direct agent names in the directive win.
  if (/implementer-cheap/.test(directive)) return "implementer-cheap";
  if (/implementer-deep/.test(directive)) return "implementer-deep";
  if (/\bimplementer\b/.test(directive)) return "implementer";

  // 2. Tier words from SKILL.md Model Selection: directive first, then the
  //    description. The prompt body is deliberately not scanned — SDD template
  //    boilerplate would pollute the tier choice.
  if (TIER.cheap.test(directive) || TIER.cheap.test(desc)) return "implementer-cheap";
  if (TIER.deep.test(directive) || TIER.deep.test(desc)) return "implementer-deep";
  if (TIER.standard.test(directive) || TIER.standard.test(desc)) return "implementer";

  // 3. No usable directive — default to the standard floor.
  return "implementer";
};

// Decide which specialized agent a `general` subagent dispatch should run as.
// Returns undefined when the dispatch should stay `general`.
//
// Classification runs on the description only: SDD implementer prompts always
// contain self-review/plan boilerplate, so scanning the prompt body would route
// every implementer dispatch to a reviewer. The prompt is consulted solely for
// the `model:` tier directive (see resolveImplementerTier).
export const route = ({ description, prompt } = {}) => {
  const desc = (description || "").toLowerCase();
  if (!desc) return undefined;

  if (RE.review.test(desc)) {
    // Review tasks take precedence over the bare "implement" keyword, so
    // "review the implementation plan" routes to a reviewer, not implementer.
    return RE.plan.test(desc) ? "plan-reviewer" : "code-reviewer";
  }
  if (RE.implement.test(desc)) {
    return resolveImplementerTier({ description: desc, prompt });
  }
  return undefined;
};

