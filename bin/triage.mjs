#!/usr/bin/env node
// Classify the failed tests in JUnit reports and decide what to do about them.
//
//   ci-triage reports/                      # files or directories of JUnit XML
//   ci-triage --changed-files changed.txt --attempt 2 reports/*.xml
//
// Writes triage.json (for ci-triage-act) and triage.html (the report) to --out. Takes no
// action itself. Needs TYPESAFE_API_KEY, in the environment or in .env.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { classifyAll } from '../src/classify.js';
import { parseCodeowners } from '../src/codeowners.js';
import { parseJUnit, uniqueIds } from '../src/junit.js';
import { MAX_ATTEMPTS, decide } from '../src/policy.js';
import { buildReport, markdownSummary, renderHtml, terminalSummary } from '../src/report.js';

const USAGE = `usage: ci-triage [options] <junit.xml | dir>...

  --changed-files <file>  paths changed in the commit under test, one per line
  --codeowners <file>     default: .github/CODEOWNERS, if it exists
  --default-owner <@who>  owner of tests CODEOWNERS doesn't cover
  --attempt <n>           which attempt of the workflow run failed (default 1)
  --max-attempts <n>      re-run at most this many times in total (default ${MAX_ATTEMPTS})
  --title <text>          what the report is about, e.g. "CI #812 on main"
  --run-url <url>         link to the failed run
  --out <dir>             where to write triage.json and triage.html (default triage-out)`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'changed-files': { type: 'string' },
    codeowners: { type: 'string' },
    'default-owner': { type: 'string' },
    attempt: { type: 'string', default: '1' },
    'max-attempts': { type: 'string', default: String(MAX_ATTEMPTS) },
    title: { type: 'string', default: '' },
    'run-url': { type: 'string', default: '' },
    out: { type: 'string', default: 'triage-out' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (opts.help || !positionals.length) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 2);
}

try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // no .env file
}

const xmlFiles = positionals.flatMap((p) =>
  statSync(p).isDirectory()
    ? readdirSync(p, { recursive: true })
        .filter((f) => f.endsWith('.xml'))
        .map((f) => join(p, f))
    : [p],
);
const failures = uniqueIds(xmlFiles.flatMap((f) => parseJUnit(readFileSync(f, 'utf8'), f)));

const codeownersPath = opts.codeowners ?? '.github/CODEOWNERS';
const ownersOf = existsSync(codeownersPath)
  ? parseCodeowners(readFileSync(codeownersPath, 'utf8'))
  : () => [];
const defaultOwners = opts['default-owner'] ? [opts['default-owner']] : [];
for (const f of failures) {
  const owners = f.file ? ownersOf(f.file) : [];
  f.owners = owners.length ? owners : defaultOwners;
}

const changedFiles = opts['changed-files']
  ? readFileSync(opts['changed-files'], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  : [];

const started = performance.now();
let classified = [];
if (failures.length) {
  try {
    classified = await classifyAll(new TypeSafeClient(), failures, changedFiles);
  } catch (err) {
    console.error(`ci-triage: couldn't classify the failures, so no action will be taken.\n${err.message}`);
    process.exit(1);
  }
}
const wallMs = Math.round(performance.now() - started);

const run = {
  title: opts.title,
  url: opts['run-url'],
  attempt: Number(opts.attempt),
  maxAttempts: Number(opts['max-attempts']),
  reports: xmlFiles,
};
const { verdict, failures: decided } = decide(classified, run);
const report = buildReport({ run, verdict, failures: decided, wallMs });

mkdirSync(opts.out, { recursive: true });
const htmlPath = resolve(opts.out, 'triage.html');
writeFileSync(join(opts.out, 'triage.json'), JSON.stringify(report, null, 2));
writeFileSync(htmlPath, renderHtml(report));

console.log(terminalSummary(report, htmlPath));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdownSummary(report)}\n`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${verdict}\n`);
