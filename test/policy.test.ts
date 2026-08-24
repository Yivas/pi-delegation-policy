import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import piDelegationPolicy, { parseCommand } from "../src/index.ts";
import {
  getConfigPaths,
  isValidPresetName,
  parseConfig,
  parseSessionState,
  resolveConfig,
  restoreLoadedSkills,
  restoreSessionState,
  writeConfig,
} from "../src/config.ts";
import { buildDelegationPolicy } from "../src/prompt.ts";
import {
  executorBlocked,
  loadRuntime,
  hasRuntimeError,
  normalizePathForComparison,
  recordSkillFromExpandedPrompt,
  recordSkillFromRead,
  supportedThinkingLevels,
  validateAssignment,
  validateExecutorTools,
  validateRuntime,
  type RuntimeState,
} from "../src/runtime.ts";
import type { ConfigDocument } from "../src/types.ts";
import {
  currentScopePresets,
  documentForScope,
  effectivePresetForScope,
  effectiveScopeNames,
  higherScopeReferencesPreset,
  renameCurrentPreset,
} from "../src/ui.ts";

const assignment = { provider: "example", model: "model", thinking: "high" };
const preset = {
  defaultMode: "normal" as const,
  defaultStrategy: "task-based" as const,
  skill: "delegation-skill",
  enforcement: true,
  executorTools: ["subagent"],
  tiered: { "ui-design": assignment },
  taskBased: { planning: assignment, "ui-design": assignment },
};
const global: ConfigDocument = {
  schemaVersion: 1,
  activePreset: "base",
  presets: { base: preset },
};
const execFileAsync = promisify(execFile);

function state(overrides: Partial<RuntimeState["effective"]> = {}): RuntimeState {
  return {
    effective: {
      activePreset: "base",
      mode: "normal",
      strategy: "task-based",
      preset,
      source: { activePreset: "global", mode: "preset", strategy: "preset", preset: "global" },
      ...overrides,
    },
    global,
    project: { schemaVersion: 1, presets: {} },
    session: { schemaVersion: 1 },
    diagnostics: [],
    loadedSkills: new Map(),
    skillFiles: new Map([["delegation-skill", "/skills/delegation-skill/SKILL.md"]]),
    skillsDiscovered: true,
    assignmentStatuses: new Map(),
    runtimeErrors: [],
    cwd: "/tmp",
  };
}

test("validates configuration and replaces same-name presets by scope", () => {
  assert.ok(parseConfig(global));
  assert.equal(parseConfig({ schemaVersion: 2, presets: {} }), undefined);
  assert.equal(
    parseConfig({ schemaVersion: 1, presets: { bad: { ...preset, enforcement: "yes" } } }),
    undefined,
  );
  assert.equal(
    parseConfig({
      schemaVersion: 1,
      presets: { bad: { ...preset, tiered: { unknown: assignment } } },
    }),
    undefined,
  );
  assert.equal(isValidPresetName("valid-name_1"), true);
  assert.equal(isValidPresetName("bad name"), false);
  const project: ConfigDocument = {
    schemaVersion: 1,
    presets: { base: { ...preset, defaultMode: "aggressive" } },
  };
  const resolved = resolveConfig(global, project, { schemaVersion: 1 });
  assert.equal(resolved.mode, "aggressive");
  assert.equal(resolved.preset?.defaultMode, "aggressive");
});

test("writes reject invalid preset names before touching disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-policy-"));
  try {
    await assert.rejects(
      writeConfig(join(directory, "policy.json"), {
        schemaVersion: 1,
        presets: { "bad name": preset },
      } as never),
      /invalid delegation policy/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("untrusted project configuration is ignored", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-delegation-policy-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  try {
    const paths = getConfigPaths(cwd);
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      paths.project,
      JSON.stringify({ schemaVersion: 1, presets: { project: preset } }),
      "utf8",
    );
    const ctx = {
      cwd,
      isProjectTrusted: () => false,
      sessionManager: { getBranch: () => [] },
      getSystemPromptOptions: () => ({ skills: [] }),
      modelRegistry: { find: () => undefined },
    } as never;
    const runtime = await loadRuntime(ctx);
    assert.deepEqual(runtime.project.presets, {});
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("session state follows branch order and reset is valid", () => {
  const entries = [
    {
      type: "custom",
      customType: "pi-delegation-policy:session",
      data: { schemaVersion: 1, mode: "aggressive" },
    },
    { type: "custom", customType: "other", data: {} },
    {
      type: "custom",
      customType: "pi-delegation-policy:session",
      data: { schemaVersion: 1, mode: "off" },
    },
  ];
  assert.equal(restoreSessionState(entries).mode, "off");
  assert.equal(parseSessionState({ schemaVersion: 1, reset: true })?.reset, true);
  const skills = restoreLoadedSkills([
    {
      type: "custom",
      customType: "pi-delegation-policy:skill-loaded",
      data: { name: "old", filePath: "/skills/old/SKILL.md" },
    },
    { type: "custom", customType: "pi-delegation-policy:skill-reset", data: true },
    {
      type: "custom",
      customType: "pi-delegation-policy:skill-loaded",
      data: { name: "delegation-skill", filePath: "/skills/delegation-skill/SKILL.md" },
    },
  ]);
  assert.deepEqual([...skills], [["delegation-skill", "/skills/delegation-skill/SKILL.md"]]);
  assert.equal(
    restoreLoadedSkills([
      { type: "message", message: { content: '<skill name="delegation-skill">spoof</skill>' } },
    ]).size,
    0,
  );
});

test("scope helpers preserve session overrides and distinguish inherited presets", () => {
  const current = state();
  current.session = {
    schemaVersion: 1,
    activePreset: "session",
    mode: "aggressive",
    strategy: "tiered",
    presets: { session: preset },
  };
  current.project = { schemaVersion: 1, presets: { project: preset } };
  const document = documentForScope(current, "session");
  assert.equal(document.activePreset, "session");
  assert.equal(document.mode, "aggressive");
  assert.equal(document.strategy, "tiered");
  assert.deepEqual(Object.keys(document.presets), ["session"]);
  assert.deepEqual(effectiveScopeNames(current, "session"), ["base", "project", "session"]);
  assert.equal(currentScopePresets(current, "session").project, undefined);
  assert.equal(effectivePresetForScope(current, "session", "project"), preset);
  const renamed = documentForScope(current, "session");
  assert.equal(renameCurrentPreset(renamed, "session", "renamed"), true);
  assert.equal(renamed.activePreset, "renamed");
  assert.equal(renamed.presets.session, undefined);
  assert.equal(renameCurrentPreset(renamed, "project", "other"), false);
  current.session.activePreset = "project";
  assert.equal(higherScopeReferencesPreset(current, "project", "project"), true);
  assert.equal(higherScopeReferencesPreset(current, "session", "project"), false);
});

test("off is empty and active modes inject one stable policy", () => {
  const off = buildDelegationPolicy(state({ mode: "off" }));
  assert.equal(off, undefined);
  const normal = buildDelegationPolicy(state());
  assert.ok(normal?.includes('external skill named "delegation-skill"'));
  assert.equal((normal?.split("<delegation_policy>").length ?? 1) - 1, 1);
  assert.match(normal ?? "", /ui-design is visual design only/);
  assert.doesNotMatch(normal ?? "", /ui-design.*implement the interface.*implementation/i);
  const aggressive = buildDelegationPolicy(state({ mode: "aggressive" }));
  assert.match(aggressive ?? "", /Mode: aggressive/);
  const missingSkill = state();
  missingSkill.skillFiles.clear();
  assert.match(buildDelegationPolicy(missingSkill) ?? "", /Delegation disabled/);
  assert.equal(hasRuntimeError(missingSkill), true);
  const repeated = buildDelegationPolicy(state());
  assert.equal(repeated, normal);
});

test("enforcement blocks only configured executor tools until the skill is loaded", () => {
  const current = state();
  assert.equal(executorBlocked(current, "subagent"), true);
  current.loadedSkills.set("delegation-skill", "/skills/delegation-skill/SKILL.md");
  assert.equal(executorBlocked(current, "subagent"), false);
  assert.equal(executorBlocked(current, "bash"), false);
});

test("only an exact successful skill expansion is accepted", () => {
  const current = state();
  const entries: unknown[] = [];
  const pi = { appendEntry: (_type: string, data?: unknown) => entries.push(data) };
  recordSkillFromExpandedPrompt(
    pi,
    current,
    "delegation-skill",
    '<skill name="delegation-skill" location="/skills/delegation-skill/SKILL.md">\nbody\n</skill>',
  );
  assert.deepEqual(entries, [
    { name: "delegation-skill", filePath: "/skills/delegation-skill/SKILL.md" },
  ]);
  const truncated = state();
  recordSkillFromExpandedPrompt(
    pi,
    truncated,
    "delegation-skill",
    '<skill name="delegation-skill" location="/skills/delegation-skill/SKILL.md">\nbody',
  );
  assert.equal(truncated.loadedSkills.size, 0);
  const similar = state();
  recordSkillFromExpandedPrompt(
    pi,
    similar,
    "delegation-skill",
    '<skill name="delegation-skill-extra" location="/skills/delegation-skill/SKILL.md">\nbody',
  );
  assert.equal(similar.loadedSkills.size, 0);
});

test("skill path comparison follows host case sensitivity", () => {
  assert.equal(
    normalizePathForComparison("/skills", "Foo/SKILL.md", "win32"),
    normalizePathForComparison("/skills", "foo/SKILL.md", "win32"),
  );
  assert.notEqual(
    normalizePathForComparison("/skills", "Foo/SKILL.md", "linux"),
    normalizePathForComparison("/skills", "foo/SKILL.md", "linux"),
  );
});

test("a loaded skill marker is invalidated when its discovered path changes", () => {
  const current = state();
  current.loadedSkills.set("delegation-skill", "/skills/old/SKILL.md");
  current.skillFiles.set("delegation-skill", "/skills/new/SKILL.md");
  assert.equal(executorBlocked(current, "subagent"), true);
});

test("skill reads normalize relative paths and missing executor tools fail closed", () => {
  const current = state();
  current.cwd = "/skills";
  current.skillFiles.set("delegation-skill", "/skills/delegation-skill/SKILL.md");
  const entries: unknown[] = [];
  recordSkillFromRead({ appendEntry: (_type, data) => entries.push(data) }, current, {
    path: "delegation-skill/SKILL.md",
  });
  assert.deepEqual(entries, [
    { name: "delegation-skill", filePath: "/skills/delegation-skill/SKILL.md" },
  ]);
  validateExecutorTools(current, ["read"]);
  assert.match(current.runtimeErrors.join("\n"), /executor tool.*subagent.*not registered/i);
  assert.equal(hasRuntimeError(current), true);
});

test("an active mode without a preset is an error and injects a disabling policy", () => {
  const current = state({ activePreset: undefined, preset: undefined, mode: "normal" });
  assert.equal(hasRuntimeError(current), true);
  assert.match(buildDelegationPolicy(current) ?? "", /Delegation disabled: no active preset/);
});

test("commands expose no model or subagent routing logic", async () => {
  assert.deepEqual(parseCommand("status"), { kind: "status" });
  assert.deepEqual(parseCommand("aggressive"), { kind: "mode", mode: "aggressive" });
  assert.deepEqual(parseCommand("reset"), { kind: "reset" });
  assert.deepEqual(parseCommand("status extra"), { kind: "invalid" });
  const source = await readFile(join(process.cwd(), "src/index.ts"), "utf8");
  assert.doesNotMatch(source, /registerTool|subagent\s*\(/);
});

test("extension lifecycle registers public UI and enforces skill loading without accumulation", async () => {
  type Handler = (
    event: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
  const cwd = await mkdtemp(join(tmpdir(), "pi-delegation-policy-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  try {
    await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    await writeConfig(getConfigPaths(cwd).global, global);
    const branch: Array<Record<string, unknown>> = [];
    const handlers = new Map<string, Handler>();
    const commands = new Set<string>();
    const shortcuts = new Set<string>();
    const pi = {
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      registerCommand: (name: string) => commands.add(name),
      registerShortcut: (name: string) => shortcuts.add(name),
      appendEntry: (customType: string, data?: unknown) =>
        branch.push({ type: "custom", customType, data }),
      getAllTools: () => [{ name: "read" }, { name: "subagent" }],
      getCommands: () => [{ source: "skill", name: "skill:delegation-skill" }],
    };
    piDelegationPolicy(pi as never);
    assert.deepEqual([...commands], ["delegate"]);
    assert.deepEqual([...shortcuts], ["ctrl+shift+d"]);

    const model = {
      provider: "example",
      id: "model",
      name: "Example",
      reasoning: true,
      thinkingLevelMap: { high: "high" },
    };
    const statuses: string[] = [];
    const ctx = {
      cwd,
      isProjectTrusted: () => false,
      sessionManager: { getBranch: () => branch },
      modelRegistry: {
        find: () => model,
        hasConfiguredAuth: () => true,
        getAll: () => [model],
      },
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setStatus: (_key: string, text: string | undefined) => {
          if (text) statuses.push(text);
        },
        notify: () => undefined,
      },
    };
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    const event = {
      type: "before_agent_start",
      prompt: "Do the work",
      systemPrompt: "BASE",
      systemPromptOptions: {
        skills: [{ name: "delegation-skill", filePath: "/skills/delegation-skill/SKILL.md" }],
      },
    };
    const first = (await handlers.get("before_agent_start")?.(event, ctx)) as {
      systemPrompt?: string;
    };
    const second = (await handlers.get("before_agent_start")?.(event, ctx)) as {
      systemPrompt?: string;
    };
    assert.equal(first.systemPrompt, second.systemPrompt);
    assert.equal((first.systemPrompt?.match(/<delegation_policy>/g) ?? []).length, 1);
    assert.deepEqual(await handlers.get("tool_call")?.({ toolName: "subagent" }, ctx), {
      block: true,
      reason: 'Load the configured skill "delegation-skill" before using subagent.',
    });
    await handlers.get("tool_result")?.(
      {
        toolName: "read",
        isError: false,
        input: { path: "/skills/delegation-skill/SKILL.md" },
      },
      ctx,
    );
    assert.equal(await handlers.get("tool_call")?.({ toolName: "subagent" }, ctx), undefined);
    await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);
    const blocked = {
      block: true,
      reason: 'Load the configured skill "delegation-skill" before using subagent.',
    };
    assert.deepEqual(await handlers.get("tool_call")?.({ toolName: "subagent" }, ctx), blocked);
    await handlers.get("tool_result")?.(
      {
        toolName: "read",
        isError: true,
        input: { path: "/skills/delegation-skill/SKILL.md" },
      },
      ctx,
    );
    assert.deepEqual(await handlers.get("tool_call")?.({ toolName: "subagent" }, ctx), blocked);
    await handlers.get("input")?.({ text: "/skill:delegation-skill" }, ctx);
    await handlers.get("before_agent_start")?.(
      {
        ...event,
        prompt:
          '<skill name="delegation-skill" location="/skills/delegation-skill/SKILL.md">\nbody\n</skill>',
      },
      ctx,
    );
    assert.equal(await handlers.get("tool_call")?.({ toolName: "subagent" }, ctx), undefined);
    assert.ok(statuses.length > 0);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("schema and examples match runtime validation", async () => {
  const schema = JSON.parse(
    await readFile(join(process.cwd(), "schema/delegation-policy.schema.json"), "utf8"),
  );
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  for (const name of ["global.json", "project.json"]) {
    const example = JSON.parse(await readFile(join(process.cwd(), "examples", name), "utf8"));
    assert.ok(validate(example), `${name}: ${JSON.stringify(validate.errors)}`);
    assert.ok(parseConfig(example), `${name} must pass runtime validation`);
  }
  const invalidName = { ...global, presets: { "bad name": preset } };
  assert.equal(validate(invalidName), false);
  assert.equal(parseConfig(invalidName), undefined);
});

test("package has no skills directory or private model configuration", async () => {
  const entries = await readdir(process.cwd());
  assert.equal(entries.includes("skills"), false);
  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  assert.equal(packageJson.version, "0.0.0");
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.pi.extensions[0], "./src/index.ts");
  const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
  assert.doesNotMatch(readme, /pi install git:/);
});

test("dry-run package contents match the public allowlist", async () => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "npm_execpath is required for the package-content check");
  const { stdout } = await execFileAsync(
    process.execPath,
    [npmCli, "pack", "--dry-run", "--json"],
    { cwd: process.cwd() },
  );
  const report = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  const files = report[0]?.files.map((file) => file.path).sort() ?? [];
  const expected = [
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "examples/global.json",
    "examples/project.json",
    "package.json",
    "schema/delegation-policy.schema.json",
    "src/config.ts",
    "src/index.ts",
    "src/prompt.ts",
    "src/runtime.ts",
    "src/types.ts",
    "src/ui.ts",
  ].sort();
  assert.deepEqual(files, expected);
});

test("runtime validation rejects unavailable active assignments without fallback", async () => {
  const current = state();
  const ctx = {
    modelRegistry: {
      find: () => ({
        provider: "example",
        id: "model",
        reasoning: true,
        thinkingLevelMap: { high: "high" },
      }),
      hasConfiguredAuth: () => false,
    },
  } as never;
  await validateRuntime(ctx, current);
  assert.equal(current.runtimeErrors.length, 2);
  assert.match(current.runtimeErrors.join("\n"), /no configured credentials/);
  assert.equal(hasRuntimeError(current), true);
  assert.match(buildDelegationPolicy(current) ?? "", /Delegation disabled/);
});

test("thinking levels accept xhigh and max only when Pi maps them", () => {
  const mapped = {
    provider: "example",
    id: "mapped",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  };
  const defaultMapped = {
    provider: "example",
    id: "default",
    reasoning: true,
  };
  assert.ok(supportedThinkingLevels(mapped as never).includes("xhigh"));
  assert.ok(supportedThinkingLevels(mapped as never).includes("max"));
  assert.equal(supportedThinkingLevels(defaultMapped as never).includes("xhigh"), false);
  assert.equal(supportedThinkingLevels(defaultMapped as never).includes("max"), false);
});

test("global config follows PI_CODING_AGENT_DIR", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/custom/pi-agent";
  try {
    assert.equal(
      getConfigPaths("/project").global,
      join("/custom/pi-agent", "delegation-policy.json"),
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("invalid lower-scope files report diagnostics without disabling a valid fallback", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-delegation-policy-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  try {
    const paths = getConfigPaths(cwd);
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    await writeFile(paths.global, "SECRET_FRAGMENT{", "utf8");
    await writeConfig(paths.project, global);
    const model = {
      provider: "example",
      id: "model",
      reasoning: true,
      thinkingLevelMap: { high: "high" },
    };
    const ctx = {
      cwd,
      isProjectTrusted: () => true,
      sessionManager: { getBranch: () => [] },
      getSystemPromptOptions: () => ({
        skills: [{ name: "delegation-skill", filePath: "/skills/delegation-skill/SKILL.md" }],
      }),
      modelRegistry: {
        find: () => model,
        hasConfiguredAuth: () => true,
      },
    } as never;
    const runtime = await loadRuntime(ctx);
    assert.equal(runtime.effective.activePreset, "base");
    assert.equal(runtime.diagnostics.length, 1);
    assert.equal(runtime.runtimeErrors.length, 0);
    assert.doesNotMatch(runtime.diagnostics[0]?.message ?? "", /SECRET_FRAGMENT/);
    assert.doesNotMatch(buildDelegationPolicy(runtime) ?? "", /Delegation disabled/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model validation distinguishes missing models and credentials", async () => {
  const model = {
    provider: "example",
    id: "model",
    reasoning: true,
    thinkingLevelMap: { high: "high" },
  };
  const ctx = {
    modelRegistry: {
      find: () => model,
      hasConfiguredAuth: () => false,
    },
  } as never;
  assert.equal((await validateAssignment(ctx, assignment))?.kind, "no-credentials");
  const missing = {
    modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
  } as never;
  assert.equal((await validateAssignment(missing, assignment))?.kind, "missing-model");
});
