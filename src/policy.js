// What to do about each classified failure, and about the run as a whole. This is the only
// place routing rules live; Jev's answers are kept as they are so a rule can change without
// asking again.
//
//   Environment / Timeout   re-run the failed jobs
//   Flaky Assertion         re-run, and a P3 ticket so the owner can fix the test
//   Genuine Regression      ticket for the owner, P0 or P1 by severity
//   API Contract Mismatch   ticket for the owner, P0–P2 by severity
//   Jev unsure              ticket labelled needs-triage; nothing automatic
//   Regression, but the commit didn't touch that code: needs-triage too. It may be flaky or
//                           broken by something indirect, but it isn't clearly this change.
//
// A run is re-run only when every failure in it would be fixed by re-running, and only up to
// MAX_ATTEMPTS. The thresholds are starting points: tune them on your own pipeline's history.

// Below this, Jev's read of the cause isn't clear enough to act on.
export const MIN_CONFIDENCE = 0.5;
// Below this, the changed files don't touch the failing test or the code it runs.
const UNRELATED_TO_CHANGE = 0.3;
export const MAX_ATTEMPTS = 3;
// Severity is a 0–3 Score: cosmetic, minor, major, critical.
const CRITICAL = 2.5;
const MAJOR = 1.5;

function decideOne(jev) {
  if (jev.confidence < MIN_CONFIDENCE) {
    return { unsure: true, retryable: false, ticket: { priority: null, labels: ['needs-triage'] } };
  }
  // Seen on apache/pulsar: flaky concurrency tests whose bare assertions read like regressions,
  // in PRs that never touched them.
  if (jev.category === 'genuine_regression' && jev.touchesChange != null && jev.touchesChange < UNRELATED_TO_CHANGE) {
    return { unsure: true, notFromChange: true, retryable: false, ticket: { priority: null, labels: ['needs-triage'] } };
  }
  const severity = jev.severity.score;
  switch (jev.category) {
    case 'environment_or_timeout':
      return { unsure: false, retryable: true, ticket: null };
    case 'flaky_test':
      return { unsure: false, retryable: true, ticket: { priority: 'P3', labels: ['flaky'] } };
    case 'genuine_regression':
      return {
        unsure: false,
        retryable: false,
        ticket: { priority: severity >= CRITICAL ? 'P0' : 'P1', labels: ['regression'] },
      };
    case 'api_contract_mismatch':
      return {
        unsure: false,
        retryable: false,
        ticket: {
          priority: severity >= CRITICAL ? 'P0' : severity >= MAJOR ? 'P1' : 'P2',
          labels: ['api-contract'],
        },
      };
  }
  throw new Error(`unknown category ${jev.category}`);
}

/**
 * @param {object[]} failures classified failures (each with `.jev`)
 * @returns {{verdict: 'retry'|'tickets'|'none', failures: object[]}}
 */
export function decide(failures, { attempt = 1, maxAttempts = MAX_ATTEMPTS } = {}) {
  if (!failures.length) return { verdict: 'none', failures };
  const decided = failures.map((f) => ({ f, d: decideOne(f.jev) }));
  const allRetryable = decided.every(({ d }) => d.retryable);
  const verdict = allRetryable && attempt < maxAttempts ? 'retry' : 'tickets';

  return {
    verdict,
    failures: decided.map(({ f, d }) => {
      let { ticket } = d;
      // Still failing after the last re-run: the "glitch" isn't one. A person looks.
      if (allRetryable && verdict !== 'retry' && !ticket) {
        ticket = { priority: null, labels: ['needs-triage', 'retries-exhausted'] };
      }
      return { ...f, decision: { unsure: d.unsure, notFromChange: d.notFromChange ?? false, retry: verdict === 'retry', ticket } };
    }),
  };
}
