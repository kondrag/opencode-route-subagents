import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";

const pluginURL = pathToFileURL(
  path.join(import.meta.dirname, "route-subagents.js")
).href;
const logicURL = pathToFileURL(
  path.join(import.meta.dirname, "route-logic.mjs")
).href;

// Hermetic config: in production the plugin searches for opencode.jsonc
// (env override, then relative to itself, then the global config dir), but
// the checkout rarely sits in one of those layouts with a real config. Point
// ROUTE_SUBAGENTS_CONFIG at a fixture so the suite passes anywhere; the
// values mirror the pinned-model assertions below. Candidates are recomputed
// on every config read, so tests may mutate (and restore) env at any point.
//
// Uses the native V2 `agents` key, matching production config. The expanded
// {providerID, model, variant} object form is what OpenCode's config
// normalizer emits, so it is exercised end-to-end through the hook (see the
// explore pinning test below).
const fixturePath = path.join(os.tmpdir(), "route-subagents.test.opencode.jsonc");
process.env.ROUTE_SUBAGENTS_CONFIG = fixturePath;
fs.writeFileSync(fixturePath, JSON.stringify({
  agents: {
    "code-reviewer":     { model: "zai-coding-plan/glm-5.3#max" },
    "plan-reviewer":     { model: "zai-coding-plan/glm-5.3#max" },
    "implementer":       { model: "zai-coding-plan/glm-5.3-flash#high" },
    "implementer-cheap": { model: "zai-coding-plan/glm-5.3-flash" },
    "implementer-deep":  { model: "zai-coding-plan/glm-5.3#max" },
    explore: { model: { providerID: "unsloth", model: "Unsloth-Qwen3.8-27B", variant: "nothink" } },
  },
}, null, 2));

const { default: plugin, configCandidates } = await import(pluginURL);
const { route, resolveImplementerTier, agentModel } = await import(logicURL);

// Excerpt of the superpowers SDD implementer prompt template. Real dispatches
// always carry this boilerplate (self-review section, references to "the
// plan"), which is exactly what must NOT drive routing.
const SDD_EXCERPT = [
  "You are implementing Task 5: auth module",
  "",
  "## Your Job",
  "1. Implement exactly what the task specifies",
  "2. Write tests",
  "3. Verify implementation works",
  "4. Commit your work",
  "5. Self-review (see below)",
  "",
  "- Follow the file structure defined in the plan",
  "",
  "## Before Reporting Back: Self-Review",
  "Review your work with fresh eyes.",
].join("\n");

// --- route(): classification off the description only ----------------------

const CASES = [
  // review routing (off description only)
  ["Review the auth code", undefined, "code-reviewer"],
  ["Review the implementation plan", undefined, "plan-reviewer"],
  ["Review the design doc", undefined, "plan-reviewer"],
  ["Spec review for the API", undefined, "plan-reviewer"],

  // implement, standard tier (default)
  ["Implement Task 5: auth module", undefined, "implementer"],
  ["Build the payment service", undefined, "implementer"],
  ["Create the config loader", undefined, "implementer"],
  ["Develop the export feature", undefined, "implementer"],
  ["Refactor the cache layer", undefined, "implementer"],

  // implement, cheap tier (tier words in the description)
  ["Implement a mechanical log fix", undefined, "implementer-cheap"],
  ["Write a single-file status badge", undefined, "implementer-cheap"],
  ["Implement transcription of fixture data", undefined, "implementer-cheap"],

  // implement, deep tier (tier words in the description)
  ["Build an architecture for notifications", undefined, "implementer-deep"],
  ["Refactor with design judgment in mind", undefined, "implementer-deep"],
  ["Develop a broad codebase migration helper", undefined, "implementer-deep"],

  // implement, tier from the SDD `model:` directive in the prompt
  ["Implement Task 2: log fix", "model: cheap\nDo the work.", "implementer-cheap"],
  ["Implement Task 3: rebuild arch", "model: deep\nDo the work.", "implementer-deep"],
  ["Implement Task 1: add greeting", "model: standard\nDo the work.", "implementer"],
  ["Implement Task 4: wire up auth", "model: implementer-cheap\nDo the work.", "implementer-cheap"],

  // SDD boilerplate in the prompt must not pollute routing (regression)
  ["Implement Task 5: auth module", SDD_EXCERPT, "implementer"],
  ["Implement Task 2: log fix", `model: cheap\n${SDD_EXCERPT}`, "implementer-cheap"],

  // no implement/review verb in the description -> stays general (undefined)
  ["Comprehensive analysis of the codebase", undefined, undefined],
  ["Plan the migration", undefined, undefined],
  ["Explore the repo structure", undefined, undefined],
  // cheap cue WITHOUT an implement verb does not route (conservative detection)
  ["Tiny tweak to the CSS button", undefined, undefined],
  ["", undefined, undefined],
  [undefined, "Implement X", undefined],
];

for (const [description, prompt, expected] of CASES) {
  test(`route(${JSON.stringify(description)}) -> ${expected}`, () => {
    assert.equal(route({ description, prompt }), expected);
  });
}

// --- resolveImplementerTier(): directive beats description ------------------

test("tier: agent-name directive wins over description tier words", () => {
  assert.equal(
    resolveImplementerTier({
      description: "Implement a mechanical fix",
      prompt: "model: implementer-deep\n...",
    }),
    "implementer-deep",
  );
});

test("tier: no directive, no tier words -> standard floor", () => {
  assert.equal(
    resolveImplementerTier({ description: "Implement Task 9: misc", prompt: "Do it." }),
    "implementer",
  );
});

// --- agentModel(): per-agent model from opencode.jsonc ----------------------

test("agentModel: reads legacy agent.<name>.model string (fallback)", () => {
  assert.equal(
    agentModel("code-reviewer", { agent: { "code-reviewer": { model: "p/m#v" } } }),
    "p/m#v",
  );
});

test("agentModel: reads native agents.<name>.model string", () => {
  assert.equal(
    agentModel("explore", { agents: { explore: { model: "p/m#nothink" } } }),
    "p/m#nothink",
  );
});

test("agentModel: expanded object form with and without variant", () => {
  assert.equal(
    agentModel("explore", {
      agents: { explore: { model: { providerID: "p", model: "m", variant: "nothink" } } },
    }),
    "p/m#nothink",
  );
  assert.equal(
    agentModel("explore", { agents: { explore: { model: { providerID: "p", model: "m" } } } }),
    "p/m",
  );
});

test("agentModel: native agents key wins over legacy agent key", () => {
  assert.equal(
    agentModel("explore", {
      agents: { explore: { model: "p/native#v" } },
      agent: { explore: { model: "p/legacy" } },
    }),
    "p/native#v",
  );
});

test("agentModel: undefined for missing agent, entry, or unusable model", () => {
  assert.equal(agentModel("code-reviewer", {}), undefined);
  assert.equal(agentModel("code-reviewer", { agents: {} }), undefined);
  assert.equal(agentModel("code-reviewer", { agents: { "code-reviewer": {} } }), undefined);
  assert.equal(agentModel("code-reviewer", { agents: { "code-reviewer": { model: 5 } } }), undefined);
  assert.equal(agentModel("code-reviewer", undefined), undefined);
  assert.equal(
    agentModel("explore", { agents: { explore: { model: { providerID: "p" } } } }),
    undefined,
  );
});

// --- configCandidates(): config search order --------------------------------
// Each test mutates env and restores it in finally; candidates are recomputed
// per call, so no reload or re-import is needed.

function withEnv(mutations, fn) {
  const saved = new Map(
    Object.entries(mutations).map(([k]) => [k, process.env[k]]),
  );
  for (const [k, v] of Object.entries(mutations)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("configCandidates: env override wins, then repo-relative, then global", () => {
  withEnv({ ROUTE_SUBAGENTS_CONFIG: "/tmp/override.jsonc", XDG_CONFIG_HOME: undefined }, () => {
    assert.deepEqual(configCandidates(), [
      "/tmp/override.jsonc",
      path.join(import.meta.dirname, "..", "opencode.jsonc"),
      path.join(os.homedir(), ".config", "opencode", "opencode.jsonc"),
    ]);
  });
});

test("configCandidates: without env or XDG, falls through to ~/.config", () => {
  withEnv({ ROUTE_SUBAGENTS_CONFIG: undefined, XDG_CONFIG_HOME: undefined }, () => {
    assert.deepEqual(configCandidates(), [
      path.join(import.meta.dirname, "..", "opencode.jsonc"),
      path.join(os.homedir(), ".config", "opencode", "opencode.jsonc"),
    ]);
  });
});

test("configCandidates: XDG_CONFIG_HOME redirects the global fallback", () => {
  withEnv({ ROUTE_SUBAGENTS_CONFIG: undefined, XDG_CONFIG_HOME: "/tmp/xdg" }, () => {
    const candidates = configCandidates();
    assert.equal(candidates.at(-1), path.join("/tmp/xdg", "opencode", "opencode.jsonc"));
  });
});

test("configCandidates: empty-string env override is ignored", () => {
  withEnv({ ROUTE_SUBAGENTS_CONFIG: "", XDG_CONFIG_HOME: undefined }, () => {
    assert.notEqual(configCandidates()[0], "");
  });
});

// --- plugin hook wiring (V2 event shape) ------------------------------------

async function makePluginHooks() {
  const hooks = {};
  const ctx = {
    tool: {
      hook: async (name, cb) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
    },
  };
  await plugin.setup(ctx);
  return hooks;
}

async function runHook(hooks, input) {
  const event = { tool: "subagent", input };
  await hooks["execute.before"](event);
  return input.agent;
}

test("setup registers the execute.before hook", async () => {
  const hooks = await makePluginHooks();
  assert.equal(Object.keys(hooks).join(","), "execute.before");
});

test("hook: ignores non-subagent tools", async () => {
  const hooks = await makePluginHooks();
  const input = { agent: "general", description: "Implement X" };
  await hooks["execute.before"]({ tool: "edit", input });
  assert.equal(input.agent, "general");
});

test("hook: ignores non-general agents for routing", async () => {
  const hooks = await makePluginHooks();
  const input = { agent: "explore", description: "Implement X" };
  await runHook(hooks, input);
  assert.equal(input.agent, "explore");
});

test("hook: routes general implement to implementer", async () => {
  const hooks = await makePluginHooks();
  assert.equal(
    await runHook(hooks, { agent: "general", description: "Implement Task 1: foo" }),
    "implementer",
  );
});

test("hook: routes general review to code-reviewer", async () => {
  const hooks = await makePluginHooks();
  assert.equal(
    await runHook(hooks, { agent: "general", description: "Review the diff" }),
    "code-reviewer",
  );
});

test("hook: pins configured model when routing to code-reviewer", async () => {
  const hooks = await makePluginHooks();
  const input = {
    agent: "general",
    description: "Review the diff",
    model: "zai-coding-plan/glm-5.3-flash",
  };
  await runHook(hooks, input);
  assert.equal(input.agent, "code-reviewer");
  assert.equal(input.model, "zai-coding-plan/glm-5.3#max");
});

test("hook: pins configured model when routing to implementer", async () => {
  const hooks = await makePluginHooks();
  const input = {
    agent: "general",
    description: "Implement Task 1: foo",
    model: "unsloth/Swift-1.5-Qwen3.8-27B",
  };
  await runHook(hooks, input);
  assert.equal(input.agent, "implementer");
  assert.equal(input.model, "zai-coding-plan/glm-5.3-flash#high");
});

test("hook: keeps explicit model when the dispatch stays general", async () => {
  const hooks = await makePluginHooks();
  const input = {
    agent: "general",
    description: "Explore the repo structure",
    model: "zai-coding-plan/glm-5.3-flash",
  };
  await runHook(hooks, input);
  assert.equal(input.agent, "general");
  assert.equal(input.model, "zai-coding-plan/glm-5.3-flash");
});

test("hook: empty description leaves as general", async () => {
  const hooks = await makePluginHooks();
  assert.equal(
    await runHook(hooks, { agent: "general", description: "" }),
    "general",
  );
});

test("hook: SDD implementer dispatch keeps implementer tier despite boilerplate", async () => {
  const hooks = await makePluginHooks();
  assert.equal(
    await runHook(hooks, {
      agent: "general",
      description: "Implement Task 2: log fix",
      prompt: `model: cheap\n${SDD_EXCERPT}`,
    }),
    "implementer-cheap",
  );
});

test("hook: pins configured model on direct code-reviewer dispatch", async () => {
  const hooks = await makePluginHooks();
  const input = { agent: "code-reviewer", description: "Review Task 1" };
  await runHook(hooks, input);
  assert.equal(input.agent, "code-reviewer");
  assert.equal(input.model, "zai-coding-plan/glm-5.3#max");
});

test("hook: direct implementer dispatch keeps agent, pins configured model", async () => {
  const hooks = await makePluginHooks();
  const input = { agent: "implementer", description: "Implement Task 2: maze" };
  await runHook(hooks, input);
  assert.equal(input.agent, "implementer");
  assert.equal(input.model, "zai-coding-plan/glm-5.3-flash#high");
});

test("hook: direct explore dispatch pins model composed from expanded object form", async () => {
  const hooks = await makePluginHooks();
  const input = { agent: "explore", description: "Find all call sites of loadConfig" };
  await runHook(hooks, input);
  assert.equal(input.agent, "explore");
  assert.equal(input.model, "unsloth/Unsloth-Qwen3.8-27B#nothink");
});

test("hook: direct dispatch overwrites caller-echoed parent model", async () => {
  const hooks = await makePluginHooks();
  const input = {
    agent: "code-reviewer",
    description: "Review the diff",
    model: "zai-coding-plan/glm-5.3-flash",
  };
  await runHook(hooks, input);
  assert.equal(input.model, "zai-coding-plan/glm-5.3#max");
});

test("hook: direct dispatch of agent without configured model is untouched", async () => {
  const hooks = await makePluginHooks();
  const input = { agent: "nosuchagent", description: "Do a thing", model: "p/m" };
  await runHook(hooks, input);
  assert.equal(input.agent, "nosuchagent");
  assert.equal(input.model, "p/m");
});

test("hook: tolerates missing input", async () => {
  const hooks = await makePluginHooks();
  await assert.doesNotReject(async () => {
    await hooks["execute.before"]({ tool: "subagent", input: undefined });
  });
});

test("setup: tolerates hosts without the V2 tool domain", async () => {
  await assert.doesNotReject(() => plugin.setup({}));
  await assert.doesNotReject(() => plugin.setup(undefined));
});
