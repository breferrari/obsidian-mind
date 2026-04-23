---
date: 2026-04-23
description: "Payments team — owns payment-service for pricing plans, billing, and disbursements"
tags:
  - team
---

# Payments Team

Owns `payment-service` — the ledger, pricing plans, monthly billing, and disbursements for the Side platform.

**Owner:** Tom Bucchere, Sophia Lu

## Key Initiatives

### PIWI — Payments Integration with Identity

The primary cross-team initiative. Integrating payment-service with [[Identity Project|Identity]] as its data source, replacing Salesforce. See [[Identity Project#2. PIWI — Payments Integration with Identity]] for details.

- **Phase I:** Payments reads Team/User/Team Membership from Identity (not SFDC)
- **Phase II:** Payments uses Identity IDs as first-class; removes all SFDC ID dependencies

**Key people:** Tom Bucchere (owner), Matt Ross (engineering driver), [[Eddie Leffler]] (cross-team), [[Adriano Castro]] (stakeholder)

As of April 2026, tentative post-SxS engagement timeline but no hard commitment. PIWI is a **blocker for the [[Side Company Context#Company BHAG (2026)|BHAG]]**.

## Service Architecture

Lives in the **Brokerage Plane** of the [[Side Service Architecture]]:
- `payment-service` — Ledger, pricing plans, monthly billing, disbursements

## Jira

Sprint naming: `PAY-2026-Sprint-N` (2-week cadence)

## Collaborators

| Team | Relevance |
|---|---|
| [[Platform Team]] | Identity data source (PIWI), shared infrastructure |
| [[TXM Team]] | Downstream; disbursements tied to transaction close |
| Broker Ops | Pricing plan management |

## Related

- [[Side Service Architecture]]
- [[Identity Project]]
- [[Platform Team]]
- [[TXM Team]]
- [[Partner Intelligence Vision]]
