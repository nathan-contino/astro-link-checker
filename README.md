# astro-link-checker

Fast intra-site broken link checker for Astro. Runs after `astro build` and reports any `href` values that don't resolve to a real file in the build output.

External links are not checked. For those, point a tool like [lychee](https://github.com/lycheeverse/lychee) at your deployed site.

## Why faster

The common approach checks links per-file: if `/docs/get-started` is linked from 400 pages, it gets stat'd 400 times. This plugin deduplicates first, checking every unique destination exactly once regardless of how many pages reference it. File reads and existence checks all run in parallel.

## Installation

```
npm install astro-link-checker
```

## Usage

```ts
// astro.config.ts
import { defineConfig } from 'astro/config';
import linkChecker from 'astro-link-checker';

export default defineConfig({
  integrations: [linkChecker()],
});
```

## Options

```ts
linkChecker({
  // Pages to skip crawling entirely (matched against the page's URL path)
  excludeSourcePages: ['/landing/', /^\/preview\//],

  // Destinations to skip checking (matched against the normalized root-relative href)
  excludeDestinations: ['/login', '/logout', /^\/external-tool\//],

  // Throw and fail the build on broken links (default: true)
  failOnBrokenLinks: true,

  // Log every checked href, not just broken ones (default: false)
  verbose: false,
})
```

Both `excludeSourcePages` and `excludeDestinations` accept an array of strings (substring match) or `RegExp` objects (tested against the full path).

## Output

```
[link-checker] 4231 HTML files
[link-checker] 8847 unique destinations
[link-checker] done in 2.1s
[link-checker] all links ok
```

On failure:

```
[link-checker] 2 broken links:
  /docs/get-started/missing-page
    /docs/overview
    /docs/quickstarts/react
    … and 12 more
  /docs/api/old-endpoint
    /docs/api/index
```

## Notes

- Only checks `href` attributes.
- Strips anchor fragments (`#section`) before checking, so this tool has no clue whether the anchor actually exists on the target page.
- Resolves relative hrefs against their source file's location and normalizes them to root-relative paths before deduplication and matching.
