import assert from "node:assert/strict";
import test from "node:test";
import { checkSubagentLaunch } from "../src/launch-guard.ts";
import { resolveDelegateState } from "../src/config.ts";
import type { RuntimeState } from "../src/runtime.ts";
import { CURRENT_SCHEMA_VERSION, type GlobalDefaults } from "../src/types.ts";

const small = { provider: "example", model: "small-model" };
const large = { provider: "other", model: "large-model" };
const advisor = { provider: "advice", model: "advisor-model" };
const thinking = ["off", "minimal", "low", "medium", "high"];
const model = (ref: { provider: string; model: string }) => ({
  provider: ref.provider,
  id: ref.model,
  api: "openai-completions",
  reasoning: true,
  thinkingLevels: thinking,
});

function state(overrides: Partial<GlobalDefaults> = {}): RuntimeState {
  const global: GlobalDefaults = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    intensity: "aggressive",
    small,
    medium: null,
    large,
    advisors: [advisor],
    advisorMode: "on",
    advisorLaunch: "role",
    thinking: { large: { level: "high" } },
    ...overrides,
  };
  const session = { schemaVersion: CURRENT_SCHEMA_VERSION };
  const available = (ref: typeof small) => ({
    kind: "available" as const,
    model: model(ref) as never,
  });
  return {
    global,
    session,
    effective: resolveDelegateState(global, session),
    diagnostics: [],
    modelStatuses: new Map([
      ["small", available(small)],
      ["large", available(large)],
    ]),
    runtimeErrors: [],
    advisorErrors: [],
    advisorEntries: [{ index: 0, setting: advisor, status: available(advisor), errors: [] }],
  };
}

test("valid launches pass and every policy violation is refused before launching", () => {
  const active = state();
  for (const allowed of [
    { agent: "worker", task: "t", model: "example/small-model:low" },
    { agent: "worker", task: "t", model: "other/large-model:high" },
    { agent: "pi-delegation-policy.advisor", task: "q", model: "advice/advisor-model:medium" },
    {
      workflow: "parallel",
      args: { tasks: [{ agent: "a", task: "t", model: "example/small-model:high" }] },
    },
    { action: "status", id: "run" },
    { action: "resume", id: "run", message: "go on" },
    // Management targets and static checks are not launches.
    { action: "get", agent: "scout" },
    { action: "children.list", id: "run" },
    { action: "validate", workflow: true },
    // A top-level model applies to every child that states none.
    {
      workflow: "parallel",
      model: "example/small-model:low",
      args: { tasks: [{ agent: "a", task: "t" }] },
    },
    {
      chain: [
        { agent: "a", task: "t", model: "example/small-model:low" },
        { parallel: [{ agent: "b", task: "t", model: "other/large-model:high" }] },
      ],
    },
  ])
    assert.equal(checkSubagentLaunch(allowed, active), undefined, JSON.stringify(allowed));

  for (const [refused, why] of [
    [{ agent: "worker", task: "t" }, /no model was given/],
    [
      { agent: "worker", task: "t", model: "wrong/small-model:low" },
      /not the model of any enabled role/,
    ],
    [{ agent: "worker", task: "t", model: "example/small-model" }, /no thinking level/],
    [{ agent: "worker", task: "t", model: "other/large-model:low" }, /outside the role policy/],
    [
      { agent: "reviewer", task: "t", model: "advice/advisor-model:low" },
      /belongs only to an Advisor/,
    ],
    [
      { agent: "pi-delegation-policy.advisor", task: "q", model: "example/small-model:low" },
      /not a configured Advisor/,
    ],
    [{ workflow: true }, /workflow scripts hide/],
    [{ workflow: "./lane.js" }, /workflow scripts hide/],
    [
      {
        workflow: "parallel",
        args: {
          tasks: [
            { agent: "a", task: "t", model: "example/small-model:low" },
            { agent: "b", task: "t" },
          ],
        },
      },
      /child 2: no model/,
    ],
    [{ action: "status", tasks: [{ agent: "a", task: "t" }] }, /control action cannot also carry/],
    [
      { agent: "a", task: "t", model: "example/small-model:low", options: { script: "return 1;" } },
      /workflow scripts hide/,
    ],
    [
      {
        chain: [
          { agent: "a", task: "t", model: "example/small-model:low" },
          { parallel: [{ agent: "b", task: "t" }] },
        ],
      },
      /child 2: no model/,
    ],
  ] as const) {
    const reason = checkSubagentLaunch(refused, active) ?? "";
    assert.match(reason, why, JSON.stringify(refused));
    // The refusal names the exact launches that would be accepted.
    assert.match(reason, /"example\/small-model:LEVEL"/);
    assert.match(reason, /"other\/large-model:high"/);
  }
});

test("delegation off checks only Advisor launches, and both axes off check nothing", () => {
  const advisorOnly = state({ intensity: "off" });
  assert.equal(checkSubagentLaunch({ agent: "worker", task: "t" }, advisorOnly), undefined);
  assert.equal(checkSubagentLaunch({ workflow: true }, advisorOnly), undefined);
  assert.match(
    checkSubagentLaunch({ agent: "pi-delegation-policy.advisor", task: "q" }, advisorOnly) ?? "",
    /no model was given/,
  );
  assert.equal(checkSubagentLaunch({ action: "get", agent: "scout" }, advisorOnly), undefined);
  // With delegation on and the Advisor role off, an Advisor profile names the real cause.
  assert.match(
    checkSubagentLaunch(
      { agent: "pi-delegation-policy.advisor", task: "q", model: "advice/advisor-model:low" },
      state({ advisorMode: "off" }),
    ) ?? "",
    /Advisor role is off/,
  );
  const off = state({ intensity: "off", advisorMode: "off" });
  assert.equal(
    checkSubagentLaunch({ agent: "pi-delegation-policy.advisor", task: "q" }, off),
    undefined,
  );

  const broken = state();
  broken.runtimeErrors.push("Small model is unavailable.");
  assert.match(
    checkSubagentLaunch({ agent: "worker", task: "t", model: "example/small-model:low" }, broken) ??
      "",
    /configuration is invalid/,
  );
});
