import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'src/components/BreakingNewsBanner.ts'), 'utf8');

describe('BreakingNewsBanner interaction semantics', () => {
  it('keeps the alert container non-interactive and exposes a native panel action', () => {
    assert.doesNotMatch(source, /el\.setAttribute\('role',\s*'button'\)/);
    assert.doesNotMatch(source, /el\.setAttribute\('tabindex',\s*'0'\)/);
    assert.match(source, /const viewPanelBtn = document\.createElement\('button'\)/);
    assert.match(source, /viewPanelBtn\.className = 'breaking-alert-view-panel'/);
    assert.match(source, /viewPanelBtn\.setAttribute\('aria-label',\s*t\('components\.breakingNews\.viewPanel'\)\)/);
    assert.match(source, /el\.appendChild\(viewPanelBtn\);\s*el\.appendChild\(dismissBtn\);/);
  });

  it('leaves the headline as a native link and does not also trigger panel scrolling', () => {
    assert.match(source, /const headlineLink = document\.createElement\('a'\)/);
    assert.match(source, /if \(target\.closest\('\.breaking-alert-headline-link'\)\) return;/);
    assert.doesNotMatch(source, /addEventListener\('keydown'/);
  });

  it('keeps dismissal on its own named native button', () => {
    assert.match(source, /const dismissBtn = document\.createElement\('button'\)/);
    assert.match(source, /dismissBtn\.setAttribute\('aria-label',\s*t\('components\.breakingNews\.dismiss'\)\)/);
    assert.match(source, /if \(target\.closest\('\.breaking-alert-dismiss'\)\)/);
  });
});
