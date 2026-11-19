import assert from "node:assert/strict";
import test from "node:test";
import { KNOWN_TOOL_SURFACE, safeSurface } from "../src/advisor-provider-extension.ts";

const pinned = KNOWN_TOOL_SURFACE[0];
const admitted = { package: pinned.package, version: pinned.version };

/** The minimum an `Extension` needs for the surface check. */
function extensionWith(tools: string[]) {
  return {
    tools: new Map(tools.map((tool) => [tool, {}])),
    flags: new Map(),
    shortcuts: new Map(),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    handlers: new Map(),
  };
}
const runtime = {} as never;

test("the reviewed tool passes only for the exact package and version it was reviewed for", () => {
  assert.equal(safeSurface(extensionWith([]) as never, runtime, admitted), true);
  assert.equal(safeSurface(extensionWith([pinned.tool]) as never, runtime, admitted), true);

  // Same tool name, another package: rejected. A name is not an identity.
  assert.equal(
    safeSurface(extensionWith([pinned.tool]) as never, runtime, { ...admitted, package: "other" }),
    false,
  );
  // Same package, another version: rejected. A version bump is a new review, not an inheritance.
  assert.equal(
    safeSurface(extensionWith([pinned.tool]) as never, runtime, { ...admitted, version: "0.1.22" }),
    false,
  );
  // Any second tool, even from the pinned package, is rejected.
  assert.equal(
    safeSurface(extensionWith([pinned.tool, "other"]) as never, runtime, admitted),
    false,
  );
  assert.equal(safeSurface(extensionWith(["other"]) as never, runtime, admitted), false);
});
