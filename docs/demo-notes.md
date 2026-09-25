# Demo notes for colleagues

*Context: a colleague said "wow, Jev is cool and probably not just an LLM."
This is the demo that shows: it is (well — you can get the API shape from one).*

TL;DR: the Jev contract — typed decisions with probabilities instead of prose —
can be reproduced from a stock instruction-tuned LLM with **one strict answer
format + Monte Carlo sampling**. No special weights needed for the shape.

- Qwen reasoning off via `chat_template_kwargs: {"enable_thinking": false}`.
- One-line strict answers: `VERDICT: <option>` (choice), `VERDICT: <index>` (score),
  `VERDICT: yes|no` (noul), `max_tokens=24`, `stop: ["\n"]`.
- Fire N samples in parallel (default 16, temp 1.0) → label frequencies are the
  probability distribution (with light 0.25-pseudocount smoothing).
- `score` = Σ index·p; `confidence` = 1 − normalized entropy of the distribution.

## Run it

```bash
npm start          # listens on :8090 (.env holds the gateway key)
```

## Core contract (choice + score + noul in one call)

```bash
curl -s localhost:8090/v1/systemone -H "Authorization: Bearer x" \
  -H "Content-Type: application/json" -d '{
 "state": "Hi, I have been trying to connect my Stripe account for 3 days and it keeps failing. I am losing sales. Please help ASAP.",
 "model": "jev-latest",
 "questions": {
  "department": {"type":"choice","instructions":"Which team should handle this",
    "criteria":{"billing":"Payment or subscription issues","technical":"Bugs or integration problems","sales":"Pricing or account questions"}},
  "frustration": {"type":"score","instructions":"How frustrated the customer appears",
    "criteria":["Calm, just stating facts","Frustrated but civil","Very angry, strong language"]},
  "is_urgent": {"type":"noul","instructions":"The message conveys urgency or time-sensitivity"}
 }}' | python3 -m json.tool
```

Output: `technical @ 0.97`, frustration `1.06` (probability mass on level 1),
`noul 0.98`.

## Their marketing demos, replicated

Hook analysis — their playground demo, but via the plain core API so you can
see there's nothing special in the question wiring (their classic
"$200k candles" post):

```bash
curl -s localhost:8090/v1/systemone -H "Authorization: Bearer x" \
  -H "Content-Type: application/json" -d '{
 "model": "jev-latest",
 "state": "I quit my $200k job to sell candles. Here is what nobody tells you about starting a business: 90% of first-year founders skip the one step that actually made me profitable.",
 "questions": {
  "hook_type": {"type":"choice","instructions":"What kind of hook does the first line use?",
    "criteria":{"open_loop":"raises a curiosity the reader must keep reading to close","bold_claim":"a striking or provocative assertion","story":"starts a narrative","data":"leads with a number","none":"no particular hook"}},
  "opens_loop": {"type":"noul","instructions":"Does the hook open a curiosity loop the reader has to keep reading to close?"},
  "first_line_number": {"type":"noul","instructions":"Does the first line contain a specific number or dollar figure?"},
  "evidence": {"type":"choice","instructions":"How is the claim backed up?",
    "criteria":{"demonstrated":"shows proof: numbers, screenshots, results","claimed":"asserted in words only","none":"no support at all"}},
  "virality": {"type":"score","instructions":"How strong is this post viral potential?",
    "criteria":["Would not circulate","Mild interest","Likely shares","Very likely to spread"]}
 }}' | python3 -m json.tool
# → hook_type: bold_claim, opens_loop: 0.98, first_line_number: 0.98,
#   evidence: claimed, virality ~2.6 (their playground shows the same shape)

curl -s localhost:8090/api/v1/leads/qualify -H "Authorization: Bearer x" \
  -d '{"lead":"Jane Doe, VP Eng at Acme (500 employees). We are evaluating decision APIs to replace a brittle rules engine — hoping to pick something this quarter."}' \
  | python3 -m json.tool
# → qualified, ideal, mid_market, buying_now, sales — matches their doc example

curl -s localhost:8090/api/v1/agent/risk -H "Authorization: Bearer x" \
  -d '{"tool":"bash","arguments":"sudo rm -rf / --no-preserve-root"}' \
  | python3 -m json.tool
# → block, risk 3.9 (swap the command for `ls` → risk ~1)
```

## Latency

Single question ~350–420 ms (16 upstream samples in parallel); full 3-question
call ~1 s; presets ~1.7 s. Flat in question count, scales with `samples`.

## Honest caveats

- Probabilities are sample *frequency estimates*, not RLCD-calibrated values.
  The shape matches; the training-backed calibration does not.
- Resolution is quantized at 1/N (16 samples → 1/16). Borderline inputs can
  move ±0.1 between runs; raise `samples` in the request for finer/slower.
- We resend `state` once per sample → N× token usage vs a real Jev call.
