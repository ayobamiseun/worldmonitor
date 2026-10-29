// Source guard by design (#8690, section 2). The thermal escalation handler
// must read the seeded Redis key and never call NASA FIRMS from the edge:
// FIRMS is rate-limited per key and the seeder owns that budget. Which
// upstream a handler references is a property of its imports and URL
// literals; the handler's read path runs in the thermal runtime suites.
//
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

describe('thermal escalation handler guardrails', () => {
  it('reads seeded Redis data instead of calling FIRMS directly', () => {
    const src = readFileSync(join(root, 'server/worldmonitor/thermal/v1/list-thermal-escalations.ts'), 'utf8');
    assert.match(src, /getCachedJson\(REDIS_CACHE_KEY, true\)/);
    assert.doesNotMatch(src, /firms\.modaps\.eosdis\.nasa\.gov/i);
    assert.doesNotMatch(src, /\bcachedFetchJson\b/);
    assert.doesNotMatch(src, /\bfetch\(/);
  });
});
