// The Jev evaluation engine.
//
// Jev is a "System One" model: it returns typed, calibrated decisions instead
// of prose. We emulate it on a general instruction-tuned model with Monte
// Carlo snap decisions: for every question we fire N tiny parallel samples
// (reasoning disabled, temperature ~1) that must answer in a strict one-line
// format, then aggregate label frequencies into a probability distribution.
// This relies only on sampling behaviour (which is stable) and not on
// logprobs (which this gateway reports unreliably).

import { UpstreamError } from './upstream.mjs';

const SYSTEM_PROMPT =
  'You are Jev, a System One decision model. You never explain, never comment, ' +
  'and always answer with exactly the single requested line and nothing else.';

/** Build the user message for one question. */
export function buildUserMessage(stateText, q) {
  if (q.type === 'choice') {
    const labels = Object.keys(q.criteria);
    return [
      stateText,
      '',
      `Question: ${q.instructions}`,
      'Options:',
      labels.map((l, i) => `${i + 1}. ${l}${q.criteria[l] ? `: ${q.criteria[l]}` : ''}`).join('\n'),
      '',
      'Respond with exactly one line in this format:',
      'VERDICT: <number>',
      'where <number> is the number of the best matching option. Do not write the option name.',
    ].join('\n');
  }
  if (q.type === 'score') {
    return [
      stateText,
      '',
      `Question: ${q.instructions}`,
      `Levels (low to high): ${q.criteria.map((c, i) => `${i}=${c}`).join('; ')}`,
      '',
      'Respond with exactly one line in this format:',
      'VERDICT: <index>',
      'where <index> is the number of the best matching level.',
    ].join('\n');
  }
  // noul
  return [
    stateText,
    '',
    `Question (answer yes or no): ${q.instructions}`,
    '',
    'Respond with exactly one line in this format:',
    'VERDICT: <yes or no>',
  ].join('\n');
}

function normLine(content) {
  const line = String(content).split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.replace(/^VERDICT:\s*/i, '').trim().toLowerCase().replace(/[.!,;:]+$/, '');
}

/** Map a raw answer line to a choice option; null when unparseable.
 *  Primary format is the option number (robust for any option key and any
 *  option count); a literal option-name answer is accepted as a fallback. */
export function parseChoice(lineContent, options) {
  const n = normLine(lineContent);
  if (!n) return null;
  const m = n.match(/^\d+$/);
  if (m) {
    const i = parseInt(n, 10) - 1;
    return i >= 0 && i < options.length ? options[i] : null;
  }
  // fallback: model answered with the option name anyway
  const hit = options.find((o) => o === n.toLowerCase())
    ?? options.find((o) => o.toLowerCase().startsWith(n) && n.length >= Math.min(3, o.length))
    ?? options.find((o) => n.includes(o.toLowerCase()));
  return hit ?? null;
}

export function parseScore(lineContent, levels) {
  const n = normLine(lineContent);
  const m = n.match(/(-?\d+)/);
  if (!m) return null;
  const i = parseInt(m[1], 10);
  return i >= 0 && i < levels.length ? i : null;
}

export function parseNoul(lineContent) {
  const n = normLine(lineContent);
  if (n.startsWith('y')) return 1;
  if (n.startsWith('n')) return 0;
  if (n === 'true') return 1;
  if (n === 'false') return 0;
  return null;
}

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;

/** Light additive smoothing so unsampled options keep a small honest probability. */
function smoothed(counts, alpha = 0.25) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const k = Object.keys(counts).length;
  const z = total + alpha * k;
  const out = {};
  for (const [key, c] of Object.entries(counts)) out[key] = (c + alpha) / z;
  return out;
}

function entropyConfidence(probs) {
  const p = Object.values(probs);
  let h = 0;
  for (const x of p) if (x > 0) h -= x * Math.log(x);
  h /= Math.log(p.length);
  return r2(Math.max(0, 1 - h));
}

/** Fix rounding so probabilities sum to ~1 (remainder goes to the mode). */
function normalizeRounded(probs) {
  const mode = Object.keys(probs).reduce((a, b) => (probs[b] > probs[a] ? b : a));
  let sum = 0;
  for (const k of Object.keys(probs)) { probs[k] = r4(probs[k]); sum += probs[k]; }
  const diff = r4(1 - sum);
  probs[mode] = r4(probs[mode] + diff);
  return probs;
}

/**
 * Evaluate one question with N Monte Carlo samples.
 * up: upstream client (with .limiter). Returns a Jev-typed answer.
 */
export async function evaluateQuestion(stateText, q, opts) {
  const { samples, temperature, limiter, upstream } = opts;
  const userMessage = buildUserMessage(stateText, q);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  const jobs = [];
  for (let i = 0; i < samples; i++) {
    jobs.push(limiter(() => upstream.chatBody({
      messages,
      temperature,
      maxTokens: 24,
      stop: ['\n'],
    })));
  }

  let used = await Promise.all(jobs.map((p) => p.catch((e) => ({ error: e }))));
  const valid = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let firstError = null;
  for (const u of used) {
    if (u.error) { firstError ??= u.error; continue; }
    inputTokens += u.promptTokens;
    outputTokens += u.completionTokens;
    try {
      const v =
        q.type === 'choice' ? parseChoice(u.content, Object.keys(q.criteria)) :
        q.type === 'score' ? parseScore(u.content, q.criteria) :
        parseNoul(u.content);
      if (v !== null && v !== undefined) valid.push(v);
    } catch { /* discard unparseable sample */ }
  }
  if (valid.length === 0) {
    throw new UpstreamError(firstError?.status ?? 502, null,
      `model produced no valid answers for question ("${q.instructions}")`);
  }

  if (q.type === 'choice') {
    const counts = {};
    for (const o of Object.keys(q.criteria)) counts[o] = 0;
    for (const v of valid) counts[v]++;
    let probs = normalizeRounded(smoothed(counts));
    return {
      answer: { type: 'choice', choice: argmax(probs), probabilities: probs, confidence: entropyConfidence(probs) },
      inputTokens, outputTokens,
    };
  }
  if (q.type === 'score') {
    const counts = {};
    for (let i = 0; i < q.criteria.length; i++) counts[String(i)] = 0;
    for (const v of valid) counts[String(v)]++;
    const probs = normalizeRounded(smoothed(counts));
    const expected = Object.entries(probs).reduce((s, [i, p]) => s + Number(i) * p, 0);
    const legend = {};
    q.criteria.forEach((c, i) => { legend[String(i)] = c; });
    return {
      answer: {
        type: 'score', score: r2(expected), legend, probabilities: probs,
        confidence: entropyConfidence(probs),
      },
      inputTokens, outputTokens,
    };
  }
  // noul
  const yes = valid.filter(Boolean).length;
  const p = r4((yes + 0.25) / (valid.length + 0.5));
  return {
    answer: { type: 'noul', noul: p },
    inputTokens, outputTokens,
  };
}

function argmax(obj) {
  return Object.keys(obj).reduce((a, b) => (obj[b] > obj[a] ? b : a));
}
