// Triage the sample reports in fixtures/ and write demo-out/triage.html.
//
//   npm run demo
//
// With TYPESAFE_API_KEY (environment or .env) this asks the real Jev. Without one it starts a
// local mock that answers from keyword rules: the report then shows the UI and the routing,
// not Jev's judgment.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-typesafe.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // no .env file
}

const env = { ...process.env };
let mock;
if (!env.TYPESAFE_API_KEY) {
  mock = await startMock();
  env.TYPESAFE_API_KEY = 'mock';
  env.TYPESAFE_BASE_URL = mock.url;
  console.log('No TYPESAFE_API_KEY: using the keyword mock, not Jev.\n');
}

const args = [
  'bin/triage.mjs',
  '--codeowners', 'fixtures/CODEOWNERS',
  '--changed-files', 'fixtures/changed-files.txt',
  '--default-owner', '@qa-lead',
  '--title', 'CI #812 on main · a41c9e2',
  '--run-url', 'https://github.com/acme/shop/actions/runs/812',
  '--out', 'demo-out',
  'fixtures/reports',
];
// Not spawnSync: the mock runs in this process and has to answer while the CLI runs.
const code = await new Promise((resolve) => {
  spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' }).on('exit', resolve);
});
await mock?.close();
process.exit(code ?? 1);
