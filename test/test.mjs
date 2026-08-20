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

// Build a page with explicit id anchors.
const pageWithIds = (ids, ...hrefs) => {
  const anchors = ids.map(id => `<h2 id="${id}">${id}</h2>`).join('');
  return `<!doctype html><html><body>${anchors}${hrefs.map(h => `<a href="${h}">x</a>`).join('')}</body></html>`;
};

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
// _exit is injected so failOnBrokenLinks:true is testable without killing the process.
async function run(tmpDir, opts = {}) {
  const logs = [];
  const integration = linkChecker({
    failOnBrokenLinks: false,
    ...opts,
    _exit: () => { throw new Error(logs[logs.length - 1] ?? 'exit'); },
  });
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

// ── page link tests ──────────────────────────────────────────────────────────

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

// ── anchor tests ──────────────────────────────────────────────────────────────

test('fragment-only links: no ids on page → broken', async () => {
  const tmp = await makeFixture({
    'index.html': page('#nowhere'),
  });
  try {
    const r = await run(tmp);
    assert.ok(isBroken(r, '/#nowhere'), 'same-page anchor should be checked and reported broken');
  } finally { await rm(tmp, { recursive: true }); }
});

test('fragment-only links: matching id on page → ok', async () => {
  const tmp = await makeFixture({
    'index.html': pageWithIds(['intro'], '#intro'),
  });
  try {
    const r = await run(tmp);
    assert.equal(r.threw, null);
    assert.ok(lastLog(r).includes('all links ok'), '#intro exists on the page, should pass');
  } finally { await rm(tmp, { recursive: true }); }
});

test('cross-page anchor: matching id on target → ok', async () => {
  const tmp = await makeFixture({
    'index.html': page('/about#team', '/about#history'),
    'about.html': pageWithIds(['team', 'history']),
  });
  try {
    const r = await run(tmp);
    assert.equal(r.threw, null);
    assert.ok(lastLog(r).includes('all links ok'), '/about#team and /about#history should pass');
  } finally { await rm(tmp, { recursive: true }); }
});

test('cross-page anchor: missing id on target → broken', async () => {
  const tmp = await makeFixture({
    'index.html': page('/about#team'),
    'about.html': page('/'),
  });
  try {
    const r = await run(tmp);
    assert.ok(isBroken(r, '/about#team'), '/about#team should be flagged (no id="team" on about page)');
  } finally { await rm(tmp, { recursive: true }); }
});

test('anchor on missing page → page error reported, anchor not double-reported', async () => {
  const tmp = await makeFixture({
    'index.html': page('/gone#section'),
  });
  try {
    const r = await run(tmp);
    // /gone should be reported as a broken page
    assert.ok(isBroken(r, '/gone'), '/gone page should be reported as broken');
    // /gone#section should NOT be separately reported (page already missing)
    assert.ok(!isBroken(r, '/gone#section'), '/gone#section should not be double-reported');
  } finally { await rm(tmp, { recursive: true }); }
});

test('checkAnchors: false → fragment-only links not checked', async () => {
  const tmp = await makeFixture({
    'index.html': page('#nowhere-that-exists'),
  });
  try {
    const r = await run(tmp, { checkAnchors: false });
    assert.equal(r.threw, null);
    assert.ok(lastLog(r).includes('all links ok'), 'fragment links should be skipped when checkAnchors is false');
  } finally { await rm(tmp, { recursive: true }); }
});

test('checkAnchors: false → cross-page anchors not checked', async () => {
  const tmp = await makeFixture({
    'index.html': page('/about#team', '/about#history'),
    'about.html': page('/'),
  });
  try {
    const r = await run(tmp, { checkAnchors: false });
    assert.equal(r.threw, null);
    assert.ok(lastLog(r).includes('all links ok'), '/about#section should not be checked when checkAnchors is false');
  } finally { await rm(tmp, { recursive: true }); }
});

test('legacy <a name="..."> anchors are valid targets', async () => {
  const tmp = await makeFixture({
    'index.html': page('/about#legacy'),
    'about.html': `<!doctype html><html><body><a name="legacy">section</a></body></html>`,
  });
  try {
    const r = await run(tmp);
    assert.equal(r.threw, null);
    assert.ok(lastLog(r).includes('all links ok'), '<a name="legacy"> should count as a valid anchor target');
  } finally { await rm(tmp, { recursive: true }); }
});

test('anchor in excluded destination → not checked', async () => {
  const tmp = await makeFixture({
    'index.html': page('/login#form'),
  });
  try {
    const r = await run(tmp, {
      excludeDestinations: ['/login'],
    });
    assert.equal(r.threw, null);
    assert.ok(lastLog(r).includes('all links ok'), '/login#form should be skipped (destination excluded)');
  } finally { await rm(tmp, { recursive: true }); }
});

test('anchor on excluded source page → not checked', async () => {
  const tmp = await makeFixture({
    'landing/promo.html': page('/about#team'),
    'about.html': page('/'),
  });
  try {
    const r = await run(tmp, {
      excludeSourcePages: ['/landing/'],
    });
    assert.equal(r.threw, null);
    assert.ok(lastLog(r).includes('all links ok'), 'anchor on excluded source page should not be checked');
  } finally { await rm(tmp, { recursive: true }); }
});

test('verbose mode → logs anchor checks', async () => {
  const tmp = await makeFixture({
    'index.html': page('#intro'),
    'about.html': pageWithIds(['team'], '/about#team'),
  });
  try {
    const r = await run(tmp, { verbose: true });
    const anchorLogs = r.logs.filter(l => (l.includes('✓') || l.includes('✗')) && l.includes('#'));
    assert.ok(anchorLogs.length > 0, 'verbose mode should log anchor checks');
  } finally { await rm(tmp, { recursive: true }); }
});
