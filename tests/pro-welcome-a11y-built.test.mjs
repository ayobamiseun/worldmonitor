// Runtime proof of the welcome-page a11y invariants from #7382 against the
// prerendered page (#8690, replacing the source-text checks that were in
// tests/a11y-issue-7382-welcome-invariants.test.mjs for the parts the build
// renders). Assertions read public/pro/welcome.html and localized landings, built by
// `npm run build:pro` (#6898): it skips in a checkout that has not built
// /pro and fails when WM_EXPECT_BUILT_OUTPUT=1 says CI did.
//
// What is observed in the built markup, not the TSX:
// - the nav lockup is ONE anchor whose accessible name is the visible
//   WORLD MONITOR text (no aria-label, decorative glyphs aria-hidden), so
//   axe target-size and name-mismatch stay green;
// - the Launch CTA's aria-label equals its visible text, which the
//   prerender's critical-CSS selector also keys off;
// - footer copyright and byline sit at solid muted contrast with no
//   opacity fade, by class or inline style;
// - no Someone.ceo studio byline anywhere in the rendered chrome.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { INDEXABLE_LANDING_LOCALES } from '../shared/indexable-landing-locales.ts';
import { guardProBuiltOutput, landingBuiltOutputPath, shouldSkipProBuiltOutput } from './_lib/pro-built-output.mjs';

const skip = shouldSkipProBuiltOutput();
guardProBuiltOutput();

let cached;
const html = () => (cached ??= readFileSync(new URL('../public/pro/welcome.html', import.meta.url), 'utf8'));
const textOf = (markup) => markup.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const anchors = (markup) => [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ attrs: m[1], inner: m[2], full: m[0] }));
const section = (markup, open, close) => {
  const start = markup.indexOf(open);
  assert.notEqual(start, -1, `${open} must be in the built page`);
  const end = markup.indexOf(close, start);
  assert.notEqual(end, -1, `${close} must follow ${open}`);
  return markup.slice(start, end + close.length);
};

describe('welcome page a11y (#7382), built output', { skip }, () => {
  it('renders the nav lockup as one anchor named by its visible WORLD MONITOR text', () => {
    const nav = section(html(), '<nav data-wm-nav="primary"', '</nav>');
    const lockups = anchors(nav).filter((a) => textOf(a.inner) === 'WORLD MONITOR');
    assert.equal(lockups.length, 1, 'exactly one lockup anchor in the nav');
    const [lockup] = lockups;
    assert.doesNotMatch(lockup.attrs, /aria-label=/, 'the name must come from the visible text');
    assert.match(lockup.attrs, /href="https:\/\/worldmonitor\.app"/);
    const glyphWrapper = lockup.inner.match(/<span\b[^>]*>/);
    assert.ok(glyphWrapper && /aria-hidden="true"/.test(glyphWrapper[0]), 'the glyph wrapper is decorative');
    assert.doesNotMatch(lockup.inner, /<a\b/i, 'no nested anchor inside the lockup');
  });

  for (const locale of INDEXABLE_LANDING_LOCALES) {
    it(`keeps the ${locale.id} Launch CTA aria-label equal to its visible copy`, () => {
      const page = readFileSync(new URL(`../${landingBuiltOutputPath(locale)}`, import.meta.url), 'utf8');
      const nav = section(page, '<nav data-wm-nav="primary"', '</nav>');
      const launch = anchors(nav).filter((a) => /data-umami-event-target="welcome-nav"/.test(a.attrs));
      assert.equal(launch.length, 1, 'one Launch CTA in the nav');
      const label = launch[0].attrs.match(/aria-label="([^"]*)"/)?.[1];
      assert.ok(label, 'the Launch CTA must have an aria-label');
      assert.equal(textOf(launch[0].inner), label);
    });
  }

  it('keeps footer copyright and byline at solid muted contrast with no opacity fade', () => {
    const footer = section(html(), '<footer', '</footer>');
    assert.match(footer, /class="[^"]*\btext-xs text-wm-muted\b[^"]*"/, 'the footer text block is muted by colour');
    assert.match(footer, /©|&copy;/, 'the copyright line is rendered');
    assert.doesNotMatch(footer, /\bopacity-(?:40|60)\b/);
    assert.doesNotMatch(footer, /style="[^"]*opacity/, 'no inline opacity fade either');
  });

  it('carries no Someone.ceo studio byline in the rendered chrome', () => {
    assert.doesNotMatch(html(), /someone\.ceo/i);
  });
});
