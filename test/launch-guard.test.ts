import assert from "node:assert/strict";
import test from "node:test";
import { checkSubagentLaunch, inspectSubagentLaunch } from "../src/launch-guard.ts";
import { ADVISOR_AGENT_NAME } from "../src/advisor-executor.ts";
import { ANTHROPIC_ADVISOR_AGENT } from "../src/advisor-anthropic-provider.ts";
import { PROVIDER_EXTENSION_ADVISOR_AGENT } from "../src/advisor-provider-extension.ts";
import { resolveDelegateState } from "../src/config.ts";
import type { RuntimeState } from "../src/runtime.ts";
import {
  CURRENT_SCHEMA_VERSION,
  emptyRoleEntries,
  type GlobalDefaults,
  type RoleEntries,
} from "../src/types.ts";

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

function state(
  overrides: Partial<GlobalDefaults> = {},
  roleEntries: RoleEntries = emptyRoleEntries(),
): RuntimeState {
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
    effective: resolveDelegateState(global, session, roleEntries),
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

test("an Advisor child is refused when the call asks the host to branch the session", () => {
  // The Advisor answers from the brief the extension writes; a forked child would send the whole
  // conversation to its provider, so the promise that this never happens is enforced here.
  for (const agent of [
    ADVISOR_AGENT_NAME,
    ANTHROPIC_ADVISOR_AGENT,
    PROVIDER_EXTENSION_ADVISOR_AGENT,
  ]) {
    const input = { agent, task: "q", model: `advice/advisor-model:medium`, context: "fork" };
    const before = structuredClone(input);
    const refused = inspectSubagentLaunch(input, state());
    assert.equal(refused.refusal?.code, "advisor-fork-context", agent);
    assert.match(refused.refusal?.message ?? "", /fresh context with its brief/, agent);
    assert.deepEqual(input, before, agent);
    assert.deepEqual(refused.corrections, [], agent);
  }
  // A stated ordinary profile, or none at all, still becomes an Advisor through the model: the check
  // reads the resolved profile, not the one the call wrote.
  for (const input of [
    { agent: "worker", task: "t", model: "advisor", context: "fork" },
    { agent: "worker", task: "t", model: "advice/advisor-model:medium", context: "fork" },
    { task: "t", model: "advice/advisor-model:medium", context: "fork" },
  ]) {
    const before = structuredClone(input);
    const refused = inspectSubagentLaunch(input, state());
    assert.equal(refused.refusal?.code, "advisor-fork-context", JSON.stringify(input));
    assert.deepEqual(input, before, "the call is inspected, never rewritten");
  }
  // The host also reads `context` on the call's options for every workflow child, so that form is
  // refused as well; otherwise the documented parameter would bypass the check in one line of code.
  for (const input of [
    {
      agent: ADVISOR_AGENT_NAME,
      task: "q",
      model: "advice/advisor-model:medium",
      options: { context: "fork" },
    },
    {
      agent: "worker",
      task: "q",
      model: "advice/advisor-model:medium",
      options: { context: "fork" },
    },
    {
      workflow: "parallel",
      options: { context: "fork" },
      args: {
        tasks: [{ agent: ADVISOR_AGENT_NAME, task: "q", model: "advice/advisor-model:medium" }],
      },
    },
  ]) {
    const before = structuredClone(input);
    const refused = inspectSubagentLaunch(input, state());
    assert.equal(refused.refusal?.code, "advisor-fork-context", JSON.stringify(input));
    assert.deepEqual(input, before, "the call is inspected, never rewritten");
  }
  // A top-level `context` governs every child of a multi-child call, so the same value one level up
  // must be refused too: tasks, chain and a parallel workflow are the three shapes a call can take.
  for (const input of [
    {
      context: "fork",
      tasks: [{ agent: ADVISOR_AGENT_NAME, task: "q", model: "advice/advisor-model:medium" }],
    },
    {
      context: "fork",
      chain: [{ agent: ADVISOR_AGENT_NAME, task: "q", model: "advice/advisor-model:medium" }],
    },
    {
      context: "fork",
      workflow: "parallel",
      args: {
        tasks: [{ agent: ADVISOR_AGENT_NAME, task: "q", model: "advice/advisor-model:medium" }],
      },
    },
  ]) {
    const before = structuredClone(input);
    const refused = inspectSubagentLaunch(input, state());
    assert.equal(refused.refusal?.code, "advisor-fork-context", JSON.stringify(input));
    assert.deepEqual(input, before, "the call is inspected, never rewritten");
  }
  // An ordinary child keeps its own freedom: the refusal is specific to the Advisor.
  const ordinary = {
    agent: "worker",
    task: "t",
    model: "example/small-model:low",
    context: "fork",
  };
  assert.equal(inspectSubagentLaunch(ordinary, state()).refusal, undefined);
  // An Advisor that cannot run at all still reports its own cause instead of the context one.
  const off = state();
  off.effective.advisorMode = "off";
  const unavailable = {
    agent: ADVISOR_AGENT_NAME,
    task: "q",
    model: "advice/advisor-model:medium",
    context: "fork",
  };
  assert.equal(inspectSubagentLaunch(unavailable, off).refusal?.code, "advisor-off");
});

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
    // Unambiguous cases are corrected instead of refused, so they launch.
    { agent: "worker", task: "t", model: "example/small-model" },
    { agent: "reviewer", task: "t", model: "advice/advisor-model:low" },
    { agent: "worker", task: "t", model: "small" },
  ])
    assert.equal(checkSubagentLaunch(allowed, active), undefined, JSON.stringify(allowed));

  for (const [refused, why] of [
    [{ agent: "worker", task: "t" }, /no model was given/],
    [
      { agent: "worker", task: "t", model: "wrong/small-model:low" },
      /not the model of any enabled role/,
    ],
    [{ agent: "worker", task: "t", model: "other/large-model:low" }, /outside the role policy/],
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

test("a configured Advisor that failed validation is named with its reason, not left as unconfigured", () => {
  const second = { provider: "advice", model: "second-advisor" };
  const third = { provider: "other-advice", model: "third-advisor" };
  const available = (ref: typeof small) => ({
    kind: "available" as const,
    model: model(ref) as never,
  });
  const three = state({ advisors: [advisor, second, third] });
  three.advisorEntries = [
    { index: 0, setting: advisor, status: available(advisor), errors: [] },
    {
      index: 1,
      setting: second,
      status: available(second),
      errors: ["Advisor provider unavailable: requires the exact managed-user install."],
    },
    { index: 2, setting: third, status: available(third), errors: [] },
  ];
  const reason =
    checkSubagentLaunch(
      { agent: "pi-delegation-policy.advisor", task: "q", model: "advice/second-advisor:low" },
      three,
    ) ?? "";
  // The slot stays refused, and the refusal names it with the cause the runtime already recorded.
  assert.match(reason, /not a configured Advisor/);
  assert.match(reason, /Configured but unavailable:\n- Advisor 2: Advisor provider unavailable/);
  assert.match(reason, /- Advisor 1: agent/);
  assert.match(reason, /- Advisor 3: agent/);
  assert.doesNotMatch(reason, /No launch is allowed right now/);
  // Another Advisor's profile with this slot's model is corrected to the slot that owns the model.
  const corrected = {
    agent: "pi-delegation-policy.advisor-anthropic-auth",
    task: "q",
    model: "advice/advisor-model:low",
  };
  assert.equal(checkSubagentLaunch(corrected, three), undefined);
  assert.equal(corrected.agent, "pi-delegation-policy.advisor");

  // With no valid Advisor and delegation off, the refusal still reports the configured slot.
  const alone = state({ advisors: [second], intensity: "off" });
  alone.advisorEntries = [
    {
      index: 0,
      setting: second,
      status: available(second),
      errors: ["Advisor model is not registered in Pi."],
    },
  ];
  assert.match(
    checkSubagentLaunch(
      { agent: "pi-delegation-policy.advisor", task: "q", model: "advice/second-advisor:low" },
      alone,
    ) ?? "",
    /No launch is allowed right now\.\nConfigured but unavailable:\n- Advisor 1: Advisor model is not registered in Pi\./,
  );
});

test("a thinking level passes while any role sharing the model accepts it", () => {
  const shared = state({
    large: small,
    thinking: { small: { level: "high" }, large: { level: "low" } },
  });
  const smallStatus = shared.modelStatuses.get("small");
  assert.ok(smallStatus);
  shared.modelStatuses.set("large", smallStatus);
  // Small allows only `high` and Large only `low`, so each level passes through one of them.
  for (const level of ["high", "low"])
    assert.equal(
      checkSubagentLaunch(
        { agent: "worker", task: "t", model: `example/small-model:${level}` },
        shared,
      ),
      undefined,
      level,
    );
  // A level both roles reject is refused, and the message names every failing role.
  const refused =
    checkSubagentLaunch(
      { agent: "worker", task: "t", model: "example/small-model:medium" },
      shared,
    ) ?? "";
  assert.match(refused, /Small: thinking "medium" is outside the role policy/);
  assert.match(refused, /Large: thinking "medium" is outside the role policy/);
});

test("a spaced role label the block prints launches as the entry it names", () => {
  const first = { provider: "eyes", model: "vision-one" };
  const second = { provider: "eyes", model: "vision-two" };
  const current = state({}, { ...emptyRoleEntries(), vision: [first, second] });
  current.modelStatuses.set("vision2", { kind: "available", model: model(second) as never });

  // The block prints `Vision 2`, and the alias set is spelled in dashes: the label must still name
  // the entry instead of being refused as an unknown model.
  const call = { agent: "worker", task: "t", model: "Vision 2" };
  assert.equal(inspectSubagentLaunch(call, current).refusal, undefined);
  assert.match(call.model, /^eyes\/vision-two:(minimal|low|medium|high|off)$/);
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
  // A valid Advisor is still consulted while delegation is broken.
  assert.equal(
    checkSubagentLaunch(
      { agent: "pi-delegation-policy.advisor", task: "q", model: "advice/advisor-model:low" },
      broken,
    ),
    undefined,
  );
});

test("an unambiguous launch is corrected in place and the note names what was applied", () => {
  const active = state({
    thinking: { small: { min: "low", max: "high" }, large: { level: "high" } },
  });
  const single = { agent: "worker", task: "t", model: "small" };
  const check = inspectSubagentLaunch(single, active);
  assert.equal(check.refusal, undefined);
  // A role name becomes that role's exact model, with the lowest level inside its range policy.
  assert.equal(single.model, "example/small-model:low");
  assert.deepEqual(check.corrections, [
    { code: "role-alias", roleName: "small", applied: "example/small-model:low" },
  ]);
  assert.match(check.note ?? "", /corrected this subagent call before it ran/);
  assert.match(check.note ?? "", /model "small" → "example\/small-model:low"/);

  // A missing level takes the fixed policy, the range floor, or the model's clamped default.
  const fixed = { agent: "worker", task: "t", model: "other/large-model" };
  assert.equal(inspectSubagentLaunch(fixed, active).refusal, undefined);
  assert.equal(fixed.model, "other/large-model:high");
  const noPolicy = { agent: "worker", task: "t", model: "other/large-model" };
  assert.equal(inspectSubagentLaunch(noPolicy, state({ thinking: {} })).refusal, undefined);
  assert.equal(noPolicy.model, "other/large-model:medium");

  // An Advisor model gives the child that Advisor's profile, whatever profile it named.
  const profile = { agent: "reviewer", task: "t", model: "advice/advisor-model:low" };
  const profileCheck = inspectSubagentLaunch(profile, active);
  assert.equal(profileCheck.refusal, undefined);
  assert.equal(profile.agent, "pi-delegation-policy.advisor");
  assert.deepEqual(profileCheck.corrections, [
    { code: "advisor-profile", applied: "pi-delegation-policy.advisor" },
  ]);

  // The advisor role name sets both the exact model and its profile, and matching is case-insensitive.
  const advisorAlias = { agent: "worker", task: "t", model: "ADVISOR" };
  assert.equal(inspectSubagentLaunch(advisorAlias, active).refusal, undefined);
  assert.equal(advisorAlias.model, "advice/advisor-model:medium");
  assert.equal(advisorAlias.agent, "pi-delegation-policy.advisor");

  // A shared top-level model is corrected once for every child that inherits it.
  const parallel = {
    workflow: "parallel",
    model: "small",
    args: {
      tasks: [
        { agent: "a", task: "t" },
        { agent: "b", task: "t" },
      ],
    },
  };
  assert.equal(inspectSubagentLaunch(parallel, active).refusal, undefined);
  assert.equal(parallel.model, "example/small-model:low");
  // The children inherit the corrected shared model and are not rewritten themselves.
  assert.deepEqual(parallel.args.tasks, [
    { agent: "a", task: "t" },
    { agent: "b", task: "t" },
  ]);

  // Chain steps and parallel groups inside a chain are corrected where they are stated.
  const chain = {
    chain: [
      { agent: "a", task: "t", model: "small" },
      { parallel: [{ agent: "b", task: "t", model: "other/large-model" }] },
    ],
  };
  assert.equal(inspectSubagentLaunch(chain, active).refusal, undefined);
  assert.deepEqual(chain.chain, [
    { agent: "a", task: "t", model: "example/small-model:low" },
    { parallel: [{ agent: "b", task: "t", model: "other/large-model:high" }] },
  ]);
});

test("an ambiguous launch stays refused, and block mode refuses every corrected case unchanged", () => {
  const second = { provider: "advice", model: "advisor-model" };
  const shared = state({ advisors: [advisor, second] });
  const available = (ref: typeof small) => ({
    kind: "available" as const,
    model: model(ref) as never,
  });
  shared.advisorEntries = [
    { index: 0, setting: advisor, status: available(advisor), errors: [] },
    { index: 1, setting: second, status: available(second), errors: [] },
  ];
  // Two Advisors share the model, so the profile cannot be chosen: the call is refused, not guessed.
  assert.match(
    checkSubagentLaunch(
      { agent: "worker", task: "t", model: "advice/advisor-model:low" },
      shared,
    ) ?? "",
    /belongs to more than one configured Advisor/,
  );

  // Two roles share the model with different policies, so no level follows from the model alone.
  const roles = state({
    large: small,
    thinking: { small: { level: "high" }, large: { level: "low" } },
  });
  roles.modelStatuses.set("large", roles.modelStatuses.get("small")!);
  assert.match(
    checkSubagentLaunch({ agent: "worker", task: "t", model: "example/small-model" }, roles) ?? "",
    /the roles sharing this model choose different ones/,
  );

  // Block mode keeps the previous behaviour: the same cases are refused and nothing is written.
  const blocking = state();
  blocking.launchCorrection = "block";
  for (const [input, why] of [
    [{ agent: "worker", task: "t", model: "example/small-model" }, /no thinking level/],
    [{ agent: "worker", task: "t", model: "small" }, /not the model of any enabled role/],
    [
      { agent: "reviewer", task: "t", model: "advice/advisor-model:low" },
      /belongs only to an Advisor/,
    ],
  ] as const) {
    const before = structuredClone(input);
    const result = inspectSubagentLaunch(input, blocking);
    assert.match(result.refusal?.message ?? "", why, JSON.stringify(input));
    assert.deepEqual(input, before, JSON.stringify(input));
    assert.deepEqual(result.corrections, []);
    assert.equal(result.note, undefined);
  }
});

test("an Advisor role name selects the slot it names, never the next valid one", () => {
  const second = { provider: "advice", model: "second-advisor" };
  const third = { provider: "other-advice", model: "third-advisor" };
  const available = (ref: typeof small) => ({
    kind: "available" as const,
    model: model(ref) as never,
  });
  const slots = (valid: readonly boolean[]) => {
    const three = state({ advisors: [advisor, second, third] });
    const settings = [advisor, second, third];
    three.advisorEntries = settings.map((setting, index) => ({
      index,
      setting,
      status: available(setting),
      errors: valid[index] ? [] : ["Advisor provider unavailable."],
    }));
    return three;
  };

  // A gap in the middle must not shift the slot: advisor-2 is invalid and advisor-3 keeps its model.
  const middleGap = slots([true, false, true]);
  const requested = { agent: "worker", task: "q", model: "advisor-2" };
  const before = structuredClone(requested);
  const refused = inspectSubagentLaunch(requested, middleGap);
  assert.equal(refused.refusal?.code, "advisor-mismatch");
  assert.match(refused.refusal?.message ?? "", /"advisor-2" is not a configured Advisor/);
  assert.deepEqual(requested, before);
  assert.deepEqual(refused.corrections, []);
  const thirdSlot = { agent: "worker", task: "q", model: "advisor-3" };
  assert.equal(inspectSubagentLaunch(thirdSlot, middleGap).refusal, undefined);
  assert.equal(thirdSlot.model, "other-advice/third-advisor:medium");

  // A gap in the first slot must not let the bare name pick Advisor 2.
  const firstGap = slots([false, true, true]);
  const bare = { agent: "worker", task: "q", model: "advisor" };
  assert.match(
    inspectSubagentLaunch(bare, firstGap).refusal?.message ?? "",
    /"advisor" is not a configured Advisor/,
  );
  assert.equal(bare.model, "advisor");

  // A gap in the last slot refuses that name and leaves the input alone.
  const lastGap = slots([true, true, false]);
  const last = { agent: "worker", task: "q", model: "advisor-3" };
  assert.match(
    inspectSubagentLaunch(last, lastGap).refusal?.message ?? "",
    /"advisor-3" is not a configured Advisor/,
  );
  assert.equal(last.model, "advisor-3");
});

test("a role name binds its own thinking policy even when another role shares the model", () => {
  const shared = state({
    large: small,
    thinking: { small: { level: "high" }, large: { level: "low" } },
  });
  shared.modelStatuses.set("large", shared.modelStatuses.get("small")!);

  // The named role's policy is binding, so another role accepting the level cannot admit it.
  const named = { agent: "worker", task: "t", model: "small:low" };
  const before = structuredClone(named);
  const refused = inspectSubagentLaunch(named, shared);
  assert.equal(refused.refusal?.code, "thinking-outside-policy");
  assert.match(refused.refusal?.message ?? "", /Small: thinking "low" is outside the role policy/);
  assert.deepEqual(named, before);
  assert.deepEqual(refused.corrections, []);
  assert.equal(
    inspectSubagentLaunch({ agent: "worker", task: "t", model: "small:high" }, shared).refusal,
    undefined,
  );

  // An exact reference names no role, so any role sharing the model still accepts the level.
  assert.equal(
    checkSubagentLaunch({ agent: "worker", task: "t", model: "example/small-model:low" }, shared),
    undefined,
  );
});

test("an ordinary role name never runs as an Advisor consultation", () => {
  const visual = { provider: "visual", model: "visual-model" };
  const anthropicAdvisor = {
    provider: "anthropic",
    model: "visual-model",
    providerExtension: "anthropic-auth" as const,
  };
  const admittedAdvisor = { provider: "admitted", model: "visual-model" };
  const available = (ref: { provider: string; model: string }) => ({
    kind: "available" as const,
    model: model(ref) as never,
  });
  const collision = (setting: typeof anthropicAdvisor | typeof admittedAdvisor) => {
    const shared = state({ uiDesign: visual, advisors: [setting] });
    shared.admissions = { admitted: { package: "admitted-extension", version: "1.0.0" } };
    shared.modelStatuses.set("uiDesign", available(visual));
    shared.advisorEntries = [{ index: 0, setting, status: available(setting), errors: [] }];
    return shared;
  };

  // Visual Design and an Advisor share the model: the named role still runs ordinary work.
  for (const [setting, profile] of [
    [anthropicAdvisor, ANTHROPIC_ADVISOR_AGENT],
    [admittedAdvisor, PROVIDER_EXTENSION_ADVISOR_AGENT],
    [anthropicAdvisor, ADVISOR_AGENT_NAME],
  ] as const) {
    const input = { agent: profile, task: "t", model: "visual-design:low" };
    const before = structuredClone(input);
    const refused = inspectSubagentLaunch(input, collision(setting));
    assert.equal(refused.refusal?.code, "advisor-mismatch", profile);
    assert.match(
      refused.refusal?.message ?? "",
      /Visual Design runs with an ordinary agent profile/,
    );
    assert.deepEqual(input, before, profile);
    assert.deepEqual(refused.corrections, [], profile);
  }

  // The same role name with an ordinary profile is corrected and allowed.
  const ordinary = { agent: "worker", task: "t", model: "visual-design:low" };
  assert.equal(inspectSubagentLaunch(ordinary, collision(anthropicAdvisor)).refusal, undefined);
  assert.equal(ordinary.model, "visual/visual-model:low");
});
