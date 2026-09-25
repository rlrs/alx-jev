#!/usr/bin/env bash
# Smoke test for alx-jev. Start the server first: npm start
set -euo pipefail
BASE="${BASE:-http://localhost:8090}"
KY="${KEY:-test}"

say() { echo; echo "== $1"; }

say "health"
curl -s "$BASE/healthz"; echo

say "models"
curl -s "$BASE/v1/models"; echo

say "core /v1/systemone (choice + score + noul)"
curl -s "$BASE/v1/systemone" \
  -H "Authorization: Bearer $KY" -H "Content-Type: application/json" -d '{
  "state": "Hi, I have been trying to connect my Stripe account for 3 days and it keeps failing. I am losing sales. Please help ASAP.",
  "model": "jev-latest",
  "questions": {
    "department": { "type": "choice", "instructions": "Which team should handle this",
      "criteria": { "billing": "Payment or subscription issues", "technical": "Bugs or integration problems", "sales": "Pricing or account questions" } },
    "frustration": { "type": "score", "instructions": "How frustrated the customer appears",
      "criteria": ["Calm, just stating facts", "Frustrated but civil", "Very angry, strong language"] },
    "is_urgent": { "type": "noul", "instructions": "The message conveys urgency or time-sensitivity" }
  }
}'; echo

say "high-sample mode (smoother distribution)"
curl -s "$BASE/v1/systemone" \
  -H "Authorization: Bearer $KY" -H "Content-Type: application/json" -d '{
  "state": "The prod dashboard returns 500 for all users since 10:00.",
  "model": "jev-latest",
  "questions": { "severity": { "type": "choice", "instructions": "How bad is this?",
    "criteria": { "low": "cosmetic", "medium": "workaround exists", "high": "blocked user", "critical": "production down" } } },
  "samples": 32
}'; echo

say "hook demo via core API (numbered multi-word options, \"candles\" post)"
curl -s "$BASE/v1/systemone" \
  -H "Authorization: Bearer $KY" -H "Content-Type: application/json" -d '{
  "state": "I quit my $200k job to sell candles. Here is what nobody tells you about starting a business: 90% of first-year founders skip the one step that actually made me profitable.",
  "model": "jev-latest",
  "questions": {
    "hook_type": { "type": "choice", "instructions": "What kind of hook does the first line use?",
      "criteria": { "open_loop": "raises a curiosity the reader must keep reading to close", "bold_claim": "a striking or provocative assertion", "story": "starts a narrative", "data": "leads with a number or figure", "none": "no particular hook" } },
    "opens_loop": { "type": "noul", "instructions": "Does the hook open a curiosity loop the reader has to keep reading to close?" },
    "first_line_number": { "type": "noul", "instructions": "Does the first line contain a specific number or dollar figure?" },
    "evidence": { "type": "choice", "instructions": "How is the claim backed up?",
      "criteria": { "demonstrated": "shows proof: numbers, screenshots, results", "claimed": "asserted in words only", "none": "no support at all" } },
    "virality": { "type": "score", "instructions": "How strong is this post viral potential?",
      "criteria": ["Would not circulate", "Mild interest", "Likely shares", "Very likely to spread"] }
  }
}'; echo

say "validation 422"
curl -s "$BASE/v1/systemone" -H "Authorization: Bearer $KY" \
  -d '{"state":"x","model":"jev-latest","questions":{"a":{"type":"nope","instructions":"i"}}}'; echo

say "auth 401"
curl -s "$BASE/v1/systemone" -d '{}'; echo

say "preset: email triage"
curl -s "$BASE/api/v1/email/triage" -H "Authorization: Bearer $KY" \
  -d '{"subject":"Charged twice","body":"I was charged twice and need this fixed today."}'; echo

say "preset: agent risk"
curl -s "$BASE/api/v1/agent/risk" -H "Authorization: Bearer $KY" \
  -d '{"goal":"Clean up the build directory","tool":"bash","arguments":"rm -rf ./dist && aws s3 sync ./build s3://prod --delete","context":"CI deploy step"}'; echo

say "preset: rag relevance"
curl -s "$BASE/api/v1/rag/relevance" -H "Authorization: Bearer $KY" \
  -d '{"query":"How do I rotate my API key?","passage":"To rotate a key, open Settings > API keys, click Revoke, then Create new key. Update your env variable."}'; echo
