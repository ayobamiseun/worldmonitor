// Lint-configuration guard by design (#8690, section 2). The contract is the
// `lint:md` script string in package.json: the non-product Markdown trees it
// must keep excluded. The only runtime for that string is markdownlint
// itself, and running it over the repository to prove an exclusion would
// cost minutes for a check a string comparison answers exactly.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));
const lintMdScript = packageJson.scripts?.['lint:md'] ?? '';

describe('markdown lint script scope', () => {
  it('excludes non-product markdown trees from lint target', () => {
    assert.match(lintMdScript, /markdownlint-cli2/);
    assert.match(lintMdScript, /'!\.agent\/\*\*'/);
    assert.match(lintMdScript, /'!\.agents\/\*\*'/);
    assert.match(lintMdScript, /'!\.claude\/\*\*'/);
    assert.match(lintMdScript, /'!\.factory\/\*\*'/);
    assert.match(lintMdScript, /'!\.windsurf\/\*\*'/);
    assert.match(lintMdScript, /'!skills\/\*\*'/);
    assert.match(lintMdScript, /'!docs\/internal\/\*\*'/);
    assert.match(lintMdScript, /'!docs\/Docs_To_Review\/\*\*'/);
  });
});
