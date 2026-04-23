---
date: 2026-04-23
description: "Side's three-plane service architecture — domain, brokerage, and platform planes with architectural principles"
tags:
  - reference
  - architecture
---

# Side Service Architecture

Side's platform is structured across three logical planes with composable atomic capabilities.

## Domain Plane (Lifecycle Managers)

| Service | Current Name | Owner | Purpose |
|---|---|---|---|
| `identity-service` | — | [[Platform Team]] | System of Record for users, licensing, MLS/AOR, brand/team/brokerage structures, auth |
| `txm-service` | `core-service` | [[TXM Team]] | System of Record for real estate transactions |

## Brokerage Plane (Business Core)

| Service | Current Name | Owner | Purpose |
|---|---|---|---|
| `compliance-service` | `audit-service` | Cross-team (TXM primary) | Centralized rules engine, risk engine, process orchestrator |
| `payment-service` | — | [[Payments Team]] | Ledger, pricing plans, monthly billing, disbursements |

## Platform Plane (Shared Capabilities)

| Service | Current Name | Owner | Purpose |
|---|---|---|---|
| `notification-service` | — | [[Platform Team]] | Multi-channel messaging (email, SMS, push) |
| `doc-processor-service` | `transactions-runner-service` | [[TXM Team]] | Stateless worker for PDF generation, OCR, DocuSign |
| `provision-service` | — | [[Platform Team]] | Third-party system access provisioning |

## Architectural Principles

From the [Brokerage Platform Architecture](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/4210524161) workshop (December 2025):

1. **Definition vs. Instance** — Brokerage Plane services define policies ("the class"); Domain Plane services create and store immutable copies ("the object") per transaction/user, preserving history when rules change.
2. **Stateless Utilities** — Heavy processing (PDF generation, OCR, Vision AI) is offloaded to stateless Platform Plane workers that own no business data.
3. **Centralized Brokerage Core** — Compliance, Risk, and Payments logic lives in the Brokerage Plane, consumed by multiple Domain Plane clients for consistency.

## Data Assets

Side's operational data — once unified — constitutes deep understanding of the real estate brokerage business:

- **Partner & team structure** — who runs what, how teams are organized, how they grow
- **Transaction patterns** — volume, listing prices, market mix, seasonal cycles per partner
- **Financial relationships** — pricing plans, billing history, disbursement patterns
- **Compliance health** — license status, document completion, audit flags
- **Engagement signals** — app usage, feature adoption, notification response
- **Market intelligence** — which markets are growing, where partners are expanding

Currently fragmented across SFDC, Identity, TXM, and various syncs. The [[Side Company Context#Company BHAG (2026)|BHAG]] unifies it.

## Related

- [[Side Company Context]]
- [[Identity Project]]
- [[Compliance Vision]]
- [[Notifications Platform]]
- [[Partner Intelligence Vision]]
