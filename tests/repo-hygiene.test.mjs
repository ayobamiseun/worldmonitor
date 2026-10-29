// Repository-hygiene guard by design (#8690, section 2). What is checked is
// the tracked file set (via git ls-files) and the Mintlify ignore list, so
// archival backlog and playground artifacts never return to the repo root or
// the published docs. There is no behaviour to execute; the tracked tree is
// the contract.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function trackedFiles(patterns) {
  const output = execFileSync('git', ['ls-files', ...patterns], {
    cwd: root,
    encoding: 'utf8',
  });
  return output.trim().split('\n').filter(Boolean);
}

test('archival backlog and playground artifacts are not tracked in the repo root', () => {
  const trackedRootArchiveMaterial = trackedFiles([
    'todos/*',
    'plans/*',
    'brief-palette-playground.html',
  ]);

  assert.deepEqual(
    trackedRootArchiveMaterial,
    [],
    `Archive-only material belongs under docs/archive or docs/dev-artifacts, not the repo root:\n${trackedRootArchiveMaterial.join('\n')}`,
  );
});

test('archival backlog and playground artifacts are excluded from Mintlify publishing', () => {
  const mintignore = readFileSync(new URL('../docs/.mintignore', import.meta.url), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  assert.ok(
    mintignore.includes('archive/'),
    'docs/archive contains internal plans/todos that Mintlify parses as MDX unless ignored',
  );
  assert.ok(
    mintignore.includes('dev-artifacts/'),
    'docs/dev-artifacts contains internal HTML/playgrounds that should not be published by Mintlify',
  );
});
