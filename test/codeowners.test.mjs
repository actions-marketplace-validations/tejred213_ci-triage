import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCodeowners } from '../src/codeowners.js';

const ownersOf = parseCodeowners(`
# comment
*                     @everyone
*.py                  @python   # trailing comment
/tests/api/           @api
docs/*                @docs
e2e/**/smoke.spec.ts  @smoke
/e2e/login.spec.ts    @login
apps/                 @apps
`);

test('the last matching rule wins', () => {
  assert.deepEqual(ownersOf('tests/api/orders.test.ts'), ['@api']);
  assert.deepEqual(ownersOf('tests/api/v2/orders.py'), ['@api']);
  assert.deepEqual(ownersOf('tests/other.py'), ['@python']);
  assert.deepEqual(ownersOf('README.md'), ['@everyone']);
});

test('anchoring, directories and globs', () => {
  // A leading slash ties the pattern to the root.
  assert.deepEqual(ownersOf('nested/tests/api/x.ts'), ['@everyone']);
  // A pattern with only a trailing slash matches that directory anywhere.
  assert.deepEqual(ownersOf('packages/apps/x.ts'), ['@apps']);
  // docs/* owns direct children only.
  assert.deepEqual(ownersOf('docs/intro.md'), ['@docs']);
  assert.deepEqual(ownersOf('docs/guides/intro.md'), ['@everyone']);
  assert.deepEqual(ownersOf('e2e/smoke.spec.ts'), ['@smoke']);
  assert.deepEqual(ownersOf('e2e/a/b/smoke.spec.ts'), ['@smoke']);
  assert.deepEqual(ownersOf('./e2e/login.spec.ts'), ['@login']);
});

test('no rules, no owners', () => {
  assert.deepEqual(parseCodeowners('# nothing')('a.ts'), []);
});
