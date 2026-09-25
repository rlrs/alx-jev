// Upstream OpenAI-compatible gateway client.
//
// Notes from probing the gateway:
//  * `chat_template_kwargs: { enable_thinking: false }` disables Qwen reasoning.
//  * Logprobs reporting is nondeterministic (sometimes all tokens but the first,
//    sometimes only the last 1-2), so we never depend on a specific token's
//    logprobs — see src/jev.mjs for the Monte Carlo approach.
//  * Non-standard error code 529 = overloaded.

const DEFAULTS = {
  baseUrl: 'https://inference.alexandra.dk/v1',
  apiKey: '',
  model: 'qwen3.8-flash-next',
  timeoutMs: 30000,
};

/** Simple async semaphore returning a run(fn) wrapper. */
export function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (queue.length === 0 || active >= max) return;
    active++;
    queue.shift()();
  };
  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        fn().then(
          (v) => { active--; resolve(v); next(); },
          (e) => { active--; reject(e); next(); },
        );
      });
      next();
    });
  };
}

export class UpstreamError extends Error {
  constructor(status, body, message) {
    super(message || `upstream returned ${status}`);
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createUpstream(cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };

  async function rawChat(body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('upstream timeout')), c.timeoutMs);
    try {
      const res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let text = '';
        try { text = await res.text(); } catch { /* ignore */ }
        throw new UpstreamError(res.status, text.slice(0, 500));
      }
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Chat completion with retry/backoff on 429 and 529.
   * Returns { content, promptTokens, completionTokens }.
   */
  async function chatBody({ messages, temperature = 1.0, maxTokens = 16, stop }) {
    const payload = {
      model: c.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
    };
    if (stop) payload.stop = stop;

    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const d = await rawChat(payload);
        const ch = d.choices?.[0];
        const out = {
          content: typeof ch?.message?.content === 'string' ? ch.message.content : '',
          promptTokens: d.usage?.prompt_tokens ?? 0,
          completionTokens: d.usage?.completion_tokens ?? 0,
        };
        return out;
      } catch (e) {
        lastErr = e;
        const retryable = e instanceof UpstreamError && (e.status === 429 || e.status === 529 || e.status >= 500);
        if (!retryable || attempt === 3) break;
        const grow = 400 * 2 ** attempt + Math.random() * 200;
        await sleep(grow);
      }
    }
    throw lastErr;
  }

  return {
    cfg: c,
    chatBody,
    limiter: createLimiter(24), // replaced by server config
    setLimiter(max) { this.limiter = createLimiter(max); },
  };
}
