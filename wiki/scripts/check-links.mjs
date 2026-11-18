import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { URL, fileURLToPath } from "node:url";

const siteDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = resolve(siteDirectory, ".vitepress/dist");
const basePath = "/pi-delegation-policy/";
const siteOrigin = "https://yivas.github.io";
const requiredRoutes = [
  "/",
  "/getting-started/",
  "/configuration/",
  "/commands-and-status/",
  "/limits-and-privacy/",
];
const ignoredSchemes = /^(?:data:|javascript:|mailto:|tel:)/i;

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function collectHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectHtmlFiles(path);
      return entry.isFile() && entry.name.endsWith(".html") ? [path] : [];
    }),
  );
  return files.flat();
}

function attributes(html) {
  const result = new Map();
  const pattern = /([\w:-]+)\s*=\s*(["'])(.*?)\2/gs;
  for (const match of html.matchAll(pattern)) {
    const values = result.get(match[1].toLowerCase()) ?? [];
    values.push(match[3]);
    result.set(match[1].toLowerCase(), values);
  }
  return result;
}

function referencedUrls(html) {
  const urls = [];
  const tagPattern = /<(?:a|area|audio|embed|iframe|img|link|script|source|track|video)\b[^>]*>/gi;
  for (const tag of html.matchAll(tagPattern)) {
    const values = attributes(tag[0]);
    for (const name of ["href", "src", "poster"]) urls.push(...(values.get(name) ?? []));
    for (const srcset of values.get("srcset") ?? []) {
      for (const candidate of srcset.split(",")) {
        const url = candidate.trim().split(/\s+/, 1)[0];
        if (url) urls.push(url);
      }
    }
  }
  return urls;
}

function outputPathFor(urlPath, sourceFile) {
  const decodedPath = decodeURIComponent(urlPath);
  if (decodedPath.startsWith(basePath)) {
    return resolve(distDirectory, decodedPath.slice(basePath.length));
  }
  if (decodedPath.startsWith("/")) return null;

  const sourceDirectory = dirname(relative(distDirectory, sourceFile));
  return resolve(distDirectory, sourceDirectory, decodedPath);
}

export function resolveInternalReference(value, sourceFile) {
  if (!value || ignoredSchemes.test(value) || value.startsWith("//")) return { skip: true };

  let url;
  try {
    url = new URL(
      value,
      `${siteOrigin}${basePath}${relative(distDirectory, sourceFile).split(sep).join("/")}`,
    );
  } catch {
    return { error: `invalid URL: ${value}` };
  }

  if (url.origin !== siteOrigin) return { skip: true };
  if (!url.pathname.startsWith(basePath)) {
    return { error: `does not use the configured base path: ${url.pathname}` };
  }

  let target;
  try {
    target = outputPathFor(url.pathname, sourceFile);
  } catch {
    return { error: `invalid encoded path: ${url.pathname}` };
  }
  if (!target) return { error: `does not use the configured base path: ${url.pathname}` };
  if (target !== distDirectory && !target.startsWith(`${distDirectory}${sep}`)) {
    return { error: `escapes the built site: ${url.pathname}` };
  }

  if (extname(target)) return { candidates: [target], hash: url.hash.slice(1) };
  if (url.pathname.endsWith("/")) {
    return { candidates: [join(target, "index.html")], hash: url.hash.slice(1) };
  }
  return { candidates: [join(target, "index.html"), `${target}.html`], hash: url.hash.slice(1) };
}

export function hasAnchor(html, anchor) {
  if (!anchor) return true;
  const decodedAnchor = decodeURIComponent(anchor);
  const escaped = decodedAnchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:\\bid|\\bname)=(?:"${escaped}"|'${escaped}')`).test(html);
}

function routeFromOutput(file) {
  const pathname = `/${relative(distDirectory, file).split(sep).join("/")}`;
  return pathname.endsWith("/index.html")
    ? pathname.slice(0, -"index.html".length)
    : pathname.replace(/\.html$/, "");
}

function canonicalHref(html) {
  const canonicalLink = /<link\b[^>]*rel=(?:"canonical"|'canonical')[^>]*>/i.exec(html);
  if (!canonicalLink) return null;
  return attributes(canonicalLink[0]).get("href")?.[0] ?? null;
}

async function main() {
  if (!(await exists(distDirectory)))
    throw new Error("Missing VitePress build output: .vitepress/dist");

  const htmlFiles = await collectHtmlFiles(distDirectory);
  const failures = [];
  const htmlByPath = new Map();
  for (const file of htmlFiles) htmlByPath.set(resolve(file), await readFile(file, "utf8"));

  const builtRoutes = new Set(htmlFiles.map(routeFromOutput));
  for (const route of requiredRoutes) {
    if (!builtRoutes.has(route)) failures.push(`missing required route: ${route}`);
  }
  if (!builtRoutes.has("/404")) failures.push("missing built 404.html route");

  for (const sourceFile of htmlFiles) {
    const html = htmlByPath.get(resolve(sourceFile));
    const route = routeFromOutput(sourceFile);
    const expectedCanonical = new URL(
      route === "/" ? "" : route.slice(1),
      `${siteOrigin}${basePath}`,
    ).href;
    const actualCanonical = canonicalHref(html);
    if (route !== "/404" && actualCanonical !== expectedCanonical) {
      failures.push(
        `${relative(distDirectory, sourceFile)}: expected canonical ${expectedCanonical}, got ${actualCanonical ?? "none"}`,
      );
    }

    for (const value of referencedUrls(html)) {
      const reference = resolveInternalReference(value, sourceFile);
      if (reference.error) {
        failures.push(`${relative(distDirectory, sourceFile)} -> ${value}: ${reference.error}`);
        continue;
      }
      if (reference.skip) continue;

      let target = reference.candidates.find((candidate) => htmlByPath.has(resolve(candidate)));
      if (!target) {
        for (const candidate of reference.candidates) {
          if (await exists(candidate)) {
            target = candidate;
            break;
          }
        }
      }
      if (!target) {
        failures.push(
          `${relative(distDirectory, sourceFile)} -> ${value}: missing ${reference.candidates.map((candidate) => relative(distDirectory, candidate)).join(" or ")}`,
        );
        continue;
      }
      if (reference.hash) {
        const targetHtml = htmlByPath.get(resolve(target));
        if (!targetHtml || !hasAnchor(targetHtml, reference.hash)) {
          failures.push(
            `${relative(distDirectory, sourceFile)} -> ${value}: missing anchor #${reference.hash}`,
          );
        }
      }
    }
  }

  if (failures.length > 0) {
    console.error(
      `Found ${failures.length} broken route, canonical, anchor, or asset reference(s):`,
    );
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Verified ${requiredRoutes.length} required routes, canonical URLs, anchors, and internal assets across ${htmlFiles.length} HTML files.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
