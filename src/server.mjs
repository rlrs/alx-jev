#!/usr/bin/env node
// alx-jev — Jev-like System One decision API.
//
//   POST /v1/systemone            core contract (Jev-compatible shapes)
//   GET  /v1/models               model aliases
//   POST /api/v1/<preset>         ready-made endpoints (see presets.mjs)
//   GET  /healthz
//
// Validation errors mirror Jev's 422-with-field style; auth errors are 401.

import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createUpstream, UpstreamError } from './upstream.mjs';
import { createLimiter } from './upstream.mjs';
import { evaluateQuestion } from './jev.mjs';
import { presets } from './presets.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// ---- config ----
function loadEnv() {
  const env = { ...process.env };
  const envPath = join(here, '..', '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}
const env = loadEnv();

const CONFIG = {
  port: parseInt(env.PORT || '8090', 10),
  samples: clampInt(env.SAMPLES, 16, 1, 96),
  temperature: parseFloat(env.TEMPERATURE || '1.0'),
  concurrency: parseInt(env.CONCURRENCY || '24', 10),
  modelVersion: env.MODEL_VERSION || 'jev-1.13.0',
  upstream: createUpstream({
    baseUrl: env.UPSTREAM_BASE_URL || 'https://inference.alexandra.dk/v1',
    apiKey: env.UPSTREAM_API_KEY || '',
    model: env.UPSTREAM_MODEL || 'qwen3.8-flash-next',
    timeoutMs: parseInt(env.UPSTREAM_TIMEOUT || '30000', 10),
  }),
};
CONFIG.upstream.limiter = createLimiter(CONFIG.concurrency);

function clampInt(v, dflt, lo, hi) {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

// ---- model aliases ----
function resolveModel(model) {
  if (model === undefined || model === null || model === '') {
    return { ok: false, field: 'model', message: 'model is required (e.g. "jev-latest" or a pinned version like "jev-1.13.0")' };
  }
  const m = String(model);
  if (m === 'jev-latest' || m === 'jev-preview' || /^jev-\d+\.\d+(\.\d+)?$/.test(m)) {
    return { ok: true, model: CONFIG.modelVersion };
  }
  return { ok: false, field: 'model', message: `unknown model "${m}"` };
}

// ---- validation (Jev style: 422 naming the offending field) ----
class ValidationError extends Error {
  constructor(field, message) { super(message); this.field = field; }
}

// Official input modality: "Text only. String, JSON object, or array of text
// values." We read that as: containers (objects/arrays) whose leaves are all
// strings — numbers/booleans/nulls inside are a 422, not a silent stringify.
function validateTextInput(v, field, depth = 0) {
  if (typeof v === 'string') {
    if (v.length === 0) throw new ValidationError(field, 'must be non-empty text');
    return;
  }
  if (depth > 8) throw new ValidationError(field, 'nested more than 8 levels deep');
  if (Array.isArray(v)) {
    if (v.length === 0) throw new ValidationError(field, 'must not be empty');
    for (let i = 0; i < v.length; i++) validateTextInput(v[i], `${field}[${i}]`, depth + 1);
    return;
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 0) throw new ValidationError(field, 'must not be empty');
    for (const k of keys) validateTextInput(v[k], `${field}.${k}`, depth + 1);
    return;
  }
  throw new ValidationError(field, 'must be text: a string, or an object/array whose values are strings');
}

function renderState(state) {
  if (typeof state === 'string') return state.trim();
  // validated object/array of text values — render as tagged text, not bare JSON
  return structuredText(state, 0);
}

function structuredText(v, indent) {
  const pad = '  '.repeat(indent);
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const items = v.map((x) => `${pad}- ${structuredText(x, indent + 1).trimStart()}`);
    return items.join('\n');
  }
  return Object.entries(v)
    .map(([k, val]) => {
      if (val !== null && typeof val === 'object') {
        return `${pad}${k}:\n${structuredText(val, indent + 1)}`;
      }
      return `${pad}${k}: ${val}`;
    })
    .join('\n');
}

function validateQuestions(questions) {
  if (questions === null || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new ValidationError('questions', 'questions must be an object of question id -> question');
  }
  const entries = Object.entries(questions);
  if (entries.length === 0) throw new ValidationError('questions', 'questions must not be empty');

  for (const [id, qRaw] of entries) {
    if (qRaw === null || typeof qRaw !== 'object' || Array.isArray(qRaw)) {
      throw new ValidationError(`questions.${id}`, 'question must be an object');
    }
    const q = qRaw;
    if (q.instructions === undefined) {
      throw new ValidationError(`questions.${id}.instructions`, 'instructions is required');
    }
    validateTextInput(q.instructions, `questions.${id}.instructions`);
    if (q.type === 'noul') {
      if (q.criteria !== undefined && q.criteria !== null) {
        const c = q.criteria;
        const bad = typeof c !== 'object' || Array.isArray(c) ||
          Object.entries(c).some(([k, v]) => (k !== 'true' && k !== 'false') || typeof v !== 'string');
        if (bad) {
          throw new ValidationError(`questions.${id}.criteria`, 'noul criteria (optional) must be {"true": "...", "false": "..."}');
        }
      }
      continue; // official: the only optional criteria of the three
    }
    if (q.type === 'choice') {
      const c = q.criteria;
      if (c === null || typeof c !== 'object' || Array.isArray(c)) {
        throw new ValidationError(`questions.${id}.criteria`, 'choice questions need a criteria map of options');
      }
      const options = Object.keys(c);
      if (options.length === 0) {
        throw new ValidationError(`questions.${id}.criteria`, 'choice criteria must have at least one option');
      }
      if (options.length > 255) {
        throw new ValidationError(`questions.${id}.criteria`, 'choice criteria supports at most 255 options');
      }
      for (const [opt, desc] of Object.entries(c)) {
        if (!(typeof desc === 'string' || desc === null)) {
          throw new ValidationError(`questions.${id}.criteria`, 'choice criteria values must be strings or null');
        }
      }
      continue;
    }
    if (q.type === 'score') {
      const c = q.criteria;
      if (!Array.isArray(c) || c.length < 2 || c.length > 10) {
        throw new ValidationError(`questions.${id}.criteria`, 'score questions need a criteria array of 2 to 10 level descriptions');
      }
      if (!c.every((x) => typeof x === 'string' && x.length > 0)) {
        throw new ValidationError(`questions.${id}.criteria`, 'score criteria levels must be non-empty strings');
      }
      continue;
    }
    throw new ValidationError(`questions.${id}.type`, `unknown question type "${q.type}" (expected noul, choice or score)`);
  }
}

function validateBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('(body)', 'request body must be a JSON object');
  }
  if (body.state === undefined) {
    throw new ValidationError('state', 'state is required');
  }
  validateTextInput(body.state, 'state');
  validateQuestions(body.questions);
  if (body.samples !== undefined) {
    const n = parseInt(body.samples, 10);
    if (!Number.isFinite(n) || n < 1 || n > 96) {
      throw new ValidationError('samples', 'samples must be an integer between 1 and 96');
    }
  }
}

// ---- core evaluation ----
async function evaluate(body, config) {
  const samples = body.samples !== undefined ? parseInt(body.samples, 10) : config.samples;
  const stateText = renderState(body.state);
  const ids = Object.keys(body.questions);

  const results = await Promise.all(ids.map(async (id) => {
    const q = body.questions[id];
    const normalized = {
      type: q.type,
      instructions: typeof q.instructions === 'string' ? q.instructions : JSON.stringify(q.instructions),
      criteria: q.type === 'noul' ? undefined : q.criteria,
    };
    const { answer, inputTokens, outputTokens } = await evaluateQuestion(
      stateText, normalized,
      { samples, temperature: config.temperature, limiter: config.upstream.limiter, upstream: config.upstream },
    );
    return { id, answer, inputTokens, outputTokens };
  }));

  const answers = {};
  let inputTokens = 0;
  let outputTokens = 0;
  for (const r of results) {
    answers[r.id] = r.answer;
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
  }
  return { answers, inputTokens, outputTokens };
}

// ---- http plumbing ----
function send(res, status, obj, headers = {}) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': buf.length,
    ...headers,
  });
  res.end(buf);
}

const ERR = (message, code, extra = {}) => ({ error: { message, code, ...extra } });

function readBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new ValidationError('(body)', 'request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(raw) {
  try { return JSON.parse(raw === '' ? '{}' : raw); }
  catch { throw new ValidationError('(body)', 'invalid JSON'); }
}

async function handleSystemOne(req, res) {
  if (!req.headers.authorization) {
    return send(res, 401, ERR('missing or invalid API key', 'unauthorized'));
  }
  const body = parseJson(await readBody(req));
  validateBody(body);
  const resolved = resolveModel(body.model); // official contract: model is required
  if (!resolved.ok) throw new ValidationError(resolved.field, resolved.message);

  const { answers, inputTokens, outputTokens } = await evaluate(body, CONFIG);
  send(res, 200, {
    model: resolved.model,
    answers,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
}

async function handlePreset(name, req, res) {
  if (!req.headers.authorization) {
    return send(res, 401, ERR('missing or invalid API key', 'unauthorized'));
  }
  const preset = presets[name];
  const body = parseJson(await readBody(req));
  for (const field of preset.required) {
    if (typeof body[field] !== 'string' || !body[field].trim()) {
      throw new ValidationError(field, `${field} is required`);
    }
  }
  const spec = preset.build(body);
  const resolved = resolveModel('jev-latest');
  const { answers, inputTokens, outputTokens } = await evaluate(
    { state: spec.stateText, questions: spec.questions },
    CONFIG,
  );
  const result = spec.map(answers);
  send(res, 200, {
    ...result,
    model: resolved.model,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CONFIG.port}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'GET' && path === '/healthz') {
      return send(res, 200, {
        ok: true,
        upstream: CONFIG.upstream.cfg.model,
        samples: CONFIG.samples,
        model_version: CONFIG.modelVersion,
      });
    }
    if (req.method === 'GET' && path === '/v1/models') {
      return send(res, 200, {
        object: 'list',
        data: [
          { id: CONFIG.modelVersion, object: 'model', owned_by: 'alx-jev' },
          { id: 'jev-latest', object: 'model', owned_by: 'alx-jev' },
          { id: 'jev-preview', object: 'model', owned_by: 'alx-jev' },
        ],
      });
    }
    if (req.method === 'POST' && path === '/v1/systemone') {
      return await handleSystemOne(req, res);
    }
    if (req.method === 'POST' && presets[path]) {
      return await handlePreset(path, req, res);
    }
    if (req.method === 'GET' && path === '/api/v1/presets') {
      return send(res, 200, { presets: Object.entries(presets).map(([p, v]) => ({ path: p, doc: v.doc, required: v.required })) });
    }
    return send(res, 404, ERR(`no route ${req.method} ${path}`, 'not_found'));
  } catch (e) {
    if (e instanceof ValidationError) {
      return send(res, 422, ERR(e.message, 'invalid_request', { field: e.field }));
    }
    if (e instanceof UpstreamError) {
      if (e.status === 429) {
        // official contract: 429 is retryable, honour retry-after
        return send(res, 429, ERR('rate limited upstream — retry with backoff', 'rate_limited'), { 'retry-after': '2' });
      }
      // official contract: 529 (non-standard) = upstream overloaded, retryable
      const overload = e.status === 529 || e.status >= 500;
      return send(res, overload ? 529 : 502, ERR(
        overload ? 'upstream overloaded — retry with backoff' : `upstream model error: ${e.message}`,
        overload ? 'overloaded' : 'upstream_error',
      ));
    }
    console.error('[alx-jev] error:', e);
    return send(res, 500, ERR('internal error', 'internal_error'));
  }
});

server.listen(CONFIG.port, () => {
  console.log(`[alx-jev] listening on :${CONFIG.port}`);
  console.log(`[alx-jev] model=${CONFIG.modelVersion} upstream=${CONFIG.upstream.cfg.model} samples=${CONFIG.samples} temp=${CONFIG.temperature} concurrency=${CONFIG.concurrency}`);
  if (!CONFIG.upstream.cfg.apiKey) console.warn('[alx-jev] WARNING: UPSTREAM_API_KEY is empty — upstream calls will 401');
});
