// The triage result as data (triage.json), as a one-page HTML report, and as text for the
// terminal and the GitHub job summary.
import { readFileSync } from 'node:fs';
import { CATEGORIES, SEVERITY_LABELS } from './classify.js';
import { groupTickets } from './tickets.js';

const TEMPLATE = new URL('../ui/report.html', import.meta.url);
const DATA_MARKER = '/*__TRIAGE_DATA__*/null';

export function buildReport({ run, verdict, failures, wallMs }) {
  const byCategory = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, 0]));
  // Unsure answers are counted on their own, so the categories and `unsure` add up to the total.
  for (const f of failures) if (!f.decision.unsure) byCategory[f.jev.category]++;
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    run,
    verdict,
    model: failures[0]?.jev.model ?? null,
    categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, c]) => [k, c.label])),
    severityLabels: SEVERITY_LABELS,
    totals: {
      failures: failures.length,
      byCategory,
      unsure: failures.filter((f) => f.decision.unsure).length,
      tickets: failures.filter((f) => f.decision.ticket).length,
      // Ticketed failures grouped by file and cause, as ci-triage-act files them.
      issues: groupTickets(failures).length,
      inputTokens: failures.reduce((n, f) => n + f.jev.inputTokens, 0),
      wallMs,
    },
    failures,
  };
}

export function renderHtml(report) {
  // Test output can contain "</script>"; escaping "<" keeps it inside the JSON.
  const json = JSON.stringify(report).replace(/</g, '\\u003c');
  return readFileSync(TEMPLATE, 'utf8').replace(DATA_MARKER, () => json);
}

export function actionText(f) {
  const { retry, ticket, unsure } = f.decision;
  const parts = [];
  if (retry) parts.push('re-run');
  if (ticket) parts.push(ticket.priority ? `ticket ${ticket.priority}` : 'ticket (needs triage)');
  if (!parts.length) parts.push('report only');
  if (f.decision.notFromChange) return `not in change → ${parts.join(' + ')}`;
  return unsure ? `unsure → ${parts.join(' + ')}` : parts.join(' + ');
}

export function verdictText(report) {
  const { verdict, totals, run } = report;
  if (verdict === 'none') return 'No failed tests in the reports. Nothing to triage.';
  if (verdict === 'retry') {
    return `Re-running the failed jobs (attempt ${run.attempt + 1} of ${run.maxAttempts}): every failure looks like an environment glitch or a flaky test.`;
  }
  const tests = `${totals.tickets} failing test${totals.tickets === 1 ? '' : 's'}`;
  const issues = `${totals.issues} issue${totals.issues === 1 ? '' : 's'}`;
  return `Not re-running. ${tests} filed as ${issues} for owners${totals.unsure ? `; ${totals.unsure} need${totals.unsure === 1 ? 's' : ''} a person to triage` : ''}.`;
}

export function terminalSummary(report, htmlPath) {
  const { totals, model } = report;
  const lines = [
    `ci-triage: ${totals.failures} failed test${totals.failures === 1 ? '' : 's'} classified in ${(totals.wallMs / 1000).toFixed(1)} s` +
      (model ? ` (${model}, ${totals.inputTokens.toLocaleString('en-US')} input tokens)` : ''),
  ];
  for (const f of report.failures) {
    lines.push(
      `  ${report.categories[f.jev.category].padEnd(22)} ${f.jev.confidence.toFixed(2)}  ${actionText(f).padEnd(30)} ${(f.owners.join(' ') || '-').padEnd(26)} ${f.id}`,
    );
  }
  lines.push(verdictText(report));
  if (htmlPath) lines.push(`Report: ${htmlPath}`);
  return lines.join('\n');
}

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function markdownSummary(report) {
  const lines = ['## CI triage', '', verdictText(report), ''];
  if (!report.failures.length) return lines.join('\n');
  lines.push('| Test | Cause | Confidence | Action | Owner |', '| - | - | - | - | - |');
  for (const f of report.failures) {
    lines.push(
      `| ${cell(f.id)} | ${report.categories[f.jev.category]} | ${f.jev.confidence.toFixed(2)} | ${actionText(f)} | ${cell(f.owners.join(' ') || '-')} |`,
    );
  }
  lines.push('', `Classified by ${report.model} in ${(report.totals.wallMs / 1000).toFixed(1)} s.`);
  return lines.join('\n');
}
