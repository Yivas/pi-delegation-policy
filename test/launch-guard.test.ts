import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { checkSubagentLaunch, inspectSubagentLaunch } from "../src/launch-guard.ts";
import { ADVISOR_AGENT_NAME, ADVISOR_READ_AGENT_NAME } from "../src/advisor-executor.ts";
import { ANTHROPIC_ADVISOR_AGENT } from "../src/advisor-anthropic-provider.ts";
import {
  KNOWN_TOOL_SURFACE,
  PROVIDER_EXTENSION_ADVISOR_AGENT,
} from "../src/advisor-provider-extension.ts";
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

test("a reading Advisor launches under its own profile and is refused with another model", () => {
  const reading = (overrides: Partial<RuntimeState> = {}): RuntimeState => {
    const current = state();
    current.advisorRead = [true];
    return { ...current, ...overrides };
  };
  // Both correction modes accept the exact profile with its exact model, and leave the call alone.
  for (const launchCorrection of ["correct", "block"] as const) {
    const active = reading({ launchCorrection });
    const accepted = {
      agent: ADVISOR_READ_AGENT_NAME,
      task: "q",
      model: "advice/advisor-model:medium",
    };
    const before = structuredClone(accepted);
    const check = inspectSubagentLaunch(accepted, active);
    assert.equal(check.refusal, undefined, launchCorrection);
    assert.deepEqual(
      accepted,
      before,
      `a conformant reading launch stays as sent in ${launchCorrection}`,
    );
    assert.deepEqual(check.children, ["advisor"], launchCorrection);

    // The reading profile is an Advisor profile, so it never executes work as an ordinary model.
    const wrongModel = {
      agent: ADVISOR_READ_AGENT_NAME,
      task: "q",
      model: "example/small-model:low",
    };
    const refused = inspectSubagentLaunch(wrongModel, active);
    assert.equal(refused.refusal?.code, "advisor-mismatch", launchCorrection);
    assert.match(refused.refusal?.message ?? "", /is not a configured Advisor/, launchCorrection);
  }
  // Advisor-only mode checks an Advisor child too: a reading launch with no model is refused
  // instead of passing as an unknown child that names no ordinary role.
  const advisorOnly = reading();
  advisorOnly.effective.intensity = "off";
  assert.equal(
    inspectSubagentLaunch({ agent: ADVISOR_READ_AGENT_NAME, task: "q" }, advisorOnly).refusal?.code,
    "missing-model",
  );
});

// The reviewed provider, its two packaged profiles and a user agent of the operator's, which this
// policy must never replace or refuse. The launch check reads the installed package itself, so the
// fixture is a real managed install in a temp agent directory, never a stub.
const REVIEWED_PROVIDER = KNOWN_TOOL_SURFACE[0].provider;
const EXECUTION_AGENT = KNOWN_TOOL_SURFACE[0].executionAgent;
const READER_AGENT = KNOWN_TOOL_SURFACE[0].readerAgent;
const REVIEWED_PACKAGE_NAME = KNOWN_TOOL_SURFACE[0].package;
const USER_AGENT = "writer";
const extensionModel = { provider: REVIEWED_PROVIDER, model: "reviewed-model" };

async function writeSiblingPackage(directory: string): Promise<string> {
  const managed = join(directory, "npm", "node_modules", REVIEWED_PACKAGE_NAME);
  await mkdir(managed, { recursive: true });
  await writeFile(
    join(managed, "package.json"),
    JSON.stringify({
      name: REVIEWED_PACKAGE_NAME,
      version: "9.9.9",
      pi: { extensions: ["./index.js"] },
    }),
  );
  await writeFile(join(managed, "index.js"), "export default function () {}\n");
  await writeFile(
    join(directory, "settings.json"),
    JSON.stringify({ packages: [`npm:${REVIEWED_PACKAGE_NAME}@1.0.0`] }),
  );
  return managed;
}

const AGENT_DIR_BEFORE = process.env.PI_CODING_AGENT_DIR;
const PROVIDER_AGENT_DIR = await mkdtemp(join(tmpdir(), "launch-guard-provider-"));
process.env.PI_CODING_AGENT_DIR = PROVIDER_AGENT_DIR;
const PROVIDER_MANAGED = await writeSiblingPackage(PROVIDER_AGENT_DIR);
const PROVIDER_PLUGIN_ROOT = join(
  PROVIDER_AGENT_DIR,
  "npm",
  "node_modules",
  "pi-delegation-policy",
);
after(async () => {
  if (AGENT_DIR_BEFORE === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = AGENT_DIR_BEFORE;
  await rm(PROVIDER_AGENT_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function providerState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  const current = state({ small: extensionModel });
  current.modelStatuses.set("small", { kind: "available", model: model(extensionModel) as never });
  current.extensionProviders = [REVIEWED_PROVIDER];
  current.cwd = process.cwd();
  current.packageRoot = PROVIDER_PLUGIN_ROOT;
  return { ...current, ...overrides };
}

const extensionCall = () => ({
  agent: "worker",
  task: "t",
  model: `${REVIEWED_PROVIDER}/reviewed-model:high`,
});

test("a model a provider extension serves runs the packaged execution profile", () => {
  const active = providerState();
  // A builtin agent cannot load the provider, so the guard chooses the profile that does and says so.
  const worker = extensionCall();
  const check = inspectSubagentLaunch(worker, active);
  assert.equal(check.refusal, undefined);
  assert.equal(worker.agent, EXECUTION_AGENT);
  assert.deepEqual(check.corrections, [{ code: "provider-profile", applied: EXECUTION_AGENT }]);
  assert.match(check.note ?? "", /agent → "pi-delegation-policy\.execution-antigravity-acp"/);
  assert.match(check.note ?? "", /the model's provider is loaded by that packaged profile/);

  // A call that names no agent gets the profile too: nobody else chose one.
  const absent = { task: "t", model: `${REVIEWED_PROVIDER}/reviewed-model:high` };
  assert.equal(inspectSubagentLaunch(absent, providerState()).refusal, undefined);
  assert.equal((absent as { agent?: string }).agent, EXECUTION_AGENT);

  // Naming the profile already is the idempotent case: nothing is written and nothing is noted.
  const correct = {
    agent: EXECUTION_AGENT,
    task: "t",
    model: `${REVIEWED_PROVIDER}/reviewed-model:high`,
  };
  const before = structuredClone(correct);
  const idempotent = inspectSubagentLaunch(correct, active);
  assert.equal(idempotent.refusal, undefined);
  assert.deepEqual(idempotent.corrections, []);
  assert.equal(idempotent.note, undefined);
  assert.deepEqual(correct, before);

  // Every launch shape writes the profile where the host reads it: a single child, tasks, a chain
  // step, a group inside a chain, and a parallel workflow whose model is the call's own.
  for (const [call, agents] of [
    [
      {
        tasks: [{ agent: "worker", task: "t", model: `${REVIEWED_PROVIDER}/reviewed-model:high` }],
      },
      (input: Record<string, unknown>) => (input.tasks as Array<{ agent: string }>)[0]!.agent,
    ],
    [
      {
        chain: [{ agent: "worker", task: "t", model: `${REVIEWED_PROVIDER}/reviewed-model:high` }],
      },
      (input: Record<string, unknown>) => (input.chain as Array<{ agent: string }>)[0]!.agent,
    ],
    [
      {
        chain: [
          {
            parallel: [
              { agent: "worker", task: "t", model: `${REVIEWED_PROVIDER}/reviewed-model:high` },
            ],
          },
        ],
      },
      (input: Record<string, unknown>) =>
        (input.chain as Array<{ parallel: Array<{ agent: string }> }>)[0]!.parallel[0]!.agent,
    ],
    [
      {
        workflow: "parallel",
        model: `${REVIEWED_PROVIDER}/reviewed-model:high`,
        args: { tasks: [{ agent: "worker", task: "t" }] },
      },
      (input: Record<string, unknown>) =>
        (input.args as { tasks: Array<{ agent: string }> }).tasks[0]!.agent,
    ],
  ] as const) {
    const input = structuredClone(call) as Record<string, unknown>;
    const shapeCheck = inspectSubagentLaunch(input, providerState());
    assert.equal(shapeCheck.refusal, undefined, JSON.stringify(call));
    assert.equal(agents(input), EXECUTION_AGENT, JSON.stringify(call));
    assert.deepEqual(
      shapeCheck.corrections.map((correction) => correction.code),
      ["provider-profile"],
      JSON.stringify(call),
    );
  }
});

// One table, one decision per builtin. A builtin keeps the tool surface its own definition declares,
// so nothing read-only is widened into bash, edit and write, and nothing loses a tool it declared.
// `advisor` is not here: it is a consultation and keeps its own profile before this table is read.
test("every builtin that can execute fits a packaged profile or is refused, never widened", () => {
  const mapping: Record<string, string | "refused"> = {
    worker: EXECUTION_AGENT,
    delegate: EXECUTION_AGENT,
    reviewer: READER_AGENT,
    scout: "refused",
    oracle: "refused",
    "evidence-auditor": "refused",
    researcher: "refused",
    "claude-code": "refused",
    "claude-code-writer": "refused",
    "codex-exec": "refused",
    "codex-exec-writer": "refused",
    "cursor-agent": "refused",
    "cursor-agent-writer": "refused",
  };
  const reasons: Record<string, RegExp> = {
    scout: /declares bash and write/,
    oracle: /declares bash and a forked default context/,
    "evidence-auditor": /declares the web tools/,
    researcher: /declares write and the web tools/,
    "claude-code": /runs an external CLI runner/,
  };
  for (const [agent, target] of Object.entries(mapping)) {
    const input = { agent, task: "t", model: `${REVIEWED_PROVIDER}/reviewed-model:high` };
    const before = structuredClone(input);
    const check = inspectSubagentLaunch(input, providerState());
    if (target === "refused") {
      assert.equal(check.refusal?.code, "provider-profile", agent);
      assert.deepEqual(input, before, `${agent} is refused without being rewritten`);
      assert.deepEqual(check.corrections, [], agent);
      assert.match(check.refusal?.message ?? "", /cannot run/, agent);
      assert.match(check.refusal?.message ?? "", reasons[agent] ?? /external CLI runner/, agent);
      continue;
    }
    assert.equal(check.refusal, undefined, agent);
    assert.equal(input.agent, target, agent);
    assert.deepEqual(check.corrections, [{ code: "provider-profile", applied: target }], agent);
  }
  // The reader profile keeps a read-only worker: no writing profile is ever applied to it.
  const reviewer = {
    agent: "reviewer",
    task: "t",
    model: `${REVIEWED_PROVIDER}/reviewed-model:high`,
  };
  const reviewCheck = inspectSubagentLaunch(reviewer, providerState());
  assert.equal(reviewer.agent, READER_AGENT);
  assert.notEqual(READER_AGENT, EXECUTION_AGENT);
  assert.match(reviewCheck.note ?? "", new RegExp(`agent → "${READER_AGENT}"`));
  // Naming that profile already is the idempotent case.
  const conformant = {
    agent: READER_AGENT,
    task: "t",
    model: `${REVIEWED_PROVIDER}/reviewed-model:high`,
  };
  const conformantCheck = inspectSubagentLaunch(conformant, providerState());
  assert.equal(conformantCheck.refusal, undefined);
  assert.deepEqual(conformantCheck.corrections, []);
});

// `subagentOnlyExtensions` is static frontmatter, so a packaged profile loads its package whatever
// the model is. Naming one with another provider would load it unchecked and for nothing.
test("a packaged profile named with another provider is refused, and its own provider is checked", () => {
  for (const agent of [EXECUTION_AGENT, READER_AGENT]) {
    const input = { agent, task: "t", model: "other/large-model:high" };
    const before = structuredClone(input);
    const refused = inspectSubagentLaunch(input, providerState());
    assert.equal(refused.refusal?.code, "provider-profile", agent);
    assert.match(
      refused.refusal?.message ?? "",
      new RegExp(`loads ${REVIEWED_PACKAGE_NAME}`),
      agent,
    );
    assert.match(refused.refusal?.message ?? "", /is not from that provider/, agent);
    assert.deepEqual(input, before, agent);

    const accepted = { agent, task: "t", model: `${REVIEWED_PROVIDER}/reviewed-model:high` };
    const check = inspectSubagentLaunch(accepted, providerState());
    assert.equal(check.refusal, undefined, agent);
    assert.deepEqual(check.corrections, [], agent);
    assert.equal(accepted.agent, agent, agent);
  }
});

// The Advisor profile that serves an admitted provider loads the same sibling, so its install is
// checked at launch too: a consultation that cannot be served is refused as an Advisor error here
// instead of failing inside the child after the brief has already been sent.
test("the Advisor profile that loads the sibling is checked at launch like any other", async () => {
  const adviceModel = { provider: REVIEWED_PROVIDER, model: "advice-from-extension" };
  const adviceState = (intensity: "aggressive" | "off") => {
    const current = providerState();
    current.effective.intensity = intensity;
    current.admissions = {
      [REVIEWED_PROVIDER]: { package: REVIEWED_PACKAGE_NAME, version: "1.0.0" },
    };
    current.advisorEntries = [
      {
        index: 0,
        setting: adviceModel,
        status: { kind: "available", model: model(adviceModel) as never },
        errors: [],
      },
    ];
    return current;
  };
  const call = {
    agent: PROVIDER_EXTENSION_ADVISOR_AGENT,
    task: "q",
    model: `${REVIEWED_PROVIDER}/advice-from-extension:high`,
  };
  // Both axes are exercised: with delegation off the Advisor is the only launch left, and it is the
  // case where refusing for an uncomputed pair made a healthy consultation impossible.
  for (const intensity of ["aggressive", "off"] as const) {
    assert.equal(
      inspectSubagentLaunch(structuredClone(call), adviceState(intensity)).refusal,
      undefined,
      `healthy Advisor with delegation ${intensity}`,
    );
  }

  await rm(PROVIDER_MANAGED, { recursive: true, force: true });
  try {
    for (const intensity of ["aggressive", "off"] as const) {
      const input = structuredClone(call);
      const refused = inspectSubagentLaunch(input, adviceState(intensity));
      assert.equal(refused.refusal?.code, "provider-profile", intensity);
      assert.match(
        refused.refusal?.message ?? "",
        new RegExp(`the Advisor profile "${PROVIDER_EXTENSION_ADVISOR_AGENT}"`),
        intensity,
      );
      assert.match(refused.refusal?.message ?? "", /cannot be confirmed/, intensity);
      assert.doesNotMatch(
        refused.refusal?.message ?? "",
        /was not resolved in this session/,
        `a refused Advisor names the package cause, not a missing check (${intensity})`,
      );
      assert.deepEqual(input, call, "the Advisor call is never rewritten");
      assert.deepEqual(refused.corrections, [], intensity);
    }
  } finally {
    await writeSiblingPackage(PROVIDER_AGENT_DIR);
  }
});

// The host resolves aliases to a builtin itself, but a user agent may declare the same alias and this
// policy cannot see which one the host would pick: an alias is refused with the canonical name.
test("a builtin alias is refused with the canonical name to state", () => {
  for (const [alias, canonical] of [
    ["developer", "worker"],
    ["coder", "worker"],
    ["implementer", "worker"],
    ["develop", "worker"],
    ["advisor", "oracle"],
  ] as const) {
    const input = { agent: alias, task: "t", model: `${REVIEWED_PROVIDER}/reviewed-model:high` };
    const before = structuredClone(input);
    const refused = inspectSubagentLaunch(input, providerState());
    assert.equal(refused.refusal?.code, "provider-profile", alias);
    assert.match(refused.refusal?.message ?? "", /is an alias the host resolves to/, alias);
    assert.ok(refused.refusal?.message.includes(`state agent "${canonical}"`), alias);
    assert.deepEqual(input, before, alias);
  }
  // A native provider needs no profile, so the alias is left exactly as sent.
  const native = { agent: "developer", task: "t", model: "other/large-model:high" };
  const nativeCheck = inspectSubagentLaunch(native, providerState());
  assert.equal(nativeCheck.refusal, undefined);
  assert.deepEqual(nativeCheck.corrections, []);
  assert.equal(native.agent, "developer");
});

// A read-only builtin that cannot fit either profile is told to stay read-only on a provider the
// child loads before it is told how to become a writing child.
test("a read-only builtin is offered the read-only way out first", () => {
  for (const agent of ["oracle", "evidence-auditor"]) {
    const refused = inspectSubagentLaunch(
      { agent, task: "t", model: `${REVIEWED_PROVIDER}/reviewed-model:high` },
      providerState(),
    );
    const message = refused.refusal?.message ?? "";
    assert.match(
      message,
      /Keep that work on a model the child loads, which stays read-only/,
      agent,
    );
    assert.ok(
      message.indexOf("stays read-only") < message.indexOf(EXECUTION_AGENT),
      `${agent} names the read-only way out before the writing profile`,
    );
  }
});

test("an agent of your own is never replaced and never refused for its provider", () => {
  // The operator's agent declares its own extensions, so what it loads is its own decision: a
  // provider this release has no profile for is that agent's business, not this policy's.
  const unlisted = { provider: "unlisted-provider", model: "own-model" };
  const active = state({ small: unlisted });
  active.modelStatuses.set("small", { kind: "available", model: model(unlisted) as never });
  active.extensionProviders = ["unlisted-provider"];
  for (const agent of [USER_AGENT, "code-explorer"]) {
    const input = { agent, task: "t", model: "unlisted-provider/own-model:high" };
    const before = structuredClone(input);
    const check = inspectSubagentLaunch(input, active);
    assert.equal(check.refusal, undefined, agent);
    assert.deepEqual(check.corrections, [], agent);
    assert.deepEqual(input, before, agent);
  }
  // The same model through a builtin agent is refused, naming the provider and the hole.
  const builtin = { agent: "worker", task: "t", model: "unlisted-provider/own-model:high" };
  const refused = inspectSubagentLaunch(builtin, active);
  assert.equal(refused.refusal?.code, "provider-profile");
  assert.match(
    refused.refusal?.message ?? "",
    /provider "unlisted-provider" is supplied by an extension/,
  );
  assert.match(refused.refusal?.message ?? "", /ships no packaged profile for it/);
  assert.match(
    refused.refusal?.message ?? "",
    /an agent of your own that loads "unlisted-provider"/,
  );
  assert.deepEqual(builtin, {
    agent: "worker",
    task: "t",
    model: "unlisted-provider/own-model:high",
  });
});

test("the sibling check runs at launch, so a package gone after validation is refused", async () => {
  // Validation resolved this package once. Removing it afterwards is exactly the window between
  // that answer and the child's own load, and the launch check has to close it.
  assert.equal(inspectSubagentLaunch(extensionCall(), providerState()).refusal, undefined);
  await rm(PROVIDER_MANAGED, { recursive: true, force: true });
  try {
    const input = extensionCall();
    const before = structuredClone(input);
    const refused = inspectSubagentLaunch(input, providerState());
    assert.equal(refused.refusal?.code, "provider-profile");
    assert.match(refused.refusal?.message ?? "", /cannot be confirmed as installed in/);
    assert.match(refused.refusal?.message ?? "", /install it as a user package/);
    assert.deepEqual(input, before, "a refused call is never rewritten");
    assert.deepEqual(refused.corrections, []);
  } finally {
    await writeSiblingPackage(PROVIDER_AGENT_DIR);
  }

  // A profile whose sibling cannot be located at all, because the parent never recorded the pair,
  // fails closed instead of passing.
  const unresolved = inspectSubagentLaunch(
    extensionCall(),
    providerState({ cwd: undefined, packageRoot: undefined }),
  );
  assert.equal(unresolved.refusal?.code, "provider-profile");
  assert.match(unresolved.refusal?.message ?? "", /was not resolved in this session/);
  assert.match(unresolved.refusal?.message ?? "", /reload the session/);
});

test("block mode refuses the profile it would otherwise apply, and an Advisor keeps its own", () => {
  const blocking = providerState();
  blocking.launchCorrection = "block";
  const input = extensionCall();
  const before = structuredClone(input);
  const refused = inspectSubagentLaunch(input, blocking);
  assert.equal(refused.refusal?.code, "provider-profile");
  assert.ok(refused.refusal?.message.includes(EXECUTION_AGENT));
  assert.match(
    refused.refusal?.message ?? "",
    /the packaged profile that loads the provider serving/,
  );
  assert.deepEqual(input, before);
  assert.deepEqual(refused.corrections, []);
  assert.equal(refused.note, undefined);
  // The exact profile is not a correction in block mode either: it is already what would run.
  const conformant = inspectionOfBlockingProfile(blocking);
  assert.equal(conformant.refusal, undefined);

  // An Advisor child never becomes an execution child, whatever its provider.
  const advisorModel = { provider: REVIEWED_PROVIDER, model: "advice-from-extension" };
  const active = providerState();
  active.advisorEntries = [
    {
      index: 0,
      setting: advisorModel,
      status: { kind: "available", model: model(advisorModel) as never },
      errors: [],
    },
  ];
  const advisorCall = {
    agent: ADVISOR_AGENT_NAME,
    task: "q",
    model: `${REVIEWED_PROVIDER}/advice-from-extension:high`,
  };
  const advisorCheck = inspectSubagentLaunch(advisorCall, active);
  assert.equal(advisorCheck.refusal, undefined);
  assert.equal(advisorCall.agent, ADVISOR_AGENT_NAME);
  assert.deepEqual(advisorCheck.corrections, []);
});

function inspectionOfBlockingProfile(blocking: RuntimeState) {
  return inspectSubagentLaunch(
    { agent: EXECUTION_AGENT, task: "t", model: `${REVIEWED_PROVIDER}/reviewed-model:high` },
    blocking,
  );
}

test("a model of no role, or a launch delegation does not check, keeps its own refusal", () => {
  // The provider check runs after the model and role checks, so an unknown model still says so.
  const unknown = inspectSubagentLaunch(
    { agent: "worker", task: "t", model: `${REVIEWED_PROVIDER}/not-a-role-model:high` },
    providerState(),
  );
  assert.equal(unknown.refusal?.code, "wrong-model");
  assert.match(unknown.refusal?.message ?? "", /not the model of any enabled role/);

  // With delegation off, an ordinary child is not this policy's to correct; the Advisor stays one.
  const advisorOnly = providerState();
  advisorOnly.effective.intensity = "off";
  const untouched = extensionCall();
  const before = structuredClone(untouched);
  assert.equal(inspectSubagentLaunch(untouched, advisorOnly).refusal, undefined);
  assert.deepEqual(untouched, before);
});

test("a reading Advisor is refused when the call asks the host to branch the session", () => {
  const active = state();
  active.advisorRead = [true];
  for (const input of [
    {
      agent: ADVISOR_READ_AGENT_NAME,
      task: "q",
      model: "advice/advisor-model:medium",
      context: "fork",
    },
    {
      agent: ADVISOR_READ_AGENT_NAME,
      task: "q",
      model: "advice/advisor-model:medium",
      options: { context: "fork" },
    },
  ]) {
    const before = structuredClone(input);
    const refused = inspectSubagentLaunch(input, active);
    assert.equal(refused.refusal?.code, "advisor-fork-context", JSON.stringify(input));
    assert.match(refused.refusal?.message ?? "", /fresh context with its brief/);
    assert.deepEqual(input, before, "the call is inspected, never rewritten");
  }
  // The same reading launch without a fork is accepted, so the refusal is specific to the context.
  assert.equal(
    inspectSubagentLaunch(
      { agent: ADVISOR_READ_AGENT_NAME, task: "q", model: "advice/advisor-model:medium" },
      active,
    ).refusal,
    undefined,
  );
});
