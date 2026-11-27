import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  KNOWN_TOOL_SURFACE,
  PACKAGED_PROFILES,
  REVIEWED_PACKAGE,
  isPackagedAdmission,
} from "../src/advisor-provider-extension.ts";
import { advisorAgentName } from "../src/advisor-executor.ts";
import { getGlobalConfigPath } from "../src/config.ts";
import { DelegatePanel } from "../src/delegate-panel.ts";
import { buildDelegationPolicy } from "../src/prompt.ts";
import {
  getProviderAdmissionsPath,
  parseProviderAdmissions,
  readProviderAdmissions,
  writeProviderAdmissions,
} from "../src/provider-admissions.ts";
import {
  locateSiblingPackage,
  listProviderExtensionCandidates,
  PACKAGE_ROOT,
  siblingExtensionEntry,
  siblingExtensionPath,
} from "../src/provider-package.ts";
import { resolveDelegateState } from "../src/config.ts";
import { validateRuntime, type RuntimeState } from "../src/runtime.ts";
import { CURRENT_SCHEMA_VERSION, type GlobalDefaults } from "../src/types.ts";

const PACKAGE = "synthetic-go-provider";
const VERSION = "1.0.0";

// The candidate check reads only the manifest, the pinned user source and one entry file inside the
// package, so the entry has to exist but does not have to do anything.
const syntheticSource = "export default function () {}\n";

async function withAgentDirectory<T>(
  name: string,
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), name));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    return await run(directory);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function installSynthetic(directory: string, configured = true): Promise<void> {
  const root = join(directory, "npm/node_modules", PACKAGE);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: PACKAGE, version: VERSION, pi: { extensions: ["./index.js"] } }),
  );
  await writeFile(join(root, "index.js"), syntheticSource);
  await writeFile(
    join(directory, "settings.json"),
    JSON.stringify({ packages: configured ? [`npm:${PACKAGE}@${VERSION}`] : [] }),
  );
}

test("admissions are strict per provider and candidates are only configured, exact user packages", async () => {
  await withAgentDirectory("advisor-provider-admissions-", async (directory) => {
    const path = getProviderAdmissionsPath(getGlobalConfigPath(directory));
    assert.deepEqual(await readProviderAdmissions(path), { admissions: {} });
    await writeProviderAdmissions(
      { "example-provider": { package: PACKAGE, version: VERSION } },
      path,
    );
    assert.deepEqual((await readProviderAdmissions(path)).admissions, {
      "example-provider": { package: PACKAGE, version: VERSION },
    });
    for (const invalid of [
      { schemaVersion: 2, providers: {} },
      { schemaVersion: 1, providers: { anthropic: { package: PACKAGE, version: VERSION } } },
      { schemaVersion: 1, providers: { x: { package: "../escape", version: VERSION } } },
      { schemaVersion: 1, providers: { x: { package: PACKAGE, version: "^1.0.0" } } },
      { schemaVersion: 1, providers: { x: { package: PACKAGE, version: VERSION, entry: "a" } } },
    ])
      assert.equal(parseProviderAdmissions(invalid), undefined);
    await writeFile(path, "{");
    const broken = await readProviderAdmissions(path);
    assert.deepEqual(broken.admissions, {});
    assert.equal(broken.diagnostic?.scope, "advisor-extension");

    await installSynthetic(directory);
    assert.deepEqual(listProviderExtensionCandidates(directory, []), [
      { package: PACKAGE, version: VERSION },
    ]);
    assert.deepEqual(listProviderExtensionCandidates(directory, [PACKAGE]), []);
    await installSynthetic(directory, false);
    assert.deepEqual(listProviderExtensionCandidates(directory, []), []);
  });
});

test("the parent routes admitted Advisors to the generic profile and reports a native provider without one", async () => {
  // An empty agent directory: the identity check must not read the developer's own settings.
  await withAgentDirectory("advisor-provider-parent-", async () => routeAndReport());
});

function routeAndReport(): void {
  const advisors = [
    { provider: "example-provider", model: "example-model" },
    { provider: "example", model: "plain" },
  ];
  const settings: GlobalDefaults = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    intensity: "off",
    advisors,
    advisorMode: "on",
    advisorLaunch: "role",
  };
  const admissions = {
    "example-provider": { package: REVIEWED_PACKAGE.package, version: "0.0.1" },
  };
  assert.equal(
    advisorAgentName(advisors[0]!, admissions),
    "pi-delegation-policy.advisor-provider-extension",
  );
  // The version an admission records is not compared: the profile loads the installed package, so a
  // version this release never saw still routes.
  assert.equal(
    advisorAgentName(advisors[0]!, {
      "example-provider": { package: REVIEWED_PACKAGE.package, version: "99.0.0" },
    }),
    "pi-delegation-policy.advisor-provider-extension",
  );
  // One packaged profile loads one package, so an admission naming another one must not route to it.
  assert.equal(
    advisorAgentName(advisors[0]!, {
      "example-provider": { package: PACKAGE, version: VERSION },
    }),
    "pi-delegation-policy.advisor",
  );
  assert.equal(advisorAgentName(advisors[1]!, admissions), "pi-delegation-policy.advisor");
  assert.equal(
    advisorAgentName(
      { provider: "anthropic", model: "m" },
      { anthropic: admissions["example-provider"] },
    ),
    "pi-delegation-policy.advisor",
  );

  const models = advisors.map(({ provider, model }) => ({
    provider,
    id: model,
    api: "openai-completions",
    reasoning: false,
  }));
  const context = (natives: string[]) =>
    ({
      cwd: tmpdir(),
      modelRegistry: {
        find: (provider: string, id: string) =>
          models.find((model) => model.provider === provider && model.id === id),
        getAvailable: () => models,
        hasConfiguredAuth: () => true,
        getRegisteredProviderIds: () => natives,
        getRegisteredNativeProvider: (provider: string) =>
          natives.includes(provider) ? { id: provider } : undefined,
      },
    }) as never;
  const state = (stateAdmissions: RuntimeState["admissions"]): RuntimeState => ({
    global: settings,
    session: { schemaVersion: CURRENT_SCHEMA_VERSION },
    effective: resolveDelegateState(settings, { schemaVersion: CURRENT_SCHEMA_VERSION }),
    diagnostics: [],
    admissions: stateAdmissions,
    modelStatuses: new Map(),
    runtimeErrors: [],
  });

  const unadmitted = state({});
  validateRuntime(context(["example-provider"]), unadmitted);
  // A warning only: the built-in provider may still answer, so the Advisor stays consulted.
  assert.deepEqual(unadmitted.advisorEntries?.[0]?.errors, []);
  assert.match(unadmitted.advisorWarnings?.[0] ?? "", /replaced by an extension in this session/);
  assert.deepEqual(unadmitted.advisorEntries?.[1]?.errors, []);

  // This package runs from a checkout here, so the profile's relative entry does not reach the
  // managed install: the cause and the remedy are both named before any launch.
  const notManaged = state(admissions);
  validateRuntime(context(["example-provider"]), notManaged);
  const notManagedMessage = notManaged.advisorEntries?.[0]?.errors[0] ?? "";
  assert.match(notManagedMessage, /cannot be loaded/);
  assert.match(notManagedMessage, /cannot be confirmed as Pi's managed user package/);
  assert.match(notManagedMessage, /install it as a user package/);
  assert.ok(notManagedMessage.includes(REVIEWED_PACKAGE.package));
  assert.doesNotMatch(notManagedMessage, /needs its own profile/);
  // These settings have delegation off and the Advisor on, and the launch check needs this pair then
  // too: an enabled Advisor can launch the profile that loads the sibling. Resolving it only after the
  // delegation-off return would refuse a healthy consultation for a check the session never ran.
  assert.equal(notManaged.cwd, tmpdir());
  assert.equal(notManaged.packageRoot, PACKAGE_ROOT);
  assert.deepEqual(notManaged.extensionProviders, ["example-provider"]);

  // One packaged profile loads one package, so an admission naming another one is an error, not a
  // silent route to the ordinary profile, and selecting it cannot serve it.
  const foreign = state({ "example-provider": { package: PACKAGE, version: VERSION } });
  validateRuntime(context(["example-provider"]), foreign);
  const foreignMessage = foreign.advisorEntries?.[0]?.errors[0] ?? "";
  assert.match(foreignMessage, /cannot be served/);
  assert.ok(foreignMessage.includes(PACKAGE));
  assert.match(foreignMessage, /needs its own profile/);
  assert.match(foreignMessage, /provider needs no extension/);
  assert.doesNotMatch(foreignMessage, /install it as a user package/);

  const unaffected = state({});
  validateRuntime(context([]), unaffected);
  assert.deepEqual(
    unaffected.advisorEntries?.map((entry) => entry.errors),
    [[], []],
  );
  const policy = buildDelegationPolicy(unaffected) ?? "";
  assert.match(policy, /agent profile: "pi-delegation-policy\.advisor"/);
}

test("the provider-extension step admits, removes and discards only through the draft", async () => {
  const saved: unknown[] = [];
  let applied = 0;
  const settings: GlobalDefaults = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    intensity: "normal",
    small: { provider: "example", model: "small" },
    medium: null,
    large: null,
    advisors: [{ provider: "example-provider", model: "example-model" }],
    advisorMode: "on",
    advisorLaunch: "role",
  };
  const panel = (rows = 24) =>
    new DelegatePanel({
      tui: { terminal: { rows }, requestRender: () => undefined } as never,
      theme: {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      global: settings,
      session: { schemaVersion: CURRENT_SCHEMA_VERSION },
      candidates: [
        { provider: "example-provider", id: "example-model", name: "Example", reasoning: true },
      ] as never,
      diagnostics: [],
      hasRuntimeError: false,
      admissions: {},
      extensionCandidates: [{ package: PACKAGE, version: VERSION }],
      extensionProviders: ["example-provider"],
      onSaveAdmissions: async (admissions) => {
        saved.push(admissions);
        return true;
      },
      onApply: async () => {
        applied++;
        return true;
      },
      onSaveDefaults: async () => ({ kind: "unchanged" }),
      onDone: () => undefined,
    });
  const chooseAdvisorModel = (target: DelegatePanel) => {
    // Advisor 1 row, then its model selector: global, disable, its content-filter switch, then
    // example-provider/example-model. The focus is resolved by name because a row can appear or
    // disappear with the configuration.
    target.handleInput("\u001b[H");
    const advisorRow = target.visibleFields().indexOf("advisor" as never);
    assert.ok(advisorRow >= 0, `the panel shows advisor: ${target.visibleFields().join(", ")}`);
    for (let index = 0; index < advisorRow; index++) target.handleInput("\u001b[B");
    target.handleInput("\r");
    target.handleInput("\u001b[B");
    target.handleInput("\u001b[B");
    target.handleInput("\u001b[B");
    target.handleInput("\r");
  };

  for (const [width, rows] of [
    [80, 24],
    [40, 12],
  ]) {
    const target = panel(rows);
    target.render(width);
    chooseAdvisorModel(target);
    const step = target.render(width);
    assert.ok(step.length <= rows);
    assert.ok(step.some((line) => line.startsWith("> Standard profile")));
    target.handleInput("\u001b[B");
    assert.ok(target.render(width).some((line) => line.startsWith(`> ${PACKAGE} ${VERSION}`)));
    // Escape keeps the provider's previous admission: none.
    target.handleInput("\u001b");
    assert.deepEqual(target.getDraftAdmissions(), {});
  }

  const target = panel();
  target.render(80);
  chooseAdvisorModel(target);
  target.handleInput("\u001b[B");
  target.handleInput("\r");
  assert.deepEqual(target.getDraftAdmissions(), {
    "example-provider": { package: PACKAGE, version: VERSION },
  });
  assert.ok(
    target.render(120).some((line) => line.includes(`example-model · ${PACKAGE} ${VERSION}`)),
  );
  assert.equal(target.isDirty(), true);
  target.handleInput("a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saved, [{ "example-provider": { package: PACKAGE, version: VERSION } }]);
  assert.equal(applied, 1);

  const withoutStep = new DelegatePanel({
    tui: { terminal: { rows: 24 }, requestRender: () => undefined } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    global: settings,
    session: { schemaVersion: CURRENT_SCHEMA_VERSION },
    candidates: [
      { provider: "example-provider", id: "example-model", name: "Example", reasoning: true },
    ] as never,
    diagnostics: [],
    hasRuntimeError: false,
    extensionCandidates: [{ package: PACKAGE, version: VERSION }],
    extensionProviders: [],
    onApply: async () => true,
    onSaveDefaults: async () => ({ kind: "unchanged" }),
    onDone: () => undefined,
  });
  withoutStep.render(80);
  chooseAdvisorModel(withoutStep);
  assert.ok(!withoutStep.render(80).some((line) => line.startsWith("> Standard profile")));
});

async function frontmatterOf(...segments: string[]): Promise<string> {
  const profile = (await readFile(join(process.cwd(), ...segments), "utf8")).replace(/\r\n/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(profile)?.[1];
  assert.ok(frontmatter, `${segments.join("/")} must have frontmatter`);
  return frontmatter;
}

// The child resolves its model and provider before any extension `session_start` runs, so the host
// loads the reviewed package and the profile names it. The empty `extensions:` key is what turns
// ambient extensions off, and no extension path of its own may come back.
test("the packaged profiles name the installed sibling, by the path the host resolves", async () => {
  for (const [file, tools] of [
    ["pi-delegation-policy.advisor-provider-extension.md", /^tools:$/m],
    [
      "pi-delegation-policy.execution-antigravity-acp.md",
      /^tools: read, grep, find, ls, bash, edit, write, contact_supervisor$/m,
    ],
    // The read-only profile: exactly what `reviewer` declares, and no writing or shell tool.
    [
      "pi-delegation-policy.reader-antigravity-acp.md",
      /^tools: read, grep, find, ls, watchdog_diff, contact_supervisor$/m,
    ],
  ] as const) {
    const frontmatter = await frontmatterOf("agents", file);
    assert.match(frontmatter, /^extensions:\nsubagentOnlyExtensions: \.\.\/\.[^\n]*$/m, file);
    assert.equal(
      frontmatter.match(/^subagentOnlyExtensions:(.*)$/m)?.[1]?.trim(),
      siblingExtensionEntry(REVIEWED_PACKAGE.package),
      file,
    );
    // A registry source would install a copy instead of loading the installed package, and an
    // absolute path would name one machine.
    assert.doesNotMatch(frontmatter, /^subagentOnlyExtensions:\s*npm:/m, file);
    assert.match(frontmatter, tools, file);
  }
  // The permission tool the package registers must stay out of the allowlist the model sees, and the
  // read-only profile may not gain a writing or shell tool either.
  for (const file of [
    "pi-delegation-policy.execution-antigravity-acp.md",
    "pi-delegation-policy.reader-antigravity-acp.md",
  ]) {
    const frontmatter = await frontmatterOf("agents", file);
    assert.doesNotMatch(frontmatter, new RegExp(REVIEWED_PACKAGE.tool), file);
  }
  const reader = await frontmatterOf("agents", "pi-delegation-policy.reader-antigravity-acp.md");
  assert.match(reader, /^acceptanceRole: read-only$/m);
  assert.doesNotMatch(reader, /^tools:.*\b(bash|edit|write)\b/m);
  const execution = await frontmatterOf(
    "agents",
    "pi-delegation-policy.execution-antigravity-acp.md",
  );
  assert.match(execution, /^acceptanceRole: writer$/m);
  // A static profile names one package, so the reviewed exception has to stay a single one.
  assert.equal(KNOWN_TOOL_SURFACE.length, 1);
  assert.equal(KNOWN_TOOL_SURFACE[0].provider, "antigravity-acp");
  assert.equal(
    KNOWN_TOOL_SURFACE[0].executionAgent,
    "pi-delegation-policy.execution-antigravity-acp",
  );
  assert.equal(KNOWN_TOOL_SURFACE[0].readerAgent, "pi-delegation-policy.reader-antigravity-acp");
  assert.deepEqual(
    PACKAGED_PROFILES.map((profile) => profile.kind),
    ["execution", "reader"],
  );
});

// A fixed path with a fixed expected value: the arithmetic is asserted, not rebuilt with the
// production helper, so a wrong number of `..` segments fails here. The agent file always sits in
// `<package>/agents`, so `../..` necessarily lands in the directory the package is installed in.
test("the sibling path is the installed package two levels above the profile file", () => {
  const modules = resolve(tmpdir(), "agentdir", "npm", "node_modules");
  const agentPath = join(modules, "pi-delegation-policy", "agents", "profile.md");
  assert.equal(
    siblingExtensionPath(agentPath, REVIEWED_PACKAGE.package),
    join(modules, REVIEWED_PACKAGE.package),
  );
  // One level up would be the plugin's own directory, which is what a wrong depth would return.
  assert.notEqual(
    siblingExtensionPath(agentPath, REVIEWED_PACKAGE.package),
    join(modules, "pi-delegation-policy", REVIEWED_PACKAGE.package),
  );
});

// The admission selects the package the review covered, not a version: that is what keeps a
// provider update from needing a release of this one.
test("an admission selects the reviewed package whatever version it records", () => {
  assert.equal(isPackagedAdmission({ package: REVIEWED_PACKAGE.package, version: "0.0.1" }), true);
  assert.equal(
    isPackagedAdmission({ package: REVIEWED_PACKAGE.package, version: "99.0.0-beta.1" }),
    true,
  );
  assert.equal(isPackagedAdmission({ package: PACKAGE, version: "1.0.0" }), false);
});

// The parent checks the installed sibling itself, because the child cannot: it loads the package
// before it could inspect anything. Each cause has its own remedy, so each one is exercised.
test("the sibling check accepts one installed, unlinked, configured package and names each cause", async () => {
  await withAgentDirectory("advisor-sibling-", async (directory) => {
    const modules = join(directory, "npm", "node_modules");
    const managed = join(modules, REVIEWED_PACKAGE.package);
    const pluginRoot = join(modules, "pi-delegation-policy");
    const install = async (
      options: {
        entries?: unknown;
        name?: string;
        packages?: string[];
      } = {},
    ) => {
      await rm(managed, { recursive: true, force: true });
      await mkdir(join(pluginRoot, "agents"), { recursive: true });
      await mkdir(managed, { recursive: true });
      await writeFile(
        join(managed, "package.json"),
        JSON.stringify({
          name: options.name ?? REVIEWED_PACKAGE.package,
          version: "9.9.9",
          pi: { extensions: options.entries ?? ["./index.js"] },
        }),
      );
      await writeFile(join(managed, "index.js"), syntheticSource);
      await writeFile(
        join(directory, "settings.json"),
        JSON.stringify({ packages: options.packages ?? [`npm:${REVIEWED_PACKAGE.package}@1.0.0`] }),
      );
    };
    const check = (root = pluginRoot) =>
      locateSiblingPackage(directory, root, REVIEWED_PACKAGE.package, { configured: true });

    // The manifest declares 9.9.9 while the settings list 1.0.0 and no version is compared.
    await install();
    const valid = check();
    assert.equal(valid.ok, true);
    assert.equal(valid.ok && valid.entry, resolve(managed, "index.js"));

    // A package Pi never installed is told to install it.
    await rm(managed, { recursive: true, force: true });
    const missing = check();
    assert.equal(missing.ok, false);
    assert.match(missing.ok ? "" : missing.message, /cannot be confirmed as installed in/);
    assert.match(missing.ok ? "" : missing.message, /install it as a user package/);

    // A checkout, a project install or git resolves `../..` somewhere else entirely.
    await install();
    const elsewhere = check(join(directory, "elsewhere", "pi-delegation-policy"));
    assert.equal(elsewhere.ok, false);
    assert.match(
      elsewhere.ok ? "" : elsewhere.message,
      /cannot be confirmed as Pi's managed user package/,
    );
    assert.match(elsewhere.ok ? "" : elsewhere.message, /install it as a user package/);

    // A link is not the installed package.
    await rm(managed, { recursive: true, force: true });
    await mkdir(join(directory, "linked"), { recursive: true });
    await writeFile(
      join(directory, "linked", "package.json"),
      JSON.stringify({
        name: REVIEWED_PACKAGE.package,
        version: "9.9.9",
        pi: { extensions: ["./index.js"] },
      }),
    );
    await writeFile(join(directory, "linked", "index.js"), syntheticSource);
    await symlink(join(directory, "linked"), managed, "junction");
    const linked = check();
    assert.equal(linked.ok, false);
    assert.match(linked.ok ? "" : linked.message, /resolves through a link/);

    // A manifest that does not say what it is, or that declares two entries, cannot be loaded.
    await install({ name: "another-package" });
    const renamed = check();
    assert.equal(renamed.ok, false);
    assert.match(renamed.ok ? "" : renamed.message, /reports another name/);

    await install({ entries: ["./index.js", "./second.js"] });
    const twoEntries = check();
    assert.equal(twoEntries.ok, false);
    assert.match(twoEntries.ok ? "" : twoEntries.message, /exactly one extension entry/);

    // An entry inside the package is required: a parent-relative one loads code from elsewhere.
    await install({ entries: ["../escape.js"] });
    const escape = check();
    assert.equal(escape.ok, false);
    assert.match(escape.ok ? "" : escape.message, /outside its own directory/);

    // Only code the user configured may run in the child.
    await install({ packages: [] });
    const unconfigured = check();
    assert.equal(unconfigured.ok, false);
    assert.match(unconfigured.ok ? "" : unconfigured.message, /do not list it/);
  });
});

// The agent directory and the package directory are compared as the filesystem sees them, so a
// differently capitalised path is the same install on Windows and a different one on Linux. Both
// branches are asserted, so the case-folding decision is exercised on every platform.
test("the agent directory compares as the filesystem does, not as the string reads", async () => {
  await withAgentDirectory("advisor-sibling-case-", async (directory) => {
    const modules = join(directory, "npm", "node_modules");
    const pluginRoot = join(modules, "pi-delegation-policy");
    const managed = join(modules, REVIEWED_PACKAGE.package);
    await mkdir(managed, { recursive: true });
    await writeFile(
      join(managed, "package.json"),
      JSON.stringify({
        name: REVIEWED_PACKAGE.package,
        version: "9.9.9",
        pi: { extensions: ["./index.js"] },
      }),
    );
    await writeFile(join(managed, "index.js"), syntheticSource);
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({ packages: [`npm:${REVIEWED_PACKAGE.package}@1.0.0`] }),
    );
    assert.equal(locateSiblingPackage(directory, pluginRoot, REVIEWED_PACKAGE.package).ok, true);
    // The same directory, upper-cased: Windows resolves it, so the check must accept it.
    assert.equal(
      locateSiblingPackage(
        directory,
        pluginRoot.toUpperCase(),
        REVIEWED_PACKAGE.package.toUpperCase(),
      ).ok,
      false,
      "an upper-cased package name is not that package name",
    );
    const casedRoot = locateSiblingPackage(
      join(directory, "npm", "node_modules", "pi-delegation-policy"),
      join(modules.toUpperCase(), "pi-delegation-policy"),
      REVIEWED_PACKAGE.package,
    );
    if (process.platform === "win32")
      assert.equal(casedRoot.ok, true, "an upper-cased managed root is the same root on Windows");
    else
      assert.equal(casedRoot.ok, false, "a differently cased root is another directory on Linux");
  });
});
