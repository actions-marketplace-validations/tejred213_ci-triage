// Which GitHub issues a run's ticketed failures go into, and what those issues say.
//
// Failures in the same file with the same kind of ticket (regression, api-contract, flaky,
// needs-triage) most likely share a root cause, so a run files them as one issue. Each issue
// lists its tests in a hidden marker; a test that fails again in a later run gets a comment
// on the open issue that lists it, instead of a new issue.

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const MARKER = /<!-- ci-triage-tests: (\[.*?\]) -->/s;
// GitHub rejects issue bodies over 65,536 characters.
const BODY_LIMIT = 60000;

export function groupTickets(failures) {
  const groups = new Map();
  for (const f of failures) {
    if (!f.decision.ticket) continue;
    const where = f.file ?? f.suite;
    const key = `${f.decision.ticket.labels.join('+')}|${where}`;
    if (!groups.has(key)) groups.set(key, { where, labels: f.decision.ticket.labels, failures: [] });
    groups.get(key).failures.push(f);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    priority:
      g.failures
        .map((f) => f.decision.ticket.priority)
        .filter(Boolean)
        .sort((a, b) => PRIORITIES.indexOf(a) - PRIORITIES.indexOf(b))[0] ?? null,
    owners: [...new Set(g.failures.flatMap((f) => f.owners))],
  }));
}

export function testsInBody(body) {
  const m = MARKER.exec(body ?? '');
  try {
    return m ? JSON.parse(m[1]) : [];
  } catch {
    return [];
  }
}

/**
 * @param {object[]} failures decided failures from triage.json
 * @param {{number: number, body: string}[]} openIssues open ci-triage issues
 * @returns {{comments: {number: number, failures: object[]}[], creates: object[]}}
 */
export function planTickets(failures, openIssues) {
  const issueOf = new Map();
  for (const issue of openIssues) {
    for (const id of testsInBody(issue.body)) issueOf.set(id, issue.number);
  }
  const ticketed = failures.filter((f) => f.decision.ticket);
  const comments = new Map();
  for (const f of ticketed) {
    const number = issueOf.get(f.id);
    if (number) comments.set(number, [...(comments.get(number) ?? []), f]);
  }
  return {
    comments: [...comments].map(([number, list]) => ({ number, failures: list })),
    creates: groupTickets(ticketed.filter((f) => !issueOf.has(f.id))),
  };
}

const kindOf = (group, report) =>
  group.labels.includes('needs-triage') ? 'Needs triage' : report.categories[group.failures[0].jev.category];

export function issueTitle(group, report) {
  const [first] = group.failures;
  const what = group.failures.length === 1 ? first.id : `${group.failures.length} tests in ${group.where}`;
  return `[ci-triage] ${kindOf(group, report)}: ${what}`.slice(0, 250);
}

// A fence longer than any run of backticks in the text, so the text can't close it.
const fenced = (text) => {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${fence}\n${text}\n${fence}`;
};

function failureSection(f, report) {
  const { jev, decision } = f;
  const label = report.categories[jev.category];
  const read = decision.notFromChange
    ? `Jev: ${label} ${jev.confidence.toFixed(2)}, but the changed files don't touch this test (${jev.touchesChange.toFixed(2)}), so it may not come from this change`
    : decision.unsure
    ? `Jev unsure: best guess ${label} (${jev.confidence.toFixed(2)})`
    : `Jev: ${label} ${jev.confidence.toFixed(2)}` +
      (decision.ticket.labels.includes('flaky') ? '' : ` · severity if shipped: ${jev.severity.label}`);
  return [
    `#### \`${f.name}\``,
    read,
    fenced(f.message || '(no message)'),
    f.details ? `<details><summary>Stack trace / diff</summary>\n\n${fenced(f.details)}\n\n</details>` : null,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// As many full sections as fit; the rest by name.
function sections(failures, report, budget) {
  const out = [];
  const left = [];
  let used = 0;
  for (const f of failures) {
    const s = failureSection(f, report);
    if (used + s.length > budget) left.push(f);
    else {
      out.push(s);
      used += s.length;
    }
  }
  if (left.length) {
    out.push(`Too long to show here, see the triage report: ${left.map((f) => `\`${f.name}\``).join(', ')}`);
  }
  return out;
}

function runLine(report) {
  const { run } = report;
  const link = run.url ? `[${run.title || 'workflow run'}](${run.url})` : run.title;
  return link ? `${link}, attempt ${run.attempt}` : `attempt ${run.attempt}`;
}

export function issueBody(group, report) {
  const n = group.failures.length;
  const ids = JSON.stringify(group.failures.map((f) => f.id)).replace(/-->/g, '--\\u003e');
  const marker = `<!-- ci-triage-tests: ${ids} -->`;
  const head = [
    `**${kindOf(group, report)}**` +
      (group.priority ? ` · priority **${group.priority}**` : '') +
      ` · ${n === 1 ? '1 failing test' : `${n} failing tests`} in \`${group.where}\``,
    group.labels.includes('retries-exhausted')
      ? `Still failing after ${report.run.attempt} attempts, so this is probably not a passing glitch.`
      : group.labels.includes('needs-triage')
        ? 'The cause is not clear enough to act on automatically; a person should decide.'
        : null,
    [`- **Run:** ${runLine(report)}`, group.owners.length ? `- **Owners:** ${group.owners.join(' ')}` : null]
      .filter(Boolean)
      .join('\n'),
  ];
  const foot = `<sub>Classified by Jev (${report.model}). Filed by ci-triage; close this when the tests pass.</sub>\n\n${marker}`;
  const budget = BODY_LIMIT - head.join('').length - foot.length;
  return [...head, ...sections(group.failures, report, budget), foot].filter(Boolean).join('\n\n');
}

export function commentBody(failures, report) {
  const n = failures.length;
  const head = `Failed again in ${runLine(report)}: ${n === 1 ? '1 test' : `${n} tests`}.`;
  return [head, ...sections(failures, report, BODY_LIMIT - head.length)].join('\n\n');
}
