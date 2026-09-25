// Ready-made application endpoints: each is the core decision API with a
// fixed set of questions and a mapped response shape (mirrors Jev's
// hosted application endpoints).

const bool = (noul) => noul > 0.5;
const conf = (answers, keys) => {
  const vals = keys.map((k) => answers[k]?.confidence).filter((x) => typeof x === 'number');
  if (!vals.length) return undefined;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
};

export const presets = {
  '/api/v1/email/triage': {
    doc: 'Email Triage',
    required: ['body'],
    build: (req) => {
      const stateText = `Subject: ${req.subject ?? '(none)'}\n\n${req.body}`;
      return {
        stateText,
        questions: {
          category: {
            type: 'choice',
            instructions: 'What kind of email is this?',
            criteria: {
              billing: 'payments, invoices, charges, refunds',
              technical: 'bugs, outages, integrations',
              sales: 'pricing, demos, purchasing',
              feedback: 'praise, complaints, suggestions',
              other: 'anything else',
            },
          },
          priority: {
            type: 'choice',
            instructions: 'How important is a fast response?',
            criteria: { low: 'can wait a week', medium: 'within a day or two', high: 'same day', urgent: 'costing money or trust right now' },
          },
          spam: { type: 'noul', instructions: 'Is this spam or automated bulk mail?' },
          needs_reply: { type: 'noul', instructions: 'Does this email need a reply from us?' },
          route_to: {
            type: 'choice',
            instructions: 'Which team inbox should it go to?',
            criteria: {
              finance: 'billing, invoices, refunds',
              engineering: 'bugs and outages',
              sales: 'prospects and pricing questions',
              support: 'customer help',
              management: 'sensitive or escalated matters',
            },
          },
        },
        map: (answers) => ({
          category: answers.category.choice,
          priority: answers.priority.choice,
          spam: bool(answers.spam.noul),
          needs_reply: bool(answers.needs_reply.noul),
          route_to: answers.route_to.choice,
          confidence: conf(answers, ['category', 'route_to']),
        }),
      };
    },
  },

  '/api/v1/support/triage': {
    doc: 'Support Ticket Triage',
    required: ['body'],
    build: (req) => {
      const stateText = `Subject: ${req.subject ?? '(none)'}\n\n${req.body}`;
      return {
        stateText,
        questions: {
          team: {
            type: 'choice',
            instructions: 'Which team should handle this ticket?',
            criteria: {
              billing: 'payments, subscriptions, invoices',
              technical: 'bugs, outages, integrations',
              sales: 'pricing, renewals, accounts',
              account: 'login, access, settings',
            },
          },
          issue_type: {
            type: 'choice',
            instructions: 'What is the core issue type?',
            criteria: {
              outage: 'service is down or broken for many users',
              bug: 'something misbehaves',
              billing: 'money issue',
              how_to: 'usage question',
              complaint: 'frustration without a concrete defect',
            },
          },
          severity: {
            type: 'choice',
            instructions: 'How severe is the issue?',
            criteria: { low: 'cosmetic', medium: 'workaround exists', high: 'blocked user', critical: 'production down, many users affected' },
          },
          urgency: {
            type: 'choice',
            instructions: 'How fast must we respond?',
            criteria: { now: 'minutes', today: 'hours', soon: 'one or two days', whenever: 'a week is fine' },
          },
          escalate: { type: 'noul', instructions: 'Escalate to a human immediately?' },
        },
        map: (answers) => ({
          team: answers.team.choice,
          issue_type: answers.issue_type.choice,
          severity: answers.severity.choice,
          urgency: answers.urgency.choice,
          escalate: bool(answers.escalate.noul),
          confidence: conf(answers, ['team', 'severity']),
        }),
      };
    },
  },

  '/api/v1/agent/risk': {
    doc: 'Agent Risk Check — gate a proposed tool call',
    required: ['tool'],
    build: (req) => {
      const stateText = [
        `Agent goal: ${req.goal ?? '(none)'}`,
        `Tool: ${req.tool}`,
        `Arguments: ${typeof req.arguments === 'string' ? req.arguments : JSON.stringify(req.arguments ?? null)}`,
        req.context ? `Context: ${req.context}` : '',
      ].filter(Boolean).join('\n');
      return {
        stateText,
        questions: {
          action: {
            type: 'choice',
            instructions: 'Should this tool call be executed?',
            criteria: {
              allow: 'routine, safe, reversible, matches the goal',
              confirm: 'plausible but sensitive: ask the user before running',
              block: 'destructive, dangerous, or off-goal',
            },
          },
          risk: {
            type: 'score',
            instructions: 'How risky is this call?',
            criteria: [
              'trivially safe and reversible',
              'normal file/network read',
              'writes within the project',
              'touches many files or external systems',
              'destructive or affects production',
            ],
          },
          destructive: { type: 'noul', instructions: 'Is the call destructive?' },
          irreversible: { type: 'noul', instructions: 'Is the effect hard to undo?' },
          external_side_effect: { type: 'noul', instructions: 'Does it act outside the local machine or repo?' },
          data_exposure: { type: 'noul', instructions: 'Could it leak sensitive data?' },
        },
        map: (answers) => ({
          action: answers.action.choice,
          risk: answers.risk.score,
          categories: [
            answers.destructive.noul > 0.5 && 'destructive',
            answers.irreversible.noul > 0.5 && 'irreversible',
            answers.external_side_effect.noul > 0.5 && 'external_side_effect',
            answers.data_exposure.noul > 0.5 && 'data_exposure',
          ].filter(Boolean),
          confidence: conf(answers, ['action']),
        }),
      };
    },
  },

  '/api/v1/rag/relevance': {
    doc: 'RAG Relevance — does a passage answer the query?',
    required: ['query', 'passage'],
    build: (req) => ({
      stateText: `Query: ${req.query}\n\nPassage: ${req.passage}`,
      questions: {
        relevant: { type: 'noul', instructions: 'Does the passage help answer the query?' },
        relevance: {
          type: 'choice',
          instructions: 'How well does the passage answer the query?',
          criteria: {
            irrelevant: 'off-topic',
            tangential: 'touches the topic but does not answer it',
            related: 'partially answers it',
            'direct answer': 'answers the question directly',
          },
        },
        supports_claim: { type: 'noul', instructions: 'Would citing this passage support an answer without contradiction?' },
      },
      map: (answers) => ({
        relevant: bool(answers.relevant.noul),
        relevance: answers.relevance.choice,
        supports_claim: bool(answers.supports_claim.noul),
        confidence: conf(answers, ['relevance']),
      }),
    }),
  },

  '/api/v1/leads/qualify': {
    doc: 'Lead Qualify',
    required: ['lead'],
    build: (req) => ({
      stateText: req.lead,
      questions: {
        qualified: { type: 'noul', instructions: 'Is this a qualified lead worth pursuing?' },
        icp_match: {
          type: 'choice',
          instructions: 'How well does the lead fit our ideal customer profile?',
          criteria: {
            ideal: 'clearly matches: right size, role and need',
            partial: 'matches on some dimensions',
            poor: 'does not match',
          },
        },
        segment: {
          type: 'choice',
          instructions: 'Which company size segment?',
          criteria: {
            smb: 'under 100 employees',
            mid_market: '100 to 1000 employees',
            enterprise: 'over 1000 employees',
          },
        },
        buying_now: { type: 'noul', instructions: 'Are they looking to buy in the near term (this quarter)?' },
        route: {
          type: 'choice',
          instructions: 'Where should this lead go?',
          criteria: {
            sales: 'talk to a salesperson now',
            nurture: 'marketing emails until ready',
            reject: 'not worth pursuing',
          },
        },
      },
      map: (answers) => ({
        qualified: bool(answers.qualified.noul),
        icp_match: answers.icp_match.choice,
        segment: answers.segment.choice,
        buying_now: bool(answers.buying_now.noul),
        route: answers.route.choice,
        confidence: conf(answers, ['icp_match', 'route']),
      }),
    }),
  },

  '/api/v1/content/moderate': {
    doc: 'Content Moderation',
    required: ['text'],
    build: (req) => ({
      stateText: req.text,
      questions: {
        action: {
          type: 'choice',
          instructions: 'What should happen with this content?',
          criteria: {
            allow: 'fine to publish',
            review: 'borderline: send to human moderation',
            block: 'clear policy violation',
          },
        },
        toxicity: { type: 'noul', instructions: 'Does it contain toxic or insulting language?' },
        harassment: { type: 'noul', instructions: 'Does it harass or target a person?' },
        violence: { type: 'noul', instructions: 'Does it contain threats or violent content?' },
        sexual: { type: 'noul', instructions: 'Is it sexual content?' },
        self_harm: { type: 'noul', instructions: 'Does it encourage self-harm?' },
        spam: { type: 'noul', instructions: 'Is it spam or advertising?' },
        fraud: { type: 'noul', instructions: 'Is it a scam or fraud attempt?' },
        pii: { type: 'noul', instructions: 'Does it expose personal data (addresses, phones, IDs)?' },
      },
      map: (answers) => {
        const flags = {
          toxicity: bool(answers.toxicity.noul),
          harassment: bool(answers.harassment.noul),
          violence: bool(answers.violence.noul),
          sexual: bool(answers.sexual.noul),
          self_harm: bool(answers.self_harm.noul),
          spam: bool(answers.spam.noul),
          fraud: bool(answers.fraud.noul),
          pii: bool(answers.pii.noul),
        };
        return {
          action: answers.action.choice,
          flags,
          violation_types: Object.entries(flags).filter(([, v]) => v).map(([k]) => k),
          confidence: conf(answers, ['action']),
        };
      },
    }),
  },
};
