// Asks Jev (TypeSafe System One) what caused each failed test.
//
// Jev doesn't generate text. Each failure gets one request with two closed questions:
//   - `category`  which of the four causes it is          (Choice: probabilities + confidence)
//   - `severity`  how bad it would be as a shipped bug    (Score; speculative: only read when
//                                                          the cause is a real bug)
//   - `touches_change`  whether the commit changed the failing test or the code it runs
//                 (Noul; only asked when the changed files are known)
// Both are answered in parallel against the same state. Failures are independent, so their
// requests run concurrently; a suite's worth of failures takes about as long as a few requests.
import { choice, noul, score } from '@typesafe-ai/sdk';

export const CATEGORIES = {
  environment_or_timeout: {
    label: 'Environment / Timeout',
    describe: {
      means:
        'The test never got a fair run because something outside the code under test failed: the CI machine, the network, DNS, a database or service that was not running or not reachable, a container, missing secrets, memory or disk limits, a package download, or a timeout while setting up.',
      signs: [
        'ECONNREFUSED, ECONNRESET, ETIMEDOUT, ENOTFOUND, ERR_NAME_NOT_RESOLVED',
        '502, 503 or 504 from infrastructure, or rate limiting by an outside service',
        'out of memory, process killed, no space left on device',
        'a timeout in a setup hook, before the test reached its own assertions',
      ],
      not_this:
        'A timeout while waiting for something the application itself should show or return.',
    },
  },
  genuine_regression: {
    label: 'Genuine Regression',
    describe: {
      means:
        'The code under test is broken: it now behaves differently from what the test expects, and running the test again would fail the same way.',
      signs: [
        'an exception thrown from application code (TypeError, NullPointerException, KeyError) with a stack trace into the application',
        'an assertion receives a clearly wrong value, not merely a late one',
        'a page element, route or function that no longer exists',
        'the failing code is in `changed_files`',
      ],
      not_this: "Another service's response changed its shape or status code.",
    },
  },
  flaky_test: {
    label: 'Flaky Assertion',
    describe: {
      means:
        'The test itself is unreliable: its result depends on timing, ordering, randomness, shared state or the current date, so the same code could pass when run again.',
      signs: [
        'the received value is an earlier or in-between state, such as "Saving…" instead of "Saved"',
        'an element detached, covered or not yet visible while the page is still updating',
        'the same items in a different order',
        'values that depend on the current time, random data, fixed sleeps, or tests that ran before',
      ],
      not_this: 'A service or network outage.',
    },
  },
  api_contract_mismatch: {
    label: 'API Contract Mismatch',
    describe: {
      means:
        'A request or response between two services does not match their agreed contract: a field is missing, renamed or has another type, the status code is unexpected, or schema validation or deserialization failed.',
      signs: [
        'schema or validation errors (JSON Schema, OpenAPI, zod, pydantic)',
        'a diff of a response body where field names or types differ',
        'an unexpected 400, 404, 405, 415 or 422 from an API',
        'cannot deserialize, unknown field, expected string but got number',
      ],
      not_this:
        'The response has the right shape but a wrong value computed by our own code.',
    },
  },
};

export const SEVERITY_LABELS = ['Cosmetic', 'Minor', 'Major', 'Critical'];
const SEVERITY_LEVELS = [
  'Cosmetic: wording, styling, logging or developer tooling; users would barely notice',
  'Minor: an edge case or a secondary feature misbehaves, and users have a workaround',
  'Major: a main feature is broken or shows wrong data for many users',
  'Critical: sign-in, payments, security or data loss is affected, or the service will not start',
];

// The questions and the thresholds in policy.js were checked against this version. The
// `jev-latest` alias moves on each release, so re-check before changing it.
const MODEL = 'jev-1.14.0';
const MAX_CHANGED_FILES = 40;
// Requests in flight at once. The SDK backs off on 429s by itself.
const CONCURRENCY = 8;

export function buildRequest(failure, changedFiles = []) {
  const state = {
    test: { name: failure.name, suite: failure.suite, file: failure.file ?? undefined },
    failure: {
      type: failure.type ?? undefined,
      message: failure.message || undefined,
      details: failure.details || undefined,
    },
    test_output: failure.output || undefined,
    changed_files: changedFiles.length ? changedFiles.slice(0, MAX_CHANGED_FILES) : undefined,
  };
  const questions = {
    category: choice(
      {
        question: 'This test failed in a CI pipeline. What most likely caused the failure?',
        evidence:
          '`failure` holds the error message and the stack trace or diff. `test_output` is what the test printed, if anything. `changed_files`, when present, lists the files changed in the commit being tested.',
      },
      Object.fromEntries(Object.entries(CATEGORIES).map(([k, c]) => [k, c.describe])),
    ),
    severity: score(
      'Suppose this failure is a real bug in the application and it ships. How much harm would it do to users?',
      SEVERITY_LEVELS,
    ),
  };
  if (changedFiles.length) {
    questions.touches_change = noul(
      'Does `changed_files` include the failing test, or code that the failing test exercises?',
      {
        true: 'A changed file is the failing test itself, the class, module or package it tests, or code named in its stack trace',
        false: 'Every changed file belongs to an unrelated module, package or feature, or is only documentation',
      },
    );
  }
  return { model: MODEL, state, questions };
}

export function interpret(answers) {
  const { category, severity, touches_change } = answers;
  return {
    category: category.choice,
    confidence: category.confidence,
    probabilities: category.probabilities,
    severity: {
      score: severity.score,
      confidence: severity.confidence,
      label: SEVERITY_LABELS[Math.round(severity.score)],
    },
    touchesChange: touches_change?.noul ?? null,
  };
}

/**
 * Classify every failure. A failed request rejects the whole run: when Jev can't be reached,
 * it is better to act on nothing than to file tickets for guesses.
 */
export async function classifyAll(client, failures, changedFiles = []) {
  const results = new Array(failures.length);
  let next = 0;
  const worker = async () => {
    while (next < failures.length) {
      const i = next++;
      const started = performance.now();
      const res = await client.systemOne(buildRequest(failures[i], changedFiles));
      results[i] = {
        ...failures[i],
        jev: {
          ...interpret(res.answers),
          model: res.model,
          ms: Math.round(performance.now() - started),
          inputTokens: res.usage.input_tokens ?? 0,
        },
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, failures.length) }, worker));
  return results;
}
