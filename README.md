# ci-triage

A CI gate that reads failed tests before anyone gets a ticket. [Jev](https://docs.typesafe.ai)
— TypeSafe's System One model — decides what caused each failure, and code decides what to
do about it: re-run the build when the failures are environment glitches or flaky tests,
otherwise file a ticket for the test's owner. Every run produces a one-page HTML report of
the classifications.

| Cause | What happens |
| --- | --- |
| Environment / Timeout | Re-run the failed jobs |
| Flaky Assertion | Re-run, plus a P3 ticket so the owner fixes the test |
| Genuine Regression | Ticket for the owner, P0 or P1 by severity |
| API Contract Mismatch | Ticket for the owner, P0–P2 by severity |
| Jev unsure (confidence < 0.5) | Ticket labelled `needs-triage`; nothing automatic |
| Regression, but the commit didn't touch that code | Ticket labelled `needs-triage`: it may be flaky or an indirect break, but it isn't clearly this change |

A run is re-run only when **every** failure in it would be fixed by re-running, and at most
3 attempts in total. After that, the remaining failures become `needs-triage` tickets.

## Try it

```bash
npm install
npm run demo
open demo-out/triage.html
```

`npm run demo` triages the sample reports in `fixtures/` (Jest, Playwright and pytest). With
`TYPESAFE_API_KEY` set (environment or `.env`) it asks the real Jev. Without one it uses a local
mock that answers from keyword rules, so you see the UI and the routing but not Jev's
judgment; the report says `mock (keyword rules, not Jev)` as its model.

```bash
npm test   # parser, CODEOWNERS, routing rules, and the CLI end to end against the mock
```

## Use it in GitHub Actions

1. Make your test workflow upload its JUnit XML as an artifact (Jest: `jest-junit`;
   Playwright: `reporter: [['junit', …]]`; pytest: `--junitxml`, with `-o junit_family=xunit1`
   so test cases carry their file).
2. Add `TYPESAFE_API_KEY` as a repository secret.
3. Copy [examples/ci-triage.yml](examples/ci-triage.yml) to `.github/workflows/` and point it
   at your test workflow's name and artifact. It runs when that workflow fails, calls the
   composite action in [action.yml](action.yml), and uploads `ci-triage-report` (the HTML
   report and `triage.json`).

Set `dry-run: true` first: the job log then shows the `gh` commands it would run.

Owners come from `.github/CODEOWNERS`, matched against the failing test's file. Users are
assigned; teams are mentioned in the issue body (GitHub can't assign teams). Tests that
CODEOWNERS doesn't cover go to `default-owner`.

Failures in the same file with the same cause probably share a root cause, so a run files
them as one issue (e.g. "Genuine Regression: 7 tests in tests/test_pdf_parser.py"), at the
highest priority among them. Each issue lists its tests in a hidden marker. A test that fails
again while its issue is open gets a comment on that issue; only tests no open issue lists
become a new one.

## Run it anywhere else

The two steps are plain CLIs, so any CI system can call them:

```bash
ci-triage --codeowners .github/CODEOWNERS --changed-files changed.txt --attempt 1 reports/
ci-triage-act triage-out/triage.json --repo acme/shop --run-id 812 [--dry-run]
```

`ci-triage` only reads and decides; it writes `triage-out/triage.json` and `triage.html` and
exits non-zero if Jev can't be reached (so nothing acts on guesses). `ci-triage-act` carries
out the decision with the GitHub CLI.

## How it works

```
JUnit XML ─▶ parse (code)          failed tests: message, stack/diff, output, file
          ─▶ CODEOWNERS (code)     owner of each test's file
          ─▶ Jev, one request      category (Choice) + severity (Score)
             per failure,          8 in flight at a time
             in parallel
          ─▶ policy (code)         re-run? ticket? priority?    src/policy.js
          ─▶ triage.json + triage.html + job summary
          ─▶ ci-triage-act (gh)    gh run rerun --failed / gh issue create
```

Jev never writes text here. Each failure is one request with up to three closed questions
([src/classify.js](src/classify.js)):

- `category`: which of the four causes. Each option is described by what it means, the signs
  that point to it, and what belongs to a neighbouring option instead.
- `severity`: if this were a real bug and it shipped, how bad: cosmetic, minor, major,
  critical. It's asked every time but only read for regressions and contract mismatches.
- `touches_change` (only when the changed files are known): do they include the failing
  test or code it exercises? A "regression" in code the commit never touched goes to a person
  instead of becoming a P1 for the change's author.

The state Jev sees is only what the judgment needs: the test's name and file, the error
message, the first 3,000 characters of the stack trace or diff, the last 1,500 of the test's
output, and the files the commit changed. Anything bigger is cut, because unrelated detail
in the state costs accuracy.

All thresholds live in [src/policy.js](src/policy.js), and Jev's raw probabilities are kept in
`triage.json`, so a rule can change without asking Jev again.

## Layout

```
bin/triage.mjs       classify and decide; writes triage.json + triage.html
bin/act.mjs          re-run or file tickets with gh
src/tickets.js       which failures share an issue, and what issues and comments say
src/junit.js         JUnit XML → failed tests
src/codeowners.js    CODEOWNERS → owners of a path
src/classify.js      the Jev questions, and running them concurrently
src/policy.js        routing rules and thresholds
src/report.js        report data, HTML, terminal and job-summary text
ui/report.html       the report page (data is embedded into a copy per run)
action.yml           composite GitHub Action
examples/            workflow to copy into a repository
fixtures/            sample reports, CODEOWNERS and changed files
scripts/             demo, and the mock API used by tests and the demo
```

## What's been checked

Against `jev-1.14.0` on 2026-10-25 (the version is pinned in `src/classify.js`):

- **The 13 fixtures:** 12/12 classified as intended, and the deliberately ambiguous one
  (a discount-code request that timed out) came back unsure (confidence about 0.3), so it goes
  to a person. 13 failures took 0.8 s and about 18,600 input tokens.
- **12 held-out failures** written after the questions (503, out of memory, 429, a Go
  panic, a snapshot diff, an element covered by a toast, leaked test data, a 404 from a
  renamed route, pydantic and Pact errors): 11/12. The miss was a random faker name that
  broke a slug function. Labelled flaky, Jev said regression at 0.53, which is arguable
  either way.
- **Option order:** asking with the four options reversed changed one answer in 25, the
  same borderline case.
- **A real repository:** PyMotoGP PR #1's tests run against the parser as it was before that
  PR's fix gave 7 real failures. Jev called all 7 Genuine Regression at 1.00, with or without
  the changed-files list. This run also found that pytest's `&#10;` newlines weren't being
  decoded; that's fixed. It also showed 7 failures with one root cause becoming 7 tickets,
  so tickets are now grouped by file and cause: the same run files 1 issue.
- **Real CI failures from apache/pulsar** (6 failed PR runs, 21–25 Oct 2026). Ground truth
  came from what happened next: a commit that fixed the test, a pass after only merging
  master, master being green, and Pulsar's own open `Flaky-test:` issue.
  - With category alone: 3 right, 1 unsure, and 2 flaky concurrency tests confidently
    called regressions. Their bare `expected [2] but found [3]` assertions read like bugs,
    yet the PRs never touched that code.
  - With `touches_change`: 3 right, 3 to a person, 0 confidently wrong. Those two now say
    the change didn't touch the test (0.21 and 0.13); the two real regressions scored
    0.98 and 0.96.
  - The fixtures and the PyMotoGP replay are unchanged by this rule.

That's still a small sample. Before letting it act on your
pipeline, run it with `dry-run: true` over a few weeks of your real failed runs. Tune the
option descriptions and the 0.5 threshold from those, and re-check before moving off the
pinned model version.

**Not run yet:** the action and example workflow on a real GitHub repository. They're
YAML-valid, and their scripts are tested locally with `--dry-run`.
