import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./', import.meta.url));
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const provenance = JSON.parse(await readFile(path.join(root, 'provenance.json'), 'utf8'));

test('integration preserves every reviewed R2 source byte without promoting historical acceptance', async () => {
  assert.equal(Object.keys(provenance.sourceFilesSha256).length, 8);
  for (const [file, expected] of Object.entries(provenance.sourceFilesSha256)) {
    const actual = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
    assert.equal(actual, expected, file);
  }
  assert.equal(provenance.scope, 'VAGOO_OWNED_INERT_FIXTURE_ONLY');
  assert.equal(provenance.sourceIntegration.nativeAtIntegratedPath, 'NOT_RUN');
  assert.equal(provenance.sourceIntegration.productRuntimeIntegration, false);
  assert.equal(provenance.recoveryAuthorization, 'NONE');
});

test('project command invokes mock files only and leaves ordinary workspace tests unchanged', async () => {
  const pkg = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'));
  const prefix = 'scripts/fixtures/vagoo-native-owned/';
  const mockCommand = `node --test --test-reporter=tap ${prefix}scripts/run-native-owned-check.test.mjs ${prefix}audit/negative-case-regressions.mjs ${prefix}integration-checks.mjs`;
  assert.equal(pkg.scripts['test:vagoo-fixture:mock'], mockCommand);
  assert.equal(pkg.scripts['pretest:vagoo-fixture:mock'], undefined);
  assert.equal(pkg.scripts['posttest:vagoo-fixture:mock'], undefined);
  assert.equal(pkg.scripts.test, provenance.sourceIntegration.originalDefaultTest);
  assert.ok(!/run-native-owned-check\.mjs(?:\s|$)|\.ps1(?:\s|$)/.test(mockCommand));
});
