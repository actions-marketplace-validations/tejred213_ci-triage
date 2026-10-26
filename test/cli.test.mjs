// End to end against the mock API: the CLI's request shape, the files it writes, and the gh
// commands ci-triage-act would run. The mock's answers are keyword rules, not Jev's.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startMock } from '../scripts/mock-typesafe.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
let mock;
before(async () => {
  mock = await startMock();
});
after(() => mock.close());

function run(script, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, TYPESAFE_API_KEY: 'test-key', TYPESAFE_BASE_URL: mock.url, GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const triage = async (reports, extra = []) => {
  const out = mkdtempSync(join(tmpdir(), 'ci-triage-'));
  const res = await run('bin/triage.mjs', [
    '--codeowners', 'fixtures/CODEOWNERS', '--changed-files', 'fixtures/changed-files.txt', '--out', out, ...extra, ...reports,
  ]);
  return { ...res, out, report: res.code === 0 ? JSON.parse(readFileSync(join(out, 'triage.json'), 'utf8')) : null };
};

test('classifies every failure with one request each and writes the report', async () => {
  const before = mock.requests.length;
  const { code, stderr, report, out } = await triage(['fixtures/reports']);
  assert.equal(code, 0, stderr);
  assert.equal(report.totals.failures, 13);
  assert.equal(mock.requests.length - before, 13);

  const { auth, path, request } = mock.requests.at(-1);
  assert.equal(auth, 'Bearer test-key');
  assert.equal(path, '/v1/systemone');
  assert.equal(request.model, 'jev-1.14.0');
  assert.deepEqual(Object.keys(request.questions.category.criteria), [
    'environment_or_timeout', 'genuine_regression', 'flaky_test', 'api_contract_mismatch',
  ]);
  assert.equal(request.questions.severity.criteria.length, 4);
  assert.ok(request.state.failure.message);
  assert.deepEqual(request.state.changed_files.slice(0, 1), ['src/payments/refund.ts']);

  const refund = report.failures.find((f) => f.name.includes('partial amount'));
  assert.deepEqual(refund.owners, ['@qa-marco']);
  assert.equal(report.verdict, 'tickets');
  assert.ok(readFileSync(join(out, 'triage.html'), 'utf8').includes('"verdict":"tickets"'));
});

test('test output cannot break out of the report script tag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-triage-xss-'));
  const xml = join(dir, 'r.xml');
  writeFileSync(xml, `<testsuite name="x"><testcase name="t"><failure message="&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;">ECONNREFUSED</failure></testcase></testsuite>`);
  const { code, out } = await triage([xml]);
  assert.equal(code, 0);
  const html = readFileSync(join(out, 'triage.html'), 'utf8');
  assert.ok(!html.includes('</script><img'));
  assert.ok(html.includes('\\u003c/script>\\u003cimg'));
});

test('only environment failures: re-run; act runs gh run rerun and files nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-triage-env-'));
  const xml = join(dir, 'env.xml');
  writeFileSync(xml, `<testsuite name="db"><testcase name="a"><failure message="connect ECONNREFUSED 127.0.0.1:5432"/></testcase><testcase name="b"><failure message="getaddrinfo ENOTFOUND redis"/></testcase></testsuite>`);
  const { report, out } = await triage([xml], ['--attempt', '1']);
  assert.equal(report.verdict, 'retry');

  const act = await run('bin/act.mjs', [join(out, 'triage.json'), '--repo', 'acme/shop', '--run-id', '812', '--dry-run']);
  assert.equal(act.code, 0, act.stderr);
  assert.match(act.stdout, /^\$ gh run rerun 812 --failed --repo acme\/shop$/m);
  assert.doesNotMatch(act.stdout, /issue create/);
});

test('act files one issue per ticketed test, assigning users and not teams', async () => {
  const { out } = await triage(['fixtures/reports']);
  const act = await run('bin/act.mjs', [join(out, 'triage.json'), '--repo', 'acme/shop', '--run-id', '812', '--dry-run']);
  assert.equal(act.code, 0, act.stderr);
  const creates = act.stdout.split('\n').filter((l) => l.startsWith('$ gh issue create'));
  assert.equal(creates.length, 9);
  assert.doesNotMatch(act.stdout, /gh run rerun/);
  const refund = creates.find((l) => l.includes('partial amount'));
  assert.match(refund, /--label ci-triage,regression,P0/);
  assert.match(refund, /--assignee qa-marco/);
  assert.ok(creates.every((l) => !l.includes('acme/platform')));
});

test('no API key: exits non-zero and takes no action', async () => {
  const out = mkdtempSync(join(tmpdir(), 'ci-triage-nokey-'));
  const { code, stderr } = await run('bin/triage.mjs', ['--out', out, 'fixtures/reports'], { TYPESAFE_API_KEY: '' });
  assert.equal(code, 1);
  assert.match(stderr, /no action will be taken/);
});
