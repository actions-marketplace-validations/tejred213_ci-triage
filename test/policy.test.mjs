import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interpret } from '../src/classify.js';
import { decide } from '../src/policy.js';

const failure = (category, confidence = 0.9, severity = 1) => ({
  id: `${category}-${confidence}-${severity}`,
  jev: { category, confidence, severity: { score: severity } },
});

test('only environment and flaky failures: re-run, and track the flaky one', () => {
  const { verdict, failures } = decide([failure('environment_or_timeout'), failure('flaky_test')]);
  assert.equal(verdict, 'retry');
  assert.deepEqual(failures.map((f) => f.decision.retry), [true, true]);
  assert.equal(failures[0].decision.ticket, null);
  assert.deepEqual(failures[1].decision.ticket, { priority: 'P3', labels: ['flaky'] });
});

test('one real bug means no re-run; environment failures are only reported', () => {
  const { verdict, failures } = decide([failure('environment_or_timeout'), failure('genuine_regression')]);
  assert.equal(verdict, 'tickets');
  assert.equal(failures[0].decision.retry, false);
  assert.equal(failures[0].decision.ticket, null);
  assert.deepEqual(failures[1].decision.ticket, { priority: 'P1', labels: ['regression'] });
});

test('priority follows severity', () => {
  const priority = (category, severity) => decide([failure(category, 0.9, severity)]).failures[0].decision.ticket.priority;
  assert.equal(priority('genuine_regression', 0.2), 'P1'); // regressions are never below P1
  assert.equal(priority('genuine_regression', 2.7), 'P0');
  assert.equal(priority('api_contract_mismatch', 0.4), 'P2');
  assert.equal(priority('api_contract_mismatch', 1.8), 'P1');
  assert.equal(priority('api_contract_mismatch', 2.9), 'P0');
});

test('an unsure answer goes to a person and blocks the re-run', () => {
  const { verdict, failures } = decide([failure('environment_or_timeout'), failure('environment_or_timeout', 0.3)]);
  assert.equal(verdict, 'tickets');
  assert.equal(failures[1].decision.unsure, true);
  assert.deepEqual(failures[1].decision.ticket, { priority: null, labels: ['needs-triage'] });
});

test('out of attempts: environment failures become needs-triage tickets', () => {
  const { verdict, failures } = decide([failure('environment_or_timeout'), failure('flaky_test')], { attempt: 3, maxAttempts: 3 });
  assert.equal(verdict, 'tickets');
  assert.deepEqual(failures[0].decision.ticket.labels, ['needs-triage', 'retries-exhausted']);
  assert.deepEqual(failures[1].decision.ticket, { priority: 'P3', labels: ['flaky'] });
});

test('a regression in code the commit never touched goes to a person', () => {
  const notTouched = { ...failure('genuine_regression', 0.9), jev: { ...failure('genuine_regression', 0.9).jev, touchesChange: 0.13 } };
  const touched = { ...failure('genuine_regression', 0.9), jev: { ...failure('genuine_regression', 0.9).jev, touchesChange: 0.94 } };
  const unknown = failure('genuine_regression', 0.9); // no changed files: no touchesChange
  const [a, b, c] = decide([notTouched, touched, unknown]).failures.map((f) => f.decision);
  assert.deepEqual([a.unsure, a.notFromChange, a.ticket.labels], [true, true, ['needs-triage']]);
  assert.deepEqual([b.notFromChange, b.ticket.priority], [false, 'P1']);
  assert.deepEqual([c.notFromChange, c.ticket.priority], [false, 'P1']);
  // Only regressions: a flaky test outside the change is still just flaky.
  const flaky = { ...failure('flaky_test'), jev: { ...failure('flaky_test').jev, touchesChange: 0.05 } };
  assert.equal(decide([flaky]).verdict, 'retry');
});

test('no failures, nothing to do', () => {
  assert.equal(decide([]).verdict, 'none');
});

test('interpret reads the answers the API returns', () => {
  const jev = interpret({
    category: { type: 'choice', choice: 'flaky_test', confidence: 0.6, probabilities: { flaky_test: 0.7, genuine_regression: 0.3 } },
    severity: { type: 'score', score: 2.2, confidence: 0.5, legend: {}, probabilities: {} },
  });
  assert.equal(jev.category, 'flaky_test');
  assert.equal(jev.severity.label, 'Major');
});
