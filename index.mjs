/**
 * astro-link-checker
 *
 * Fast intra-site broken link and anchor checker for Astro. Runs after build.
 *
 * Algorithm:
 *   1. Walk the build output directory in parallel to collect all .html files.
 *   2. Read all files concurrently; extract href attributes and id attributes.
 *   3. Build linkMap<normalizedPath, Set<sourceUrl>>,
 *      fragmentMap<targetUrlPath, Map<fragment, Set<sourceUrl>>>,
 *      and idCache<urlPath, Set<id>>.
 *      A destination linked from 500 pages is stat'd exactly once.
 *   4. Check all unique path destinations in parallel with fs.access.
 *   5. Check all anchor fragments against idCache.
 *   6. Report broken links and anchors grouped by destination.
 *
 * External links are not checked. Use a dedicated HTTP checker for those.
 *
 * Usage (astro.config.ts):
 *
 *   import linkChecker from 'astro-link-checker';
 *   export default defineConfig({
 *     integrations: [linkChecker()],
 *   });
 *
 * Options:
 *   excludeSourcePages    {(string|RegExp)[]}  skip pages whose URL path matches
 *   excludeDestinations   {(string|RegExp)[]}  skip destinations whose path matches
 *   failOnBrokenLinks     {boolean}            throw on any broken link (default: true)
 *   checkAnchors          {boolean}            validate #fragment targets (default: true)
 *   verbose               {boolean}            log every checked href (default: false)
 */

import { readdir, readFile, access } from 'node:fs/promises';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

// Concurrency pool: runs at most `limit` tasks simultaneously.
function makePool(limit) {
  let active = 0;
  const queue = [];
  const flush = () => {
    while (active < limit && queue.length) {
      active++;
      const { fn, res, rej } = queue.shift();
      fn().then(res, rej).finally(() => { active--; flush(); });
    }
  };
  return fn => new Promise((res, rej) => { queue.push({ fn, res, rej }); flush(); });
}

// Test a value against an array of strings (prefix match) or RegExps.
function matches(value, patterns) {
  return patterns.some(p => p instanceof RegExp ? p.test(value) : value.startsWith(String(p)));
}

// Walk a directory tree in parallel, collecting .html file paths.
async function walkHtml(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return []; }
  const parts = await Promise.all(
    entries.map(e => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return walkHtml(p);
      return e.name.endsWith('.html') ? [p] : [];
    })
  );
  return parts.flat();
}

// Derive the URL path for a built HTML file.
//   dist/docs/get-started/intro.html  → /docs/get-started/intro
//   dist/docs/index.html              → /docs
//   dist/index.html                   → /
function fileToUrlPath(htmlFile, buildDir) {
  const rel = relative(buildDir, htmlFile).replace(/\\/g, '/');
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return '/' + rel.slice(0, -'/index.html'.length);
  if (rel.endsWith('.html')) return '/' + rel.slice(0, -5);
  return '/' + rel;
}

// Extract all href attribute values from HTML.
// Strips comments, <script>, and <style> first to avoid false matches.
function extractHrefs(html) {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const re = /\bhref=(["'])([^"']{1,2048}?)\1/gi;
  const hrefs = [];
  let m;
  while ((m = re.exec(stripped)) !== null) hrefs.push(m[2]);
  return hrefs;
}

// Extract all id attribute values and legacy <a name="..."> anchors from HTML.
function extractIds(html) {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const ids = new Set();
  const reId = /\bid=(["'])([^"']{1,512}?)\1/gi;
  let m;
  while ((m = reId.exec(stripped)) !== null) ids.add(m[2]);
  // legacy <a name="..."> anchors
  const reName = /<a\b[^>]*\bname=(["'])([^"']{1,512}?)\1/gi;
  while ((m = reName.exec(stripped)) !== null) ids.add(m[2]);
  return ids;
}

// Normalize an href to {path, fragment} or null if it should be skipped.
// path is the root-relative page path, or null for fragment-only links (current page).
// fragment is the #anchor string without the leading '#', or null if no fragment.
function normalizeHref(href, htmlFile, buildDir) {
  if (!href) return null;
  // Skip external and special-scheme links entirely.
  if (/^(?:https?:\/\/|\/\/|mailto:|tel:|javascript:|data:)/i.test(href)) return null;

  // URL-decode and re-check — catches malformed links where an external URL was
  // percent-encoded into a path, e.g. /page/%5Bhttps:/example.com
  let decoded = href;
  try { decoded = decodeURIComponent(href); } catch { return null; }
  if (/(?:https?:|\/\/)/i.test(decoded.split('/').pop())) return null;
  // Decoded brackets or pipes indicate a malformed link, not a real path.
  if (/[[\]|\\]/.test(decoded)) return null;

  const hashIdx = href.indexOf('#');
  const fragment = hashIdx >= 0 ? href.slice(hashIdx + 1).split('?')[0] || null : null;
  const bare = href.split('#')[0].split('?')[0];

  // Fragment-only link — target path is resolved by caller to the current page.
  if (!bare) return fragment ? { path: null, fragment } : null;

  let path;
  if (bare.startsWith('/')) {
    path = bare;
  } else {
    // Relative href — resolve against the file's location, then make root-relative.
    const abs = resolve(dirname(htmlFile), bare);
    const rel = relative(buildDir, abs).replace(/\\/g, '/');
    if (rel.startsWith('..')) return null; // outside build dir
    path = '/' + rel;
  }

  return { path, fragment };
}

// Check whether a root-relative path resolves to any real file in the build output.
async function checkExists(norm, buildDir) {
  if (!norm || norm === '/') return true;
  const base = join(buildDir, norm.slice(1));
  const ok = p => access(p).then(() => true, () => false);
  const [plain, html, idx] = await Promise.all([
    ok(base),
    ok(base + '.html'),
    ok(join(base, 'index.html')),
  ]);
  return plain || html || idx;
}

export default function linkChecker(opts = {}) {
  const {
    excludeSourcePages  = [],
    excludeDestinations = [],
    failOnBrokenLinks   = true,
    checkAnchors        = true,
    verbose             = false,
    _exit               = process.exit,
  } = opts;

  return {
    name: 'astro-link-checker',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const t0 = Date.now();
        const buildDir = dir instanceof URL ? fileURLToPath(dir) : String(dir);
        const log = msg => (logger ? logger.info(msg) : console.log(msg));

        // Phase 1: discover all HTML files.
        const htmlFiles = await walkHtml(buildDir);
        log(`[link-checker] ${htmlFiles.length} HTML files`);

        // Phase 2: extract hrefs, fragments, and ids across all pages.
        // linkMap:     normPath    → Set<sourceUrlPath>
        // fragmentMap: targetPath  → Map<fragment, Set<sourceUrlPath>>
        // idCache:     urlPath     → Set<id>
        const linkMap     = new Map();
        const fragmentMap = new Map();
        const idCache     = new Map();
        const pool = makePool(200);

        await Promise.all(
          htmlFiles.map(file =>
            pool(async () => {
              const urlPath = fileToUrlPath(file, buildDir);
              if (matches(urlPath, excludeSourcePages)) return;

              const html = await readFile(file, 'utf-8');
              if (checkAnchors) idCache.set(urlPath, extractIds(html));

              for (const raw of extractHrefs(html)) {
                const result = normalizeHref(raw, file, buildDir);
                if (!result) continue;

                const { path: normPath, fragment } = result;
                // Fragment-only links resolve to the current page.
                const resolvedPath = normPath ?? urlPath;

                if (matches(resolvedPath, excludeDestinations)) continue;

                if (normPath !== null) {
                  let sources = linkMap.get(normPath);
                  if (!sources) { sources = new Set(); linkMap.set(normPath, sources); }
                  sources.add(urlPath);
                }

                if (fragment !== null && checkAnchors) {
                  let fragsByPath = fragmentMap.get(resolvedPath);
                  if (!fragsByPath) { fragsByPath = new Map(); fragmentMap.set(resolvedPath, fragsByPath); }
                  let fragSources = fragsByPath.get(fragment);
                  if (!fragSources) { fragSources = new Set(); fragsByPath.set(fragment, fragSources); }
                  fragSources.add(urlPath);
                }
              }
            })
          )
        );

        const uniqueCount = linkMap.size;
        log(`[link-checker] ${uniqueCount} unique destinations`);

        // Phase 3: check every unique path destination exactly once.
        const broken = [];
        await Promise.all(
          [...linkMap.entries()].map(async ([norm, sources]) => {
            const ok = await checkExists(norm, buildDir);
            if (verbose) log(`[link-checker] ${ok ? '✓' : '✗'} ${norm}`);
            if (!ok) broken.push({ href: norm, sources: [...sources].sort() });
          })
        );

        // Phase 4: check anchor fragments against the id sets of their target pages.
        if (checkAnchors && fragmentMap.size > 0) {
          await Promise.all(
            [...fragmentMap.entries()].map(async ([targetPath, fragMap]) => {
              // Skip anchor checking for pages that don't exist (already reported as broken).
              if (!(await checkExists(targetPath, buildDir))) return;

              // idCache keys have no trailing slash; normalize the lookup.
              const idKey = targetPath !== '/' && targetPath.endsWith('/')
                ? targetPath.slice(0, -1)
                : targetPath;
              let ids = idCache.get(idKey);

              if (!ids) {
                // Page exists but wasn't crawled (e.g. excluded source page) — read it now.
                const base = join(buildDir, targetPath.replace(/^\//, ''));
                for (const p of [base + '.html', join(base, 'index.html'), base]) {
                  try { ids = extractIds(await readFile(p, 'utf-8')); break; }
                  catch { /* try next */ }
                }
                if (!ids) return;
              }

              for (const [fragment, sources] of fragMap.entries()) {
                if (ids.has(fragment)) {
                  if (verbose) log(`[link-checker] ✓ ${targetPath}#${fragment}`);
                } else {
                  if (verbose) log(`[link-checker] ✗ ${targetPath}#${fragment}`);
                  broken.push({ href: `${targetPath}#${fragment}`, sources: [...sources].sort() });
                }
              }
            })
          );
        }

        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        log(`[link-checker] done in ${elapsed}s`);

        if (broken.length === 0) {
          log(`[link-checker] all links ok`);
          return;
        }

        broken.sort((a, b) => a.href.localeCompare(b.href));
        const report = broken
          .map(({ href, sources }) => {
            const shown = sources.slice(0, 5).join('\n    ');
            const more = sources.length > 5 ? `\n    … and ${sources.length - 5} more` : '';
            return `  ${href}\n    ${shown}${more}`;
          })
          .join('\n');

        const msg = `[link-checker] ${broken.length} broken link${broken.length === 1 ? '' : 's'}:\n${report}`;
        log(msg);
        if (failOnBrokenLinks) _exit(1);
      },
    },
  };
}
