import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import linkChecker from '../index.mjs';

// Build a minimal HTML page with a given list of hrefs.
const page = (...hrefs) =>
  `<!doctype html><html><body>${hrefs.map(h => `<a href="${h}">x</a>`).join('')}</body></html>`;

// Create a temp directory populated with { 'rel/path.html': content } entries.
async function makeFixture(files) {
  const tmp = await mkdtemp(join(tmpdir(), 'alc-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tmp, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf-8');
  }
  return tmp;
}

// Run the integration hook and collect log lines + any thrown error.
async function run(tmpDir, opts = {}) {
  const integration = linkChecker({ failOnBrokenLinks: false, ...opts });
  const logs = [];
  const logger = { info: msg => logs.push(msg) };
  let threw = null;
  try {
    await integration.hooks['astro:build:done']({
      dir: pathToFileURL(tmpDir + '/'),
      logger,
    });
  } catch (e) {
    threw = e;
  }
  return { logs, threw };
}

// ── helpers to inspect results ──────────────────────────────────────────────

const lastLog = r => r.logs[r.logs.length - 1];
const isBroken = (r, href) => r.logs.some(l => l.includes(href));

// ── tests ────────────────────────────────────────────────────────────────────

test('all valid links → passes cleanly', async () => {
  const tmp = await makeFixture({
    'index.html':    page('/about', '/blog/post'),
    'about.html':    page('/'),
    'blog/post.html': page('/about'),
  });
  try {
    const r = await run(tmp);
    assert.equal(r.threw, null);
    assert.ok(lastLog(r).includes('all links ok'), `expected "all links ok", got: ${lastLog(r)}`);
  } finally { await rm(tmp, { recursive: true }); }
});

test('broken root-relative link → detected', async () => {
  const tmp = await makeFixture({
    'index.html': page('/does-not-exist'),
  });
  try {
    const r = await run(tmp);
    assert.equal(r.threw, null);
    assert.ok(isBroken(r, '/does-not-exist'), 'expected /does-not-exist in output');
  } finally { await rm(tmp, { recursive: true }); }
});

test('broken relative link → detected', async () => {
  const tmp = await makeFixture({
    'docs/index.html': page('../missing-page'),
  });
  try {
    const r = await run(tmp);
    assert.equal(r.threw, null);
    assert.ok(isBroken(r, '/missing-page'), 'expected /missing-page in output');
  } finally { await rm(tmp, { recursive: true }); }
});

test('multiple broken links → all reported', async () => {
  const tmp = await makeFixture({
    'index.html': page('/alpha', '/beta', '/gamma'),
  });
  try {
    const r = await run(tmp);
    assert.ok(isBroken(r, '/alpha'));
    assert.ok(isBroken(r, '/beta'));
    assert.ok(isBroken(r, '/gamma'));
  } finally { await rm(tmp, { recursive: true }); }
});

test('broken link reports which source pages reference it', async () => {
  const tmp = await makeFixture({
    'index.html':  page('/shared-missing'),
    'about.html':  page('/shared-missing'),
    'other.html':  page('/different-missing'),
  });
  try {
    const r = await run(tmp);
    const brokenLine = r.logs.find(l => l.includes('/shared-missing'));
    assert.ok(brokenLine, '/shared-missing not found in output');
    // Both source pages should be listed somewhere in the output
    const allOutput = r.logs.join('\n');
    assert.ok(allOutput.includes('/index') || allOutput.includes('/about'),
      'expected source pages to be listed');
  } finally { await rm(tmp, { recursive: true }); }
});

test('failOnBrokenLinks: true → throws', async () => {
  const tmp = await makeFixture({
    'index.html': page('/gone'),
  });
  try {
    const r = await run(tmp, { failOnBrokenLinks: true });
    assert.ok(r.threw instanceof Error, 'expected an Error to be thrown');
    assert.ok(r.threw.message.includes('/gone'), 'error message should mention the broken link');
  } finally { await rm(tmp, { recursive: true }); }
});

test('excludeDestinations string → excluded broken link not reported', async () => {
  const tmp = await makeFixture({
    'index.html': page('/login', '/register', '/real-page'),
    'real-page.html': page('/'),
  });
  try {
    const r = await run(tmp, {
      excludeDestinations: ['/login', '/register'],
    });
    assert.ok(!isBroken(r, '/login'), '/login should be excluded');
    assert.ok(!isBroken(r, '/register'), '/register should be excluded');
  } finally { await rm(tmp, { recursive: true }); }
});

test('excludeDestinations RegExp → excluded broken link not reported', async () => {
  const tmp = await makeFixture({
    'index.html': page('/webinar/intro', '/webinar/advanced', '/real-page'),
    'real-page.html': page('/'),
  });
  try {
    const r = await run(tmp, {
      excludeDestinations: [/^\/webinar/],
    });
    assert.ok(!isBroken(r, '/webinar/intro'), '/webinar/intro should be excluded');
    assert.ok(!isBroken(r, '/webinar/advanced'), '/webinar/advanced should be excluded');
  } finally { await rm(tmp, { recursive: true }); }
});

test('excludeSourcePages string → links on excluded pages not crawled', async () => {
  const tmp = await makeFixture({
    'landing/promo.html': page('/totally-broken'),
    'index.html':         page('/also-fine'),
    'also-fine.html':     page('/'),
  });
  try {
    const r = await run(tmp, {
      excludeSourcePages: ['/landing/'],
    });
    assert.ok(!isBroken(r, '/totally-broken'), '/totally-broken should not be found (source excluded)');
  } finally { await rm(tmp, { recursive: true }); }
});

test('excludeSourcePages RegExp → links on excluded pages not crawled', async () => {
  const tmp = await makeFixture({
    'preview/draft.html': page('/draft-only'),
    'index.html':         page('/'),
  });
  try {
    const r = await run(tmp, {
      excludeSourcePages: [/^\/preview\//],
    });
    assert.ok(!isBroken(r, '/draft-only'), '/draft-only should not be found (source excluded)');
  } finally { await rm(tmp, { recursive: true }); }
});

test('external http:// links → not checked, not reported', async () => {
  const tmp = await makeFixture({
    'index.html': page('https://example.com/no-such-page', 'http://fusionauth.io/gone'),
  });
  try {
    const r = await run(tmp);
    assert.equal(r.threw, null);
    assert.ok(lastLog(r).includes('all links ok'), 'external links should be silently skipped');
  } finally { await rm(tmp, { recursive: true }); }
});

test('fragment-only links → not checked', async () => {
  const tmp = await makeFixture({
    'index.html': page('#intro', '#nowhere-that-exists'),
  });
  try {
    const r = await run(tmp);
    assert.equal(r.threw, null);
    assert.ok(lastLog(r).includes('all links ok'), 'fragment links should be skipped');
  } finally { await rm(tmp, { recursive: true }); }
});

test('fragment stripped from internal href before checking', async () => {
  const tmp = await makeFixture({
    'index.html': page('/about#team', '/about#history'),
    'about.html': page('/'),
  });
  try {
    const r = await run(tmp);
    assert.equal(r.threw, null);
    assert.ok(lastLog(r).includes('all links ok'), '/about#section should resolve to about.html');
  } finally { await rm(tmp, { recursive: true }); }
});

test('percent-encoded external URL embedded in path → skipped', async () => {
  // Malformed link where [https://... got URL-encoded into a path segment.
  const tmp = await makeFixture({
    'index.html': page('/page/%5Bhttps:/evil.com/hijack'),
  });
  try {
    const r = await run(tmp);
    assert.equal(r.threw, null);
    assert.ok(lastLog(r).includes('all links ok'), 'encoded external URL should be skipped');
  } finally { await rm(tmp, { recursive: true }); }
});

test('/ root href → always valid', async () => {
  const tmp = await makeFixture({
    'about.html': page('/'),
  });
  try {
    const r = await run(tmp);
    assert.equal(r.threw, null);
    assert.ok(lastLog(r).includes('all links ok'), '/ should always resolve');
  } finally { await rm(tmp, { recursive: true }); }
});

test('href to directory → resolves via index.html', async () => {
  const tmp = await makeFixture({
    'index.html':       page('/blog'),
    'blog/index.html':  page('/'),
  });
  try {
    const r = await run(tmp);
    assert.equal(r.threw, null);
    assert.ok(lastLog(r).includes('all links ok'), '/blog should resolve to blog/index.html');
  } finally { await rm(tmp, { recursive: true }); }
});

test('href to .html file → resolves with .html extension', async () => {
  const tmp = await makeFixture({
    'index.html':  page('/about'),
    'about.html':  page('/'),
  });
  try {
    const r = await run(tmp);
    assert.equal(r.threw, null);
    assert.ok(lastLog(r).includes('all links ok'), '/about should resolve to about.html');
  } finally { await rm(tmp, { recursive: true }); }
});

test('deduplication: same destination linked from many pages → checked once', async () => {
  const tmp = await makeFixture({
    'a.html': page('/shared'),
    'b.html': page('/shared'),
    'c.html': page('/shared'),
    'd.html': page('/shared'),
    'e.html': page('/shared'),
  });
  try {
    const r = await run(tmp);
    // /shared appears in 5 source files but should only appear once in the broken links report
    const brokenMentions = r.logs.join('\n').split('/shared').length - 1;
    // Should mention /shared once as the broken link, then list sources separately
    assert.ok(isBroken(r, '/shared'), '/shared should be flagged');
    assert.ok(brokenMentions < 5, 'deduplicated: /shared should not appear 5 separate times as a broken link');
  } finally { await rm(tmp, { recursive: true }); }
});

test('verbose mode → logs every checked href', async () => {
  const tmp = await makeFixture({
    'index.html': page('/about'),
    'about.html': page('/'),
  });
  try {
    const r = await run(tmp, { verbose: true });
    const checkLogs = r.logs.filter(l => l.includes('✓') || l.includes('✗'));
    assert.ok(checkLogs.length > 0, 'verbose mode should log individual checks');
  } finally { await rm(tmp, { recursive: true }); }
});
