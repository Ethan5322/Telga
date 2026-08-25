---
title: 00 Home
type: governance
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - moc
  - home
related:
  - "[[Product Scope]]"
  - "[[Transaction State Machine]]"
  - "[[Launch Gates]]"
  - "[[Decision Log]]"
depends_on: []
implements: []
validates: []
decision_status: confirmed
---

# Telga — Project Home

**Map of Content for the whole Telga project.** Every note in this vault is reachable from here,
and every note links back here. There are no orphan notes.

Telga is the merchant digital-vending platform of **MuleSoo Digital Services** in Ethiopia.
First live product: **airtime vending**. The authoritative instruction set is `CLAUDE.md` at the
repository root.

> [!warning] Current operating state
> **TRAINING MODE — NO REAL VALUE.** No live provider is connected, no live money is enabled,
> and no launch gate in [[Launch Gates]] has been cleared.

---

## 01 Strategy — kept outside this repository

Vision, positioning and market analysis are business strategy rather than build
documentation. Nothing in the source, tests, build, CI or runtime depends on
them, so they stay in the vault on the working machine and are excluded from
publication by `.gitignore`.


## 02 Product

- [[Product Scope]] — what is in the first live release and what is disabled
- [[Roadmap]] — phases 0 to 5 · **Mermaid: roadmap and phases**
- [[User Journeys]] — the counter-level flows · **Mermaid: merchant airtime sale journey**
- [[Feature Flags]] — how disabled means inaccessible, not hidden
- [[Definition of Done]] — the fifteen conditions a feature must meet

## 03 Domain

- [[Domain Glossary]] — the 27 entities and the words we use for them
- [[Transaction State Machine]] — **Mermaid: airtime transaction state machine**
- [[Ledger Invariants]] — the nine rules that tests enforce
- [[Balance Model]] — **Mermaid: available, reserved and under-review balance lifecycle**
- [[Idempotency]] — why an uncertain outcome is never retried as a new sale

## 04 UX UI

- [[Design System]] — tokens, contrast, touch targets, bilingual typography
- [[Screen Inventory]] — the 21 required screens and 14 required states
- [[English Strings]] — the English source of every merchant-facing string
- [[Amharic Strings]] — draft Amharic, **pending native review**
- [[Receipt Specification]]
- [[Merchant POS Screens]] — **Mermaid: the counter journey** · the five built screens
- [[State To UI Mapping]] — **Mermaid: state to screen** · what a merchant may see and do — what prints, and what must never print

## 05 Operations

- [[Merchant Onboarding]] — the four merchant tiers and device controls
- [[Funding Verification]] — **Mermaid: merchant funding verification**
- [[Support and Disputes]] — **Mermaid: customer complaint flow**
- [[Provider Health]] — **Mermaid: outage isolation · provider timeout and manual review**
- [[Runbooks]] — the operational procedures, and the log of every fix
- [[Database Operations Runbook]] — health, ledger residual, migrations, restore
- [[Transaction Failure Runbook]] — triage by state, stuck transactions, reversals
- [[Recovery Sweep Runbook]] — **Mermaid: recovery failure and retry** · daily checks
- [[Manual Review Runbook]] — working an under-review case, and who may authorize a reversal
- [[Worker Operations Runbook]] — **Mermaid: multi-worker claim lease** · restart, inspect, recover
- [[Deployment Runbook]] — sequence, rollback, and what still blocks a deploy
- [[Persistent Host Runbook]] — prerequisite audit for a real training host
- The backup/restore implementation note (implemented separately) — the backup/restore tool that exists, and what still doesn't
- [[Service Startup and Shutdown]] — **Mermaid: startup sequence** · the exact command order
- [[Backup and Restore Runbook]] — design only; launch gate 10 acceptance criteria
- [[Source Specification Clipped In PDF]] — incident: the source PDF was clipped; names reconstructed

## 06 Partnerships — kept outside this repository

Provider assessment, engagement records and agreement terms are commercial
material. They live in the vault on the working machine and are excluded from
publication by `.gitignore`; `npm run docs:validate` fails if a published note
links to one.

Nothing technical depends on them. Where the engineering notes needed a fact
from that side — that no provider is contracted, that commission is not
confirmed — the fact is stated where it is needed.

## 07 Governance

- [[Founders and Roles]] — role charters, **all owners unassigned**
- [[Agent Roles]] — the ten execution roles Claude Code works through
- [[Risk Register]] — **Register H**
- [[Legal Questions]] — **Register J**: legal and banking questions
- [[Launch Gates]] — **Register K**: the ten gates before live money
- [[Decision Log]] — every material decision, with status

## 08 Pilot — kept outside this repository

Pilot planning, budget, merchant selection and measurement are commercial
material, excluded on the same basis as the partnership folder.

## 09 Engineering

- [[Architecture]] — **Mermaid: system architecture**
- [[Domain Implementation Plan]] — the domain-first plan, and what is built
- [[SQLite Persistence Layer]] — **Mermaid: domain-to-persistence boundaries · database write and audit flow**
- [[Migration Strategy]] — **Mermaid: migration lifecycle** · forward-fix only
- [[Transaction Orchestration]] — **Mermaid: createSale sequence · unit-of-work rollback · idempotent retry**
- [[Create Sale Service]] — **Mermaid: success · timeout/pending · failure/release · under review**
- [[Mock Provider Behavior]] — the eight deterministic behaviours
- [[Recovery Sweep]] — **Mermaid: scan · claim · PROCESSING · RESERVED · unknown → pending · escalation**
- [[Recovery Configuration]] — every threshold, and which are still unconfirmed
- [[Recovery Worker]] — **Mermaid: lifecycle · scheduling · backoff · shutdown · health states**
- [[Worker Configuration]] — three policies, and why production never falls back
- [[Build Pipeline]] — how the runtime is compiled, and why CommonJS
- [[Training HTTPS Deployment]] — real TLS for the controlled training machine
- [[Vercel Deployment Limits]] — why a Vercel build is not a running Telga
- [[Training Deployment Architecture]] — **Mermaid: the persistent-host architecture**
- [[Deployment Target Evaluation]] — five hosting categories compared, none purchased
- The health endpoints note (implemented separately) — `/api/health/live` and `/api/health/ready`, implemented and tested
- [[Security Deployment Checklist]] — what deployment security is enforced today, and what is not
- [[TLS and Proxy Configuration]] — where TLS ends, and what may be believed about it
- [[Local Certificate Handling]] — Telga never generates a key
- [[Authentication and Sessions]] — identity from a session, not a URL. Closes A49
- [[Device Binding]] — enrolment, revocation, and why this is training-grade
- [[Threat Model]] — who would attack, and what actually stops them
- [[Training Operations Runbook]] — provisioning, lockouts, lost devices
- [[CI Pipeline]] — **verified green on the remote runner**
- [[Test Stability Runbook]] — how a flake is investigated, and the four we have had
- [[Migration Ownership]] — single-writer migrations, enforced in code
- [[Multi-Process Migration Plan]] — what closing A30 would take
- [[POS API Surface]] — the five training routes, and the four refusals beneath them
- [[API Contracts]] — the provider adapter contract and internal APIs
- [[Security Model]] — RBAC, device binding, secrets, webhooks
- [[Testing Strategy]] — the thirteen required test scenarios
- [[Observability]] — the pilot scorecard metrics

## 99 Templates

- [[Decision]] · [[Meeting Note]] · [[Provider Note]] · [[Merchant Interview]] · [[Incident]]

---

## How this vault is used

1. **No orphan notes.** Before creating a note, decide where it links from and update that index in the same action.
2. **Every fix gets a note.** Errors found and fixed are written up in [[Runbooks]] using the [[Incident]] template.
3. **Every material decision updates [[Decision Log]].**
4. **Re-run Graphify after each batch of notes** so the knowledge graph stays current.

## What is not yet confirmed

| Item | Status | Tracked in |
|---|---|---|
| First airtime provider | NOT YET DECIDED | commercial record, outside this repository |
| Commission rates | NOT YET CONFIRMED | commercial record, outside this repository |
| Pilot budget | NOT YET DECIDED | commercial record, outside this repository |
| Banking and merchant-funds structure | NOT YET CONFIRMED | [[Legal Questions]] |
| Legal / payment authorization | NOT YET CONFIRMED | [[Legal Questions]] |
| Founder identities, equity, signing authority | NOT YET ASSIGNED | [[Founders and Roles]] |
