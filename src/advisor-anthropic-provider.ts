import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { locateInstalledPackage } from "./provider-package.ts";

export const ANTHROPIC_PROVIDER_PACKAGE = "@gotgenes/pi-anthropic-auth";
const PACKAGE_NAME = ANTHROPIC_PROVIDER_PACKAGE;
/** Exact releases reviewed for this adapter; 3.4.4 changed only documentation and comments. */
const PACKAGE_VERSIONS = ["3.4.3", "3.4.4"] as const;
export const ANTHROPIC_ADVISOR_AGENT = "pi-delegation-policy.advisor-anthropic-auth";
export const ANTHROPIC_ADVISOR_EXTENSION = fileURLToPath(import.meta.url);
const UNAVAILABLE =
  "Advisor provider unavailable: requires the exact managed-user pi-anthropic-auth 3.4.3 or 3.4.4 installation and compatible public host APIs.";

type ProviderLocation = { ok: true; entry: string } | { ok: false; message: string };

/** Metadata only. Never load the provider, read its configuration, query accounts or install it. */
export function locateAdvisorAnthropicProvider(cwd: string): ProviderLocation {
  if (typeof sdk.DefaultResourceLoader !== "function") return { ok: false, message: UNAVAILABLE };
  for (const version of PACKAGE_VERSIONS) {
    const location = locateInstalledPackage(
      cwd,
      { package: PACKAGE_NAME, version },
      { expectedEntry: "./src/index.ts" },
    );
    if (location.ok) return location;
  }
  return { ok: false, message: UNAVAILABLE };
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
