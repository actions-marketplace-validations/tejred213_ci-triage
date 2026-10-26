import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseJUnit, uniqueIds } from '../src/junit.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/reports/${name}`, import.meta.url), 'utf8');

test('jest: failures only, with file, message and stack', () => {
  const failures = parseJUnit(fixture('jest-api.xml'));
  assert.equal(failures.length, 4);
  const refund = failures.find((f) => f.name.includes('partial amount'));
  assert.equal(refund.id, 'tests/api/payments.test.ts › payments refunds refunds a partial amount');
  assert.equal(refund.file, 'tests/api/payments.test.ts');
  assert.match(refund.message, /reading 'amount'/);
  assert.match(refund.details, /src\/payments\/refund\.ts:42/);
  // The file comes from the suite when the testcase has none.
  assert.equal(failures.find((f) => f.name.includes('atomically')).file, 'tests/db/inventory.test.ts');
  // system-err counts as output.
  assert.match(failures.find((f) => f.name.includes('ttl')).output, /ENOTFOUND redis/);
});

test('playwright: classname is the file, CDATA output is kept', () => {
  const failures = parseJUnit(fixture('playwright-e2e.xml'));
  assert.equal(failures.length, 5);
  const avatar = failures.find((f) => f.name.includes('avatar'));
  assert.equal(avatar.file, 'e2e/profile.spec.ts');
  assert.equal(avatar.id, 'e2e/profile.spec.ts › Profile › shows the avatar in the header');
  assert.match(avatar.output, /data-testid="user-avatar"/);
});

test('pytest: <error> counts, entities are decoded', () => {
  const failures = parseJUnit(fixture('pytest.xml'));
  assert.equal(failures.length, 4);
  const setup = failures.find((f) => f.kind === 'error');
  assert.equal(setup.name, 'test_password_reset_token_expires');
  assert.match(setup.message, /KeyError: 'RESET_TOKEN_SECRET'/);
  assert.match(failures[0].details, /<FlaskClient <App 'billing'>>/);
});

test('a bare <testsuite> root, empty <failure/>, ANSI colours and long text', () => {
  const long = 'x'.repeat(5000);
  const xml = `<testsuite name="unit"><testcase name="a"><failure/></testcase>
    <testcase name="b"><failure message="\u001b[31mred\u001b[39m">${long}</failure></testcase>
    <testcase name="c"/></testsuite>`;
  const failures = parseJUnit(xml);
  assert.deepEqual(failures.map((f) => f.id), ['unit › a', 'unit › b']);
  assert.equal(failures[0].message, '');
  assert.equal(failures[1].message, 'red');
  assert.ok(failures[1].details.length < 3100);
  assert.match(failures[1].details, /…\[truncated\]$/);
});

test('numeric character references are decoded', () => {
  const xml = `<testsuite name="pytest"><testcase name="t"><failure message="assert None == 50.484&#10;  comparison failed &#x2192; x">a&#10;b</failure></testcase></testsuite>`;
  const [f] = parseJUnit(xml);
  assert.equal(f.message, 'assert None == 50.484\n  comparison failed → x');
  assert.equal(f.details, 'a\nb');
});

test('uniqueIds numbers repeats', () => {
  const ids = uniqueIds([{ id: 'a' }, { id: 'a' }, { id: 'b' }]).map((f) => f.id);
  assert.deepEqual(ids, ['a', 'a (2)', 'b']);
});
