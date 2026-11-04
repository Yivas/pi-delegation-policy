import * as sdk from "@earendil-works/pi-coding-agent";
import type {
  Extension,
  ExtensionAPI,
  ExtensionContext,
  ExtensionRuntime,
  ProviderConfig,
  SessionBeforeCompactResult,
  SessionBeforeTreeResult,
} from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { admissionFor, readProviderAdmissions } from "./provider-admissions.ts";
import { locateInstalledPackage } from "./provider-package.ts";

export const PROVIDER_EXTENSION_ADVISOR_AGENT = "pi-delegation-policy.advisor-provider-extension";
export const PROVIDER_EXTENSION_ADVISOR_EXTENSION = fileURLToPath(import.meta.url);
const UNAVAILABLE =
  "Advisor provider unavailable: the admitted provider extension is missing, changed, or not usable in an Advisor child. Re-select it in /delegate.";

/**
 * Events replayed into the admitted extension with the real context. A provider extension may
 * need its session lifecycle and compaction signals; anything else it listens to is refused.
 */
const FORWARDED_EVENTS = [
  "session_shutdown",
  "input",
  "session_before_compact",
  "session_compact",
  "session_before_tree",
] as const;
const ALLOWED_EVENTS: ReadonlySet<string> = new Set(["session_start", ...FORWARDED_EVENTS]);

type Registry = ExtensionContext["modelRegistry"];
/** The native provider and the provider config registered for one id, compared by reference. */
type Registration = { native: Provider | undefined; config: ProviderConfig | undefined };

function registrations(registry: Registry): Map<string, Registration> {
  return new Map(
    registry.getRegisteredProviderIds().map((id) => [
      id,
      {
        native: registry.getRegisteredNativeProvider(id),
        config: registry.getRegisteredProviderConfig(id) as ProviderConfig | undefined,
      },
    ]),
  );
}

// Pi 0.87.1 exposes neither field, so this passes there; it refuses them on hosts that add them.
function safeRuntime(runtime: ExtensionRuntime): boolean {
  const mcp = Reflect.get(runtime, "mcpServers");
  return (
    !Reflect.get(runtime, "pendingVirtualModelRegistrations")?.length &&
    (mcp === undefined || (typeof mcp.list === "function" && mcp.list().length === 0))
  );
}

/**
 * Nothing the child could expose or render. Commands are tolerated and never registered: an
 * Advisor child has no user to invoke them.
 */
function safeSurface(extension: Extension, runtime: ExtensionRuntime): boolean {
  return (
    safeRuntime(runtime) &&
    extension.tools.size === 0 &&
    extension.flags.size === 0 &&
    extension.shortcuts.size === 0 &&
    extension.messageRenderers.size === 0 &&
    !extension.entryRenderers?.size &&
    !extension.markdownTransformer &&
    [...extension.handlers.keys()].every((event) => ALLOWED_EVENTS.has(event))
  );
}

/**
 * Runs only in the generic provider-extension Advisor profile. It loads the one user package the
 * operator admitted for this child's provider, after the same identity check the parent ran, and
 * otherwise leaves a guard that refuses every request. It never falls back to the built-in
 * provider with ambient credentials.
 *
 * The identity check is the real gate: the package runs as trusted host code once loaded, and the
 * later surface and registration checks can only withdraw its provider, not undo its side effects.
 */
export default function advisorProviderExtension(pi: ExtensionAPI): void {
  let loaded: Extension | undefined;
  let registry: Registry | undefined;
  let target: { provider: string; api: string } | undefined;
  // Registrations before the package ran. On failure, ids it added are withdrawn and ids it
  // replaced or removed get their previous registration back.
  let baseline: Map<string, Registration> | undefined;
  // True once this child registered the target provider, guard or extension alike.
  let claimed = false;
  const refuse = (): never => {
    throw new Error(UNAVAILABLE);
  };
  const restoreBaseline = (current: Registry, snapshot: Map<string, Registration>): void => {
    for (const id of current.getRegisteredProviderIds())
      if (!snapshot.has(id)) current.unregisterProvider(id);
    for (const [id, previous] of snapshot) {
      const now = registrations(current).get(id);
      if (now?.native === previous.native && now?.config === previous.config) continue;
      current.unregisterProvider(id);
      if (previous.native) current.registerProvider(previous.native);
      if (previous.config) current.registerProvider(id, previous.config);
    }
  };
  const guard = (): void => {
    if (!target) return;
    loaded = undefined;
    if (registry && baseline) restoreBaseline(registry, baseline);
    // Removing the extension's provider first also drops any native registration; the config
    // registered next replaces whatever is left, so requests reach `refuse` and nothing else.
    registry?.unregisterProvider(target.provider);
    pi.registerProvider(target.provider, { api: target.api, streamSimple: refuse });
    claimed = true;
  };
  const handlersOf = (event: string) => loaded?.handlers.get(event) ?? [];

  pi.on("session_start", async (event, ctx) => {
    loaded = undefined;
    baseline = undefined;
    registry = ctx.modelRegistry;
    if (!ctx.model) return;
    // Start from a clean slate: an earlier guard would make a provider extension refuse to
    // register, and an earlier success would make an unchanged re-registration look stale.
    if (claimed && target) registry.unregisterProvider(target.provider);
    claimed = false;
    const provider = ctx.model.provider;
    target = { provider, api: ctx.model.api };
    try {
      const pkg = admissionFor((await readProviderAdmissions()).admissions, provider);
      const location = pkg && locateInstalledPackage(ctx.cwd, pkg, { configured: true });
      if (!location?.ok || typeof sdk.DefaultResourceLoader !== "function") return guard();
      const before = registrations(registry);
      baseline = before;
      const loader = new sdk.DefaultResourceLoader({
        cwd: ctx.cwd,
        agentDir: sdk.getAgentDir(),
        settingsManager: sdk.SettingsManager.inMemory({}),
        noExtensions: true,
        additionalExtensionPaths: [location.entry],
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
      });
      await loader.reload();
      const result = loader.getExtensions();
      const extension = result.extensions[0];
      if (
        result.errors.length ||
        result.extensions.length !== 1 ||
        !extension ||
        realpathSync(extension.resolvedPath) !== location.entry ||
        !safeSurface(extension, result.runtime)
      )
        return guard();
      // Registrations through `pi` are held back and applied only for this provider. A native
      // registration through `ctx.modelRegistry` is not held, so the comparison below catches it.
      const configs = new Map(
        result.runtime.pendingProviderRegistrations.map(({ name, config }) => [name, config]),
      );
      const natives = new Map(
        result.runtime.pendingNativeProviderRegistrations.map(({ provider }) => [
          provider.id,
          provider,
        ]),
      );
      result.runtime.registerProvider = (name, config) => {
        configs.set(name, config);
      };
      result.runtime.registerNativeProvider = (provider) => {
        natives.set(provider.id, provider);
      };
      result.runtime.unregisterProvider = (name) => {
        configs.delete(name);
        natives.delete(name);
      };
      for (const handler of extension.handlers.get("session_start") ?? [])
        await handler(event, ctx);
      if (
        !safeSurface(extension, result.runtime) ||
        [...configs.keys(), ...natives.keys()].some((name) => name !== provider)
      )
        return guard();
      for (const provider of natives.values()) registry.registerProvider(provider);
      for (const [name, config] of configs) pi.registerProvider(name, config);
      const after = registrations(registry);
      const previous = before.get(provider);
      const current = after.get(provider);
      const othersUnchanged = [...before.keys(), ...after.keys()].every(
        (id) =>
          id === provider ||
          (before.get(id)?.native === after.get(id)?.native &&
            before.get(id)?.config === after.get(id)?.config),
      );
      const replaced =
        current !== undefined &&
        (current.native !== previous?.native || current.config !== previous?.config);
      claimed = current !== undefined;
      if (!othersUnchanged || !replaced) return guard();
      loaded = extension;
    } catch {
      // Ordinary extension errors do not stop Pi; keep this provider closed instead.
      guard();
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    try {
      for (const handler of handlersOf("session_shutdown")) await handler(event, ctx);
    } catch {
      guard();
    }
    loaded = undefined;
  });
  pi.on("session_compact", async (event, ctx) => {
    try {
      for (const handler of handlersOf("session_compact")) await handler(event, ctx);
    } catch {
      guard();
    }
  });
  // An Advisor's question is its task: a provider extension may observe it but never rewrite or
  // consume it, so any action other than continuing closes the provider.
  pi.on("input", async (event, ctx) => {
    try {
      for (const handler of handlersOf("input")) {
        const action = ((await handler(event, ctx)) as { action?: string } | undefined)?.action;
        if (action !== undefined && action !== "continue") return guard();
      }
    } catch {
      guard();
    }
  });
  // Same rule as the host for `session_before_*`: the last result wins and a cancel stops at once.
  const before = async (name: string, event: unknown, ctx: ExtensionContext) => {
    let result: { cancel?: boolean } | undefined;
    try {
      for (const handler of handlersOf(name)) {
        const value = (await handler(event, ctx)) as { cancel?: boolean } | undefined;
        if (value) {
          result = value;
          if (value.cancel) return value;
        }
      }
    } catch {
      guard();
    }
    return result;
  };
  pi.on(
    "session_before_compact",
    async (event, ctx) =>
      (await before("session_before_compact", event, ctx)) as
        SessionBeforeCompactResult | undefined,
  );
  pi.on(
    "session_before_tree",
    async (event, ctx) =>
      (await before("session_before_tree", event, ctx)) as SessionBeforeTreeResult | undefined,
  );
  pi.on("before_agent_start", () => {
    if (pi.getActiveTools().length) guard();
  });
}
