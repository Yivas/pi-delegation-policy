import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = resolve(siteDirectory, "dist");
const basePath = "/pi-delegation-policy/";
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

function pathnameFrom(value) {
  const pathname = value.split(/[?#]/, 1)[0] ?? "";
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function candidatesFor(value, sourceFile) {
  const pathname = pathnameFrom(value);
  if (!pathname || pathname.startsWith("#") || ignoredSchemes.test(pathname))
    return { candidates: [] };
  if (/^(?:https?:)?\/\//i.test(pathname)) return { candidates: [] };

  let relativeTarget;
  if (pathname.startsWith("/")) {
    if (!pathname.startsWith(basePath)) {
      return { error: `does not use the configured base path: ${pathname}` };
    }
    relativeTarget = pathname.slice(basePath.length);
  } else {
    const sourceDirectory = dirname(relative(sourceFile, distDirectory));
    relativeTarget = normalize(join(sourceDirectory, pathname));
  }

  const target = resolve(distDirectory, relativeTarget);
  if (
    target !== distDirectory &&
    !target.startsWith(`${distDirectory}/`) &&
    !target.startsWith(`${distDirectory}\\`)
  ) {
    return { error: `escapes the built site: ${pathname}` };
  }

  if (extname(target)) return { candidates: [target] };
  return { candidates: [join(target, "index.html"), `${target}.html`] };
}

function linkedValues(html) {
  const values = [];
  const attributePattern = /(?:href|src)\s*=\s*(["'])(.*?)\1/gi;
  for (const match of html.matchAll(attributePattern)) values.push(match[2]);

  const srcsetPattern = /srcset\s*=\s*(["'])(.*?)\1/gi;
  for (const match of html.matchAll(srcsetPattern)) {
    for (const candidate of match[2].split(",")) values.push(candidate.trim().split(/\s+/, 1)[0]);
  }
  return values.filter(Boolean);
}

const requiredFiles = [join(distDirectory, "index.html"), join(distDirectory, "404.html")];
for (const file of requiredFiles) {
  if (!(await exists(file)))
    throw new Error(`Missing required build output: ${relative(distDirectory, file)}`);
}

const htmlFiles = await collectHtmlFiles(distDirectory);
const failures = [];
for (const sourceFile of htmlFiles) {
  const html = await readFile(sourceFile, "utf8");
  for (const value of linkedValues(html)) {
    const reference = candidatesFor(value, sourceFile);
    if (reference.error) {
      failures.push(`${relative(distDirectory, sourceFile)} -> ${value}: ${reference.error}`);
      continue;
    }
    if (
      reference.candidates.length > 0 &&
      !(await Promise.all(reference.candidates.map((candidate) => exists(candidate)))).some(Boolean)
    ) {
      const expected = reference.candidates
        .map((candidate) => relative(distDirectory, candidate))
        .join(" or ");
      failures.push(`${relative(distDirectory, sourceFile)} -> ${value}: missing ${expected}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Found ${failures.length} broken internal reference(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Verified internal links and assets across ${htmlFiles.length} HTML files.`);
