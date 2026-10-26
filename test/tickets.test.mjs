import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentBody, groupTickets, issueBody, issueTitle, planTickets, testsInBody } from '../src/tickets.js';

const report = {
  model: 'jev-1.14.0',
  run: { title: 'CI #9', url: 'https://github.com/acme/shop/actions/runs/9', attempt: 1 },
  categories: { genuine_regression: 'Genuine Regression', flaky_test: 'Flaky Assertion', api_contract_mismatch: 'API Contract Mismatch' },
};

function failure(name, file, { category = 'genuine_regression', priority = 'P1', labels = ['regression'], owners = ['@qa-sam'], unsure = false } = {}) {
  return {
    id: `${file} › ${name}`,
    name,
    file,
    suite: file,
    owners,
    message: `${name} failed`,
    details: 'at parse (src/parser.py:10)',
    jev: { category, confidence: unsure ? 0.3 : 0.98, severity: { label: 'Major' } },
    decision: { unsure, retry: false, ticket: labels ? { priority: unsure ? null : priority, labels } : null },
  };
}

test('same file and cause share an issue; different cause or file does not', () => {
  const groups = groupTickets([
    failure('a', 'tests/test_parser.py', { priority: 'P1' }),
    failure('b', 'tests/test_parser.py', { priority: 'P0', owners: ['@qa-jun'] }),
    failure('c', 'tests/test_parser.py', { category: 'flaky_test', priority: 'P3', labels: ['flaky'] }),
    failure('d', 'tests/test_other.py'),
    failure('e', 'tests/test_parser.py', { labels: null }), // re-run only: no ticket
  ]);
  assert.equal(groups.length, 3);
  const regressions = groups.find((g) => g.where === 'tests/test_parser.py' && g.labels[0] === 'regression');
  assert.deepEqual(regressions.failures.map((f) => f.name), ['a', 'b']);
  assert.equal(regressions.priority, 'P0'); // the most urgent member
  assert.deepEqual(regressions.owners, ['@qa-sam', '@qa-jun']);
});

test('unsure failures get their own needs-triage issue', () => {
  const groups = groupTickets([
    failure('a', 'e2e/cart.spec.ts'),
    failure('b', 'e2e/cart.spec.ts', { unsure: true, labels: ['needs-triage'] }),
  ]);
  assert.equal(groups.length, 2);
  const triage = groups.find((g) => g.labels.includes('needs-triage'));
  assert.equal(triage.priority, null);
  assert.equal(issueTitle(triage, report), '[ci-triage] Needs triage: e2e/cart.spec.ts › b');
});

test('titles: one test by id, several by count and file', () => {
  const [one] = groupTickets([failure('a', 'tests/x.py')]);
  const [many] = groupTickets([failure('a', 'tests/x.py'), failure('b', 'tests/x.py')]);
  assert.equal(issueTitle(one, report), '[ci-triage] Genuine Regression: tests/x.py › a');
  assert.equal(issueTitle(many, report), '[ci-triage] Genuine Regression: 2 tests in tests/x.py');
});

test('the body lists its tests in a marker that reads back', () => {
  const [group] = groupTickets([failure('a', 'tests/x.py'), failure('b --> c', 'tests/x.py')]);
  const body = issueBody(group, report);
  assert.match(body, /\*\*Genuine Regression\*\* · priority \*\*P1\*\* · 2 failing tests in `tests\/x.py`/);
  assert.match(body, /#### `a`/);
  assert.deepEqual(testsInBody(body), ['tests/x.py › a', 'tests/x.py › b --> c']);
  // "-->" in a test name can't end the HTML comment early.
  const markerLine = body.split('\n').find((l) => l.startsWith('<!-- ci-triage-tests:'));
  assert.equal(markerLine.match(/-->/g).length, 1);
});

test('a later run comments on the open issue for tests it lists, and files the rest together', () => {
  const first = groupTickets([failure('a', 'tests/x.py'), failure('b', 'tests/x.py')])[0];
  const open = [{ number: 42, body: issueBody(first, report) }];

  const again = planTickets([failure('a', 'tests/x.py'), failure('b', 'tests/x.py')], open);
  assert.deepEqual(again.comments.map((c) => [c.number, c.failures.map((f) => f.name)]), [[42, ['a', 'b']]]);
  assert.equal(again.creates.length, 0);

  const mixed = planTickets([failure('a', 'tests/x.py'), failure('new1', 'tests/x.py'), failure('new2', 'tests/x.py')], open);
  assert.deepEqual(mixed.comments.map((c) => [c.number, c.failures.map((f) => f.name)]), [[42, ['a']]]);
  assert.deepEqual(mixed.creates.map((g) => g.failures.map((f) => f.name)), [['new1', 'new2']]);
  assert.match(commentBody(mixed.comments[0].failures, report), /^Failed again in \[CI #9\]\(.+\), attempt 1: 1 test\./);
});

test('issues without a marker are ignored', () => {
  const plan = planTickets([failure('a', 'tests/x.py')], [{ number: 7, body: 'filed by hand' }, { number: 8, body: null }]);
  assert.equal(plan.comments.length, 0);
  assert.equal(plan.creates.length, 1);
});

test('a huge group stays under GitHub’s body limit and still lists every test', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ ...failure(`t${i}`, 'tests/big.py'), details: 'x'.repeat(3000) }));
  const [group] = groupTickets(many);
  const body = issueBody(group, report);
  assert.ok(body.length < 65536, `body is ${body.length} chars`);
  assert.match(body, /Too long to show here, see the triage report: .*`t39`/);
  assert.equal(testsInBody(body).length, 40);
});
