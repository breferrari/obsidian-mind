---
date: 2026-04-23
description: "Future vision for unified partner model — cross-domain data signals, prerequisites, and strategic opportunity"
tags:
  - reference
  - architecture
  - project/partner-intelligence
---

# Partner Intelligence Vision

A vision for unifying Side's fragmented partner data into a coherent, queryable model that enables proactive, AI-driven experiences. Not an active engineering initiative yet — documents the data landscape and the opportunity that the [[Side Company Context#Company BHAG (2026)|BHAG]] unlocks.

**Owner:** TBD
**Team:** [[Platform Team]] (primary), with contributions from [[Payments Team]] and [[TXM Team]]

## Why This Matters

Side's platform processes the full lifecycle of a real estate partner's business, but no system assembles the whole picture. A unified partner model would enable:

- Detecting at-risk partners before they churn
- Identifying expansion-ready partners
- Proactively composing workflows based on signals
- Signal-driven product prioritization over hypothesis-driven planning

## Data Signals by Domain

### Identity ([[Platform Team]])
- Team structure/hierarchy, membership lifecycle, licensing state, brokerage assignment

### Transactions ([[TXM Team]])
- Transaction volume per partner/team, listing prices, market mix, velocity, document completion rates

### Payments ([[Payments Team]])
- Pricing plan/tier, billing history, disbursement volume and timing

### Compliance (Cross-team)
- Audit flags, compliance events, license renewal status

### Engagement (Cross-team)
- App usage, feature adoption, notification response rates, support ticket volume

## Current State: Fragmented

Each domain has its own data store. Cross-domain queries require manual joins or ad-hoc analysis. No system continuously maintains a holistic partner model.

## Target State: Unified Partner Model

A queryable, continuously updated representation of each partner converging data from all domains. Not a single database — a logical model built on existing services, likely powered by BigQuery + event streams.

### What the Model Could Answer

| Question | Domains Involved |
|---|---|
| Which partners are at risk of churning? | Identity, TXM, Payments |
| Which partners are ready for expansion? | Identity, TXM, Compliance |
| Which teams need compliance attention? | Compliance, Identity, TXM |
| Where should Side expand next? | TXM, Identity, Analytics |

## Prerequisites

1. **[[Identity Project|Identity as SoT]]** — operational data must be platform-owned
2. **PIWI completion** — Payments fully integrated with Identity
3. **Domain event infrastructure** — services emit structured events
4. **Data platform maturity** — BigQuery pipelines for cross-domain aggregation

## Related

- [[Side Company Context]]
- [[Side Service Architecture]]
- [[Identity Project]]
- [[Compliance Vision]]
