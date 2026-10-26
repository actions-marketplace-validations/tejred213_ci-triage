// A stand-in for api.typesafe.ai, for tests and for `npm run demo` without an API key.
// It answers from keyword rules over the request, so it exercises the plumbing (request
// shape, concurrency, policy, report) and says nothing about how well Jev classifies.
import { createServer } from 'node:http';
import { zstdDecompressSync, gunzipSync } from 'node:zlib';

export const MOCK_MODEL = 'mock (keyword rules, not Jev)';

const RULES = [
  ['environment_or_timeout', /econnrefused|enotfound|err_name_not_resolved|etimedout|for a hook|keyerror: '\w*secret/],
  ['api_contract_mismatch', /validationerror|required property|value_cents|unknown field/],
  ['flaky_test', /detached from the dom|not stable|created_at = now|23:59:59/],
  ['genuine_regression', /typeerror|status_code == 401|element\(s\) not found/],
];

function answerCategory(text, criteria) {
  const keys = Object.keys(criteria);
  const hit = RULES.find(([, re]) => re.test(text))?.[0];
  // No rule matched: spread the probability, the way an unsure answer looks.
  const spread = [0.38, 0.3, 0.2, 0.12];
  const probabilities = Object.fromEntries(
    keys.map((k, i) => [k, hit ? (k === hit ? 0.88 : 0.04) : spread[i]]),
  );
  const pmax = Math.max(...Object.values(probabilities));
  const n = keys.length;
  const choice = keys.find((k) => probabilities[k] === pmax);
  return { type: 'choice', choice, confidence: (pmax - 1 / n) / (1 - 1 / n), probabilities };
}

function answerSeverity(text, levels) {
  const level = /refund|payment|login|password|sso|okta/.test(text) ? 3 : /order|checkout|cart|invoice/.test(text) ? 2 : 1;
  const probabilities = Object.fromEntries(levels.map((_, i) => [String(i), i === level ? 0.8 : 0.2 / (levels.length - 1)]));
  const score = Object.entries(probabilities).reduce((s, [i, p]) => s + Number(i) * p, 0);
  return {
    type: 'score',
    score,
    confidence: 0.7,
    legend: Object.fromEntries(levels.map((l, i) => [String(i), l])),
    probabilities,
  };
}

export function startMock() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      const encoding = req.headers['content-encoding'];
      if (encoding === 'zstd') body = zstdDecompressSync(body);
      if (encoding === 'gzip') body = gunzipSync(body);
      const request = JSON.parse(body.toString('utf8'));
      requests.push({ auth: req.headers.authorization, path: req.url, request });
      const { changed_files, ...evidence } = request.state;
      const text = JSON.stringify(evidence).toLowerCase();
      const answers = {};
      // touches_change: yes when a changed file's name shows up in the failure.
      const touches = (changed_files ?? []).some((p) => text.includes(p.split('/').pop().replace(/\.\w+$/, '').toLowerCase()));
      for (const [name, q] of Object.entries(request.questions)) {
        answers[name] =
          q.type === 'choice' ? answerCategory(text, q.criteria)
          : q.type === 'noul' ? { type: 'noul', noul: touches ? 0.9 : 0.1 }
          : answerSeverity(text, q.criteria);
      }
      // Real requests take a little while; so does this one.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: MOCK_MODEL, answers, usage: { input_tokens: Math.round(body.length / 4), output_tokens: 20 } }));
      }, 60 + Math.random() * 120);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
