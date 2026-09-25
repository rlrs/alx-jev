# alx-jev

A Jev-like **System One decision API**, emulated on an OpenAI-compatible gateway
(`qwen3.8-flash-next`). It does not generate prose: send a `state` plus typed
`questions`, and get back typed, probability-bearing decisions your code can
branch on directly.

Zero dependencies — Node ≥ 20.

```
npm start              # reads .env (see .env.example), listens on :8090
bash examples/smoke.sh # end-to-end checks
```

## Contract

```
POST /v1/systemone
Authorization: Bearer <any non-empty key>
Content-Type: application/json

{
  "state":      <string | object | array>   // the content to evaluate
  "model":      "jev-latest" | "jev-preview" | "jev-<x.y.z>"   (required)
  "questions":  { "<your id>": <Question>, ... }
  "samples":    <int 1..96>                 // alx extension, per-request MC samples
}
```

Question types (same shapes as Jev's public contract):

| type | request fields | answer |
|---|---|---|
| `choice` | `instructions`, `criteria` map (≤255 options) | `choice`, `probabilities` (sum ≈ 1), `confidence` |
| `score` | `instructions`, `criteria` array (2–10 levels, low→high) | `score` (fractional expected level), `legend`, `probabilities` keyed by level index, `confidence` |
| `noul` | `instructions` only | `noul` — calibrated 0–1 probability of "yes", no confidence |

Response:

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "route":   { "type": "choice", "choice": "billing", "probabilities": {"billing": 0.97, "...": "..."}, "confidence": 0.86 },
    "urgency": { "type": "score",  "score": 1.06, "legend": {"0": "Calm", "1": "..."}, "probabilities": {"0": 0.01, "1": 0.91, "2": 0.07}, "confidence": 0.69 },
    "checks":  { "type": "noul",   "noul": 0.98 }
  },
  "usage": { "input_tokens": 6560, "output_tokens": 352 }
}
```

Errors: `401` missing key · `422` validation (message names the field) ·
`429` upstream rate limit (retry with backoff, `retry-after` header) ·
`529` upstream overloaded (retry with backoff — Jev's non-standard code) ·
`502` upstream model error · `404` unknown route. No streaming, no batch —
one endpoint, like Jev.

Deliberate extensions/deviations from the official contract: a `samples`
per-request field (1–96, overrides the default MC sample count), `usage`
summed across the N samples per question, and `confidence` computed from
distribution entropy rather than RLCD training. The official input modality
("Text only. String, JSON object, or array of text values") is enforced as:
objects/arrays must have string leaves — numbers, booleans, nulls and empty
containers are `422`. Upstream context limits (64k/32k tokens) are not
enforced locally.

## Ready-made endpoints

Thin wrappers over the core API with a fixed question set, mirroring the
application endpoints on Jev's hosted API (definitions in `src/presets.mjs`) —
list them at `GET /api/v1/presets`:

* `POST /api/v1/email/triage` — `{subject?, body}` → category, priority, spam, needs_reply, route_to, confidence
* `POST /api/v1/support/triage` — `{subject?, body}` → team, issue_type, severity, urgency, escalate, confidence
* `POST /api/v1/agent/risk` — `{goal?, tool, arguments?, context?}` → action (allow/confirm/block), risk 0–5 score, categories, confidence
* `POST /api/v1/rag/relevance` — `{query, passage}` → relevant, relevance, supports_claim, confidence
* `POST /api/v1/leads/qualify` — `{lead}` → qualified, icp_match, segment, buying_now, route, confidence
* `POST /api/v1/content/moderate` — `{text}` → action, flags, violation_types, confidence

## How it works: Monte Carlo vs logits

The obvious way to get "typed decisions with probabilities" out of a general
LLM is **logprob reading**: force the chosen option to be the model's next
token, request `logprobs`, and read the next-token distribution over the
option tokens. One upstream call, real distribution for free — and almost
certainly what a purpose-built Jev-style model does internally.

It only works if the backend reliably reports the logprob of the token you
care about, and ours does not. Probing showed the reported window is
**nondeterministic**: identical requests have different logprob coverage —
sometimes every completion token except the first, sometimes only the last
one or two — independent of `top_logprobs`, `max_tokens`, temperature or
thinking mode. If you cannot guarantee the option token is in the observable
window, positional logprob reading is a lost cause.

So this service takes **Monte Carlo snap decisions** instead, which needs
nothing but sampling behaviour (stable everywhere):

1. Build a strict-answer prompt — choices are presented as **numbered** options
   and answered as `VERDICT: <number>` (robust for any option key and any
   option count; literal option names are accepted as a fallback parse),
   `VERDICT: <index>` (score), `VERDICT: yes|no` (noul); one line,
   `stop: ["\n"]`, `max_tokens=24`, reasoning disabled via
   `chat_template_kwargs: {"enable_thinking": false}`.
2. Fire N parallel samples (default 16, temp 1.0) through a concurrency
   limiter (default 24; the gateway top limit is 50).
3. Aggregate label frequencies → `probabilities` (light 0.25-pseudocount
   smoothing so unsampled options keep ε mass); `score` = Σ index·p;
   `noul` = P(yes).
4. `confidence` = `1 − normalized_entropy(probabilities)` — a derived,
   explicable measure, not the upstream model's own calibration.

Trade-offs vs. logprob reading (and vs real Jev): N upstream calls to buy the
distribution, resolution quantized at 1/N, and probabilities are sample
*frequencies*, not trained calibration. But each sample is tiny (≤24 output
tokens, no thinking), so a default decision lands in ~0.4 s and a full
multi-question request in ~1 s. All questions in one request evaluate
concurrently, as with Jev's parallel evaluation.

## Demo results (real outputs from a live run)

Captured from `bash examples/smoke.sh` + manual probes against a running
instance. Full JSON with usage in `examples/smoke.sh`.

**Support routing — three question types on one state** (~0.9 s)

```jsonc
// state: "Hi, I have been trying to connect my Stripe account for 3 days and
//         it keeps failing. I am losing sales. Please help ASAP."
"department":  { "type": "choice", "choice": "technical", "probabilities": { "billing": 0.015, "technical": 0.97, "sales": 0.015 }, "confidence": 0.86 }
"frustration": { "type": "score",  "score": 1.0,  "probabilities": { "0": 0.015, "1": 0.97, "2": 0.015 }, "confidence": 0.86 }  // "Frustrated but civil"
"is_urgent":   { "type": "noul",   "noul": 0.98 }
```

The same questions on a cheerful *"loving the product, no rush, have a great
weekend"* bug report → frustration **0.04**, urgent **0.02**.

**Calibrated yes/no ladder — same gate question, three commands**

| command the agent wants to run | `noul` "is this risky?" |
|---|---|
| `ls -la ~/Desktop` | 0.02 |
| `npm install --save-dev prettier` | 0.02 – 0.08 (borderline, run-dependent) |
| `sudo rm -rf / --no-preserve-root` | **0.98** |

**Honest uncertainty instead of a confident wrong label**

```jsonc
// state: "not urgent at all, but the API computes the wrong order_total
//         when a voucher is applied — might impact month-end invoices"
"is_urgent": { "noul": 0.44 }              // the framing says no, money says maybe
"route":     { "choice": "billing", "probabilities": { "billing": 0.61, "bug": 0.37 }, "confidence": 0.33 }
```

Confidence 0.33 ≈ "this is genuinely close" — code can mask on it.

**Ready-made endpoints (their own docs examples, replicated verbatim)**

| endpoint | input | answer |
|---|---|---|
| `/api/v1/email/triage` | "Charged twice… fixed today" | `billing / urgent / spam:false / needs_reply:true / finance` @ 0.81 |
| `/api/v1/support/triage` | "App is down, 500 for all users" | `technical / outage / critical / now / escalate:true` @ 0.83 |
| `/api/v1/agent/risk` | `bash: rm -rf ./dist && aws s3 sync ./build s3://prod --delete` | `block`, risk **3.86**, `[destructive, irreversible, external_side_effect]` |
| `/api/v1/leads/qualify` | "Jane Doe, VP Eng at Acme… evaluating decision APIs this quarter" | `qualified:true / icp_match:ideal / mid_market / buying_now:true / sales` @ 0.86 |
| `/api/v1/content/moderate` | "You are an idiot and I will find where you live" | `block`, flags `[toxicity, harassment, violence, fraud]` |
| `/api/v1/rag/relevance` | query + passage about rotating API keys | `relevant:true / direct answer / supports_claim:true` @ 0.83 |

**Their marketing playground demo — hook analysis** (colorful 5-code call,
~1.8 s) on the *"I quit my $200k job to sell candles…"* post:

```jsonc
"hook_type":        { "choice": "data", "probabilities": { "data": 0.42, "open_loop": 0.30, "bold_claim": 0.19 } }  // honestly split: $200k is data AND bold claim
"opens_loop":       { "noul": 0.98 }   // "here is what nobody tells you…" must be closed by reading on
"first_line_number":{ "noul": 0.98 }   // the $200k figure
"evidence":         { "choice": "claimed", "confidence": 0.86 }   // asserted, never proven
"virality":         { "score": 2.79, "probabilities": { "2": 0.13, "3": 0.84 } }  // "Very likely to spread"
```

## Demo: real Doom (ViZDoom)

`examples/doom-vizdoom.py` plays **real Doom** — the [ViZDoom](https://vizdoom.farama.org/)
engine with the Freedoom IWAD it ships — driven by this decision API, mirroring
TypeSafe's JevDoom launch demo and the Blocks.ai open replica:

```bash
npm start                                    # 1. decision server
python3 -m venv .venv && .venv/bin/pip install vizdoom   # 2. real doom (once)
.venv/bin/python examples/doom-vizdoom.py    # 3. it plays, headless feed
#   --watch    live 640x480 window (HUD + crosshair)
#   --random   seeded random baseline
#   --scenario take_cover | basic | health_gathering ...
```

What's real: the original Doom engine (35 tps, Freedoom `defend_the_center`
arena), monsters as engine-provided object labels, ammo/health/kills from game
variables. What the model answers: one `choice` question per decision —
which action macro; default (`--macros aim`) is `attack / turn_left /
turn_right`, the right policy for hold-position arenas (the marine keeps the
center circle and sweeps for incoming demons; movement macros are available
via `--macros full` for navigation scenarios) — over a small bucketed state string (`health=fine ammo=24
threats: demon ahead-near (+12°)`). Deterministic code owns the rest (the
"motor layer"): a snap-turn that aims the crosshair onto the nearest visible
demon before `attack` fires, and button masks per macro.

Verified behaviour (varies run to run — sampling):

* decision latency median ≈ 290–320 ms → ~3 model decisions/s, so the game
  runs slower than real time (the original demos had the same property)
* a two-phase loop, following the launch-week discipline that deterministic
  code handles what is deterministic: a **sweep phase** (engine-only spins
  the marine while no demon is visible — the model is *not called*, it costs
  nothing) and a **combat phase** (when a demon is visible, the model gets
  the bucketed state, the motor layer closed-loop aims on the nearest demon,
  and the model's `attack` fires only when the sight is actually on-target —
  no more sideways spraying; `attack` when off-target holds fire)
* typical runs land 1–3 kills into the converging horde before dying —
  `defend_the_center` is designed to be unwinnable in the end. TypeSafe said
  it first: *a non-AI bot would play better*. The point is the loop: state →
  typed decision → engine action, inside a real game, with the model only
  consulted when judgment is actually needed (~14 model calls per life, the
  rest is engine sweep).
* random baseline (model-free): comparable kills (2ish) in similar lifetimes;
  the difference is the model fires *on target* (fewer shells per kill) and
  the loop structure generalizes to scenarios where judgment matters.

The advisory-loop contract holds: the engine never waits on the model — on
upstream failure or timeout it applies a default action and continues.

## Configuration (`.env`)

| var | default | |
|---|---|---|
| `PORT` | 8090 | listen port |
| `UPSTREAM_BASE_URL` | `https://inference.alexandra.dk/v1` | gateway |
| `UPSTREAM_API_KEY` | — | gateway key (required) |
| `UPSTREAM_MODEL` | `qwen3.8-flash-next` | upstream model |
| `MODEL_VERSION` | `jev-1.13.0` | versioned id returned for the aliases |
| `SAMPLES` | 16 | MC samples per question |
| `TEMPERATURE` | 1.0 | snap-decision sampling temperature |
| `CONCURRENCY` | 24 | max parallel upstream calls |
| `UPSTREAM_TIMEOUT` | 30000 | upstream timeout (ms) |

## Known limitations

* Probabilities are *frequency estimates*, not RLCD-calibrated values — they
  can be sharp or noisy; they are honest as sample statistics but carry no
  training-backed guarantee.
* MC quantization: default resolution is 1/16 (smoothing blunts the edges).
* English-only by design; 255-option choice questions work via numbered
  answers, but model accuracy thins out on huge option lists (position
  confusion) — that's an upstream-model property, not a format constraint.
* `state` length is not token-billed by us; the gateway's own context limits
  apply (each sample resends the whole state).
* `usage.input_tokens` is the sum across samples (per-question state is resent
  N times), which differs from Jev's billed-once semantic.
