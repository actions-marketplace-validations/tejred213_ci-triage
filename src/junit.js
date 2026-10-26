// Reads JUnit XML (Jest, Playwright, pytest, Go, Maven…) into a flat list of failed tests.
// Only what Jev needs to judge the cause is kept: the message, the start of the stack trace
// or diff, and the end of what the test printed. Everything is cut to a fixed size, because
// unrelated detail in the state costs accuracy.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  alwaysCreateTextNode: true,
  parseTagValue: false,
  parseAttributeValue: false,
  // Also decodes numeric references: pytest writes newlines in `message` as &#10;.
  htmlEntities: true,
  isArray: (name) =>
    ['testsuite', 'testcase', 'failure', 'error', 'system-out', 'system-err'].includes(name),
});

const MAX_MESSAGE = 600;
const MAX_DETAILS = 3000;
const MAX_OUTPUT = 1500;

// Terminal colour codes are noise to Jev and to the report.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const PATH_LIKE = /[/\\]|\.(?:[cm]?[jt]sx?|py|rb|go|java|kt|cs|php|rs|swift)$/;

const clean = (text) =>
  String(text ?? '')
    .replace(ANSI, '')
    .replace(/\r\n?/g, '\n')
    .trim();
const textOf = (node) => clean(typeof node === 'object' ? node['#text'] : node);
const head = (text, n) => (text.length > n ? `${text.slice(0, n)}\n…[truncated]` : text);
const tail = (text, n) => (text.length > n ? `[truncated]…\n${text.slice(-n)}` : text);

/**
 * @param {string} xml one JUnit report
 * @param {string} source where it came from, for the report
 */
export function parseJUnit(xml, source = '') {
  const doc = parser.parse(xml);
  const failures = [];

  const walk = (node, suiteName, suiteFile) => {
    if (typeof node !== 'object') return;
    for (const suite of node.testsuite ?? []) {
      walk(suite, suite.name ?? suiteName, suite.file ?? suiteFile);
    }
    for (const tc of node.testcase ?? []) {
      const problem = tc.failure?.[0] ?? tc.error?.[0];
      if (problem === undefined) continue;
      const attrs = typeof problem === 'object' ? problem : {};
      const output = [...(tc['system-out'] ?? []), ...(tc['system-err'] ?? [])]
        .map(textOf)
        .filter(Boolean)
        .join('\n');
      const name = tc.name ?? '(unnamed test)';
      const suite = suiteName || tc.classname || '';
      const file = [tc.file, suiteFile, tc.classname, suiteName].find((s) => s && PATH_LIKE.test(s)) ?? null;
      // Jest repeats the describe block in the test name; the id doesn't need it twice.
      const shortName = suite && name.startsWith(`${suite} `) ? name.slice(suite.length + 1) : name;
      const where = file ?? suite;
      failures.push({
        id: where ? `${where} › ${where === file ? name : shortName}` : name,
        name,
        suite,
        file,
        kind: tc.failure ? 'failure' : 'error',
        type: clean(attrs.type) || null,
        message: head(clean(attrs.message), MAX_MESSAGE),
        details: head(textOf(problem), MAX_DETAILS),
        output: tail(output, MAX_OUTPUT),
        source,
      });
    }
  };

  walk(doc.testsuites ?? doc, '', null);
  return failures;
}

/** The same test can fail in several reports (a matrix build); keep ids unique. */
export function uniqueIds(failures) {
  const seen = new Map();
  return failures.map((f) => {
    const n = (seen.get(f.id) ?? 0) + 1;
    seen.set(f.id, n);
    return n === 1 ? f : { ...f, id: `${f.id} (${n})` };
  });
}
