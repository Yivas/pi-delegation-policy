import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@gotgenes/pi-anthropic-auth";
const PACKAGE_VERSION = "3.4.3";
export const ANTHROPIC_ADVISOR_AGENT = "pi-delegation-policy.advisor-anthropic-auth";
export const ANTHROPIC_ADVISOR_EXTENSION = fileURLToPath(import.meta.url);
const UNAVAILABLE =
  "Advisor provider unavailable: requires the exact managed-user pi-anthropic-auth 3.4.3 installation and compatible public host APIs.";

type ProviderLocation = { ok: true; entry: string } | { ok: false; message: string };

/** Metadata only. Never load the provider, read its configuration, query accounts or install it. */
export function locateAdvisorAnthropicProvider(cwd: string): ProviderLocation {
  try {
    if (
      typeof sdk.DefaultPackageManager !== "function" ||
      typeof sdk.SettingsManager?.inMemory !== "function" ||
      typeof sdk.DefaultResourceLoader !== "function" ||
      typeof sdk.getAgentDir !== "function"
    )
      return { ok: false, message: UNAVAILABLE };
    const agentDir = sdk.getAgentDir();
    const expected = resolve(agentDir, "npm/node_modules", PACKAGE_NAME);
    // A missing managed install must not trigger PM's legacy fallback or an installation.
    if (!existsSync(expected)) return { ok: false, message: UNAVAILABLE };
    const manager = new sdk.DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: sdk.SettingsManager.inMemory({}),
    });
    if (typeof manager.getInstalledPath !== "function") return { ok: false, message: UNAVAILABLE };
    const source = `npm:${PACKAGE_NAME}@${PACKAGE_VERSION}`;
    const selected = manager.getInstalledPath(source, "user");
    if (!selected || resolve(selected) !== expected || manager.getInstalledPath(source, "project"))
      return { ok: false, message: UNAVAILABLE };
    if (realpathSync(expected) !== expected) return { ok: false, message: UNAVAILABLE };
    const manifest = JSON.parse(readFileSync(resolve(expected, "package.json"), "utf8"));
    if (
      manifest.name !== PACKAGE_NAME ||
      manifest.version !== PACKAGE_VERSION ||
      !Array.isArray(manifest.pi?.extensions) ||
      manifest.pi.extensions.length !== 1 ||
      manifest.pi.extensions[0] !== "./src/index.ts"
    )
      return { ok: false, message: UNAVAILABLE };
    const entry = resolve(expected, "src/index.ts");
    return realpathSync(entry) === entry
      ? { ok: true, entry }
      : { ok: false, message: UNAVAILABLE };
  } catch {
    return { ok: false, message: UNAVAILABLE };
  }
}

/** This adapter runs only in the separately selected, provider-specific Advisor profile. */
export default function advisorAnthropicProvider(pi: ExtensionAPI): void {
  let ready = false;
  let stream: ProviderConfig["streamSimple"];
  const closed = (): never => {
    throw new Error(UNAVAILABLE);
  };
  // The guard never disappears: even unregister/register during initialization is staged.
  pi.registerProvider("anthropic", {
    api: "anthropic-messages",
    streamSimple: (...args) => {
      if (!ready || !stream) return closed();
      return stream(...args);
    },
  });
  pi.on("session_start", async (event, ctx) => {
    ready = false;
    stream = undefined;
    if (ctx.model?.provider !== "anthropic") {
      if (ctx.model)
        pi.registerProvider(ctx.model.provider, { api: ctx.model.api, streamSimple: closed });
      return;
    }
    const location = locateAdvisorAnthropicProvider(ctx.cwd);
    if (!location.ok) return;
    try {
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
      const loaded = loader.getExtensions();
      if (loaded.errors.length || loaded.extensions.length !== 1) return;
      const extension = loaded.extensions[0]!;
      const safeRuntime = () => {
        const mcp = Reflect.get(loaded.runtime, "mcpServers");
        return (
          !Reflect.get(loaded.runtime, "pendingNativeProviderRegistrations")?.length &&
          !Reflect.get(loaded.runtime, "pendingVirtualModelRegistrations")?.length &&
          (mcp === undefined || (typeof mcp.list === "function" && mcp.list().length === 0))
        );
      };
      const safeSurface = () =>
        safeRuntime() &&
        extension.tools.size === 0 &&
        extension.flags.size === 0 &&
        extension.shortcuts.size === 0 &&
        extension.messageRenderers.size === 0 &&
        !extension.entryRenderers?.size &&
        !extension.markdownTransformer &&
        extension.handlers.size === 1 &&
        extension.handlers.get("session_start")?.length === 1 &&
        extension.commands.size === 1 &&
        extension.commands.has("anthropic-auth:status");
      if (realpathSync(extension.resolvedPath) !== location.entry || !safeSurface()) return;
      const staged = new Map(
        loaded.runtime.pendingProviderRegistrations.map(({ name, config }) => [name, config]),
      );
      loaded.runtime.registerProvider = (name, config) => {
        staged.set(name, config);
      };
      loaded.runtime.unregisterProvider = (name) => {
        staged.delete(name);
        if (name === "anthropic") {
          ready = false;
          stream = undefined;
        }
      };
      for (const handler of extension.handlers.get("session_start")!) await handler(event, ctx);
      if (!safeSurface()) return;
      const selected = staged.get("anthropic");
      if (!selected || typeof selected.streamSimple !== "function") return;
      for (const config of staged.values()) {
        if (
          Object.keys(config).sort().join(",") !== "api,streamSimple" ||
          config.api !== "anthropic-messages" ||
          config.streamSimple !== selected.streamSimple
        )
          return;
      }
      const command = extension.commands.get("anthropic-auth:status")!;
      pi.registerCommand("anthropic-auth:status", {
        description: command.description,
        getArgumentCompletions: command.getArgumentCompletions,
        handler: command.handler,
      });
      // Aliases come only from the verified plugin's normal configuration, never model input.
      for (const [name, config] of staged)
        if (name !== "anthropic") pi.registerProvider(name, config);
      stream = selected.streamSimple;
      ready = true;
    } catch {
      // Ordinary extension errors do not stop Pi. Keep the dispatch guard closed instead.
      ready = false;
      stream = undefined;
    }
  });
  pi.on("before_agent_start", () => {
    if (pi.getActiveTools().length) {
      ready = false;
      stream = undefined;
    }
  });
}
