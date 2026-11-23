import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  KNOWN_TOOL_SURFACE,
  PINNED_PACKAGE,
  isPinnedAdmission,
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
  isProviderPackage,
  listProviderExtensionCandidates,
  packageSource,
} from "../src/provider-package.ts";
import { resolveDelegateState } from "../src/config.ts";
import { validateRuntime, type RuntimeState } from "../src/runtime.ts";
import { CURRENT_SCHEMA_VERSION, type GlobalDefaults } from "../src/types.ts";

const PACKAGE = "synthetic-go-provider";
const VERSION = "1.0.0";

// The pinned version with its last number raised: a valid exact version this release never reviewed.
const UNREVIEWED_VERSION = PINNED_PACKAGE.version.replace(/(\d+)(?=[-+]|$)/, (number) =>
  String(Number(number) + 1),
);

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
    "example-provider": { package: PINNED_PACKAGE.package, version: PINNED_PACKAGE.version },
  };
  assert.equal(
    advisorAgentName(advisors[0]!, admissions),
    "pi-delegation-policy.advisor-provider-extension",
  );
  // The packaged profile pins one package, so an admission naming another one must not route to it.
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

  // An admitted package that is no longer installed is reported before any launch.
  const missing = state(admissions);
  validateRuntime(context(["example-provider"]), missing);
  const missingMessage = missing.advisorEntries?.[0]?.errors[0] ?? "";
  assert.match(missingMessage, /re-select the provider extension/);
  assert.match(missingMessage, /install that exact version/);

  // A version of the pinned package this release never reviewed and a second admitted package are
  // different states, and each message offers only what resolves its own state.
  const unreviewed = state({
    "example-provider": { package: PINNED_PACKAGE.package, version: UNREVIEWED_VERSION },
  });
  validateRuntime(context(["example-provider"]), unreviewed);
  const unreviewedMessage = unreviewed.advisorEntries?.[0]?.errors[0] ?? "";
  assert.match(unreviewedMessage, /cannot be served/);
  assert.ok(unreviewedMessage.includes(UNREVIEWED_VERSION));
  assert.ok(unreviewedMessage.includes(PINNED_PACKAGE.version));
  assert.match(unreviewedMessage, /select the provider extension again/);
  assert.doesNotMatch(unreviewedMessage, /needs its own profile/);

  // The packaged profile pins one package, so an admission naming another one is an error, not a
  // silent route to the ordinary profile, and selecting it cannot serve it.
  const foreign = state({ "example-provider": { package: PACKAGE, version: VERSION } });
  validateRuntime(context(["example-provider"]), foreign);
  const foreignMessage = foreign.advisorEntries?.[0]?.errors[0] ?? "";
  assert.match(foreignMessage, /cannot be served/);
  assert.ok(foreignMessage.includes(`${PACKAGE} ${VERSION}`));
  assert.match(foreignMessage, /needs its own profile/);
  assert.match(foreignMessage, /provider needs no extension/);
  assert.doesNotMatch(foreignMessage, /select the provider extension again/);

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

// The child resolves its model and provider before any extension `session_start` runs, so the host
// loads the admitted package and the profile pins it. The empty `extensions:` key is what turns
// ambient extensions off, and no extension path of its own may come back.
test("the packaged profile pins the reviewed provider package the host loads", async () => {
  const profile = (
    await readFile(
      join(process.cwd(), "agents", "pi-delegation-policy.advisor-provider-extension.md"),
      "utf8",
    )
  ).replace(/\r\n/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(profile)?.[1];
  assert.ok(frontmatter, "provider extension profile must have frontmatter");
  assert.match(frontmatter, /^extensions:\nsubagentOnlyExtensions: npm:\S+@\S+$/m);
  assert.equal(
    frontmatter.match(/^subagentOnlyExtensions:(.*)$/m)?.[1]?.trim(),
    packageSource(PINNED_PACKAGE),
  );
  assert.match(frontmatter, /^tools:$/m);
  // A static profile can pin one package, so the reviewed exception has to stay a single one.
  assert.equal(KNOWN_TOOL_SURFACE.length, 1);
});

// The pin compares package and version exactly, so an admission this release did not review stays
// unreviewed even when the other half matches.
test("an admission naming another package or version is not the pinned admission", () => {
  // A derived version that is not a valid exact version would make the case below vacuous.
  assert.ok(isProviderPackage({ package: PINNED_PACKAGE.package, version: UNREVIEWED_VERSION }));
  assert.notEqual(UNREVIEWED_VERSION, PINNED_PACKAGE.version);
  assert.equal(
    isPinnedAdmission({ package: PINNED_PACKAGE.package, version: PINNED_PACKAGE.version }),
    true,
  );
  assert.equal(
    isPinnedAdmission({ package: PINNED_PACKAGE.package, version: UNREVIEWED_VERSION }),
    false,
  );
  assert.equal(isPinnedAdmission({ package: PACKAGE, version: PINNED_PACKAGE.version }), false);
});
