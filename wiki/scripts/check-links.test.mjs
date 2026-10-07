import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { URL, fileURLToPath } from "node:url";
import { hasAnchor, resolveInternalReference } from "./check-links.mjs";

const siteRoot = resolve(fileURLToPath(new URL("..", import.meta.url)), ".vitepress/dist");
const homePage = resolve(siteRoot, "index.html");

test("resolves public-base routes and retains anchor fragments", () => {
  assert.deepEqual(
    resolveInternalReference("/pi-delegation-policy/configuration/#thinking", homePage),
    {
      candidates: [resolve(siteRoot, "configuration/index.html")],
      hash: "thinking",
    },
  );
});

test("rejects root-relative links that omit the deployment base", () => {
  assert.match(resolveInternalReference("/configuration/", homePage).error, /configured base path/);
});

test("skips external links", () => {
  assert.deepEqual(resolveInternalReference("https://example.com/docs", homePage), { skip: true });
});

test("security reporting links to GitHub's vulnerability reporting flow", async () => {
  const page = await readFile(new URL("../limits-and-privacy/index.md", import.meta.url), "utf8");
  const githubUrls = [...page.matchAll(/https:\/\/github\.com\/Yivas\/[^)\s]+/g)].map(
    ([url]) => url,
  );

  const repositoryUrl = "https://github.com/Yivas/pi-delegation-policy";
  assert.ok(githubUrls.includes(`${repositoryUrl}/security/advisories/new`));
  assert.ok(githubUrls.includes(`${repositoryUrl}/blob/main/CONTRIBUTING.md`));
  assert.ok(
    githubUrls.every((url) => url === repositoryUrl || url.startsWith(`${repositoryUrl}/`)),
  );
});

test("matches generated IDs and named anchors", () => {
  assert.equal(hasAnchor('<h2 id="advisor-role">Advisor</h2>', "advisor-role"), true);
  assert.equal(hasAnchor('<a name="legacy-anchor"></a>', "legacy-anchor"), true);
  assert.equal(hasAnchor('<h2 id="other">Other</h2>', "missing"), false);
});
