---
title: Agent Roles
type: governance
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - governance
  - agents
  - claude-code
related:
  - "[[00 Home]]"
  - "[[Founders and Roles]]"
  - "[[Definition of Done]]"
  - "[[Testing Strategy]]"
depends_on: []
implements: []
validates: []
decision_status: confirmed
---

# Agent Roles

The ten working roles Claude Code executes on this repository. If subagents are available they map
one-to-one; otherwise the same responsibilities are executed sequentially by one agent.

These are **execution roles**, distinct from the **accountability roles** in
[[Founders and Roles]] — an agent can draft a provider requirement, but only a named human can
sign an agreement.

| Role | Responsibility | Primary notes |
|---|---|---|
| Product strategist | Scope, priorities, user journeys, success criteria | [[Product Scope]], [[User Journeys]] |
| Domain architect | State machine, ledger, idempotency, reconciliation, boundaries | [[Transaction State Machine]], [[Ledger Invariants]], [[Idempotency]] |
| Backend engineer | APIs, persistence, auth, workers, provider adapters | [[Architecture]], [[API Contracts]] |
| Frontend / POS engineer | Android and POS flows, printing, offline, states | [[Screen Inventory]], [[Receipt Specification]] |
| UX / UI designer | English/Amharic usability, visual hierarchy, accessibility | [[Design System]], [[Amharic Strings]] |
| Obsidian information architect | Vault, YAML, links, tags, Mermaid, graph structure | [[00 Home]], this vault |
| QA engineer | Unit, integration, contract, E2E, failure-mode, regression | [[Testing Strategy]] |
| Security engineer | Secrets, roles, device binding, webhooks, privacy, threat model | [[Security Model]] |
| DevOps / SRE | Environments, CI/CD, migrations, backups, monitoring, rollback | [[Observability]] |
| Operations / compliance analyst | Agreements, funding, reconciliation, disputes, launch gates | [[Launch Gates]], [[Funding Verification]] |

## Rules binding every role

**Never invent** providers, contracts, commissions, prices, budgets, licensing, or legal approvals.
Where a fact is unknown, write `NOT YET CONFIRMED` and record it in [[Decision Log]] — never a
plausible placeholder that could be mistaken for a real figure.

**Never**

- enable live money by default
- treat a timeout as a failure
- retry an uncertain outcome as a new transaction
- allow client balance manipulation
- hide pending or outage status
- make a reprint a sale
- delete ledger history
- use personal accounts
- claim legal compliance without evidence

**Always**

- inspect before rewriting
- use the smallest reversible change
- document assumptions in `ASSUMPTIONS.md`
- update [[Decision Log]] after each material decision
- ask **only** about safety, law, money, provider contracts, security, or irreversible architecture

## Vault duties

Every role, when it produces a note:

1. Links it from [[00 Home]] in the same action — **no orphan notes**.
2. Uses the frontmatter pattern with `related`, `depends_on`, `implements`, `validates`, `decision_status`.
3. Logs a fix as an incident note in [[Runbooks]] using the [[Incident]] template.
4. Re-runs Graphify so the knowledge graph stays current.

## Related

- [[Founders and Roles]]
- [[Definition of Done]]
- [[Decision Log]]
- [[Runbooks]]

---
Back to [[00 Home]]
