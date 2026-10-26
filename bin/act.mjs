#!/usr/bin/env node
// Carry out a triage decision with the GitHub CLI (gh): re-run the failed jobs, and file
// tickets for the tests' owners.
//
//   ci-triage-act triage-out/triage.json --repo acme/shop --run-id 123456 [--dry-run]
//
// Failures in one file with one cause share an issue; a test that's already on an open issue
// gets a comment there instead (src/tickets.js). gh needs GH_TOKEN with actions:write and
// issues:write.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { commentBody, issueBody, issueTitle, planTickets } from '../src/tickets.js';

// More new issues than this in one run is probably one root cause spread over many files; the
// rest are in the report instead of the issue tracker.
const MAX_NEW_ISSUES = 20;
const LABEL_COLORS = {
  'ci-triage': '5319e7',
  regression: 'b60205',
  'api-contract': 'd93f0b',
  flaky: 'fbca04',
  'needs-triage': 'c5def5',
  'retries-exhausted': 'bfdadc',
  P0: 'b60205',
  P1: 'd93f0b',
  P2: 'fbca04',
  P3: 'c2e0c6',
};

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' },
    'run-id': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (positionals.length !== 1 || !opts.repo) {
  console.error('usage: ci-triage-act <triage.json> --repo <owner/name> [--run-id <id>] [--dry-run]');
  process.exit(2);
}
const report = JSON.parse(readFileSync(positionals[0], 'utf8'));
const dryRun = opts['dry-run'];
let failed = 0;

const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
function gh(args, input) {
  if (dryRun) {
    console.log(`$ gh ${args.map(quote).join(' ')}`);
    if (input) console.log(input.replace(/^/gm, '  │ '));
    return '';
  }
  return execFileSync('gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
}
function attempt(what, fn) {
  try {
    return fn();
  } catch (err) {
    failed++;
    console.error(`ci-triage-act: ${what} failed: ${err.message}`);
    return undefined;
  }
}

if (report.verdict === 'retry') {
  if (!opts['run-id']) {
    console.error('ci-triage-act: verdict is retry but no --run-id was given');
    failed++;
  } else {
    attempt('re-run', () => gh(['run', 'rerun', opts['run-id'], '--failed', '--repo', opts.repo]));
    console.log(`Re-running failed jobs of run ${opts['run-id']}.`);
  }
}

const ticketed = report.failures.filter((f) => f.decision.ticket);
if (ticketed.length) {
  const json = (out, fallback) => (out ? JSON.parse(out) : fallback);
  const existingLabels = new Set(
    json(attempt('list labels', () => gh(['label', 'list', '--repo', opts.repo, '--limit', '500', '--json', 'name'])), []).map((l) => l.name),
  );
  const openIssues = json(
    attempt('list issues', () =>
      gh(['issue', 'list', '--repo', opts.repo, '--label', 'ci-triage', '--state', 'open', '--limit', '500', '--json', 'number,body']),
    ),
    [],
  );
  const plan = planTickets(report.failures, openIssues);

  for (const { number, failures } of plan.comments) {
    attempt(`comment on #${number}`, () =>
      gh(['issue', 'comment', String(number), '--repo', opts.repo, '--body-file', '-'], commentBody(failures, report)),
    );
  }

  for (const group of plan.creates.slice(0, MAX_NEW_ISSUES)) {
    const labels = ['ci-triage', ...group.labels, ...(group.priority ? [group.priority] : [])];
    for (const label of labels.filter((l) => !existingLabels.has(l))) {
      attempt(`create label ${label}`, () =>
        gh(['label', 'create', label, '--repo', opts.repo, '--color', LABEL_COLORS[label] ?? 'ededed']),
      );
      existingLabels.add(label);
    }
    // Teams can't be assignees; they're mentioned in the body instead.
    const assignees = group.owners.filter((o) => o.startsWith('@') && !o.includes('/')).map((o) => o.slice(1));
    attempt(`open issue for ${group.where}`, () =>
      gh(
        ['issue', 'create', '--repo', opts.repo, '--title', issueTitle(group, report), '--body-file', '-',
          '--label', labels.join(','), ...(assignees.length ? ['--assignee', assignees.join(',')] : [])],
        issueBody(group, report),
      ),
    );
  }
  for (const group of plan.creates.slice(MAX_NEW_ISSUES)) {
    console.log(`Not filing ${group.failures.length} failure(s) in ${group.where}: already opened ${MAX_NEW_ISSUES} issues for this run.`);
  }
}

if (report.verdict !== 'retry' && !ticketed.length) console.log('Nothing to do.');
process.exit(failed ? 1 : 0);
