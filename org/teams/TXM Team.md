---
date: 2026-04-23
description: "Transactions Management team — owns agent-facing transaction workflow, listings, offers, leases, DocuSign, document templates"
tags:
  - team
---

# TXM Team

Transactions Management is responsible for the primary agent-facing application at Side. The team owns the full real estate transaction workflow.

**Primary users:** Real estate agents and Transaction Coordinators (TCs)
**Slack:** #eng-txm | **Email:** txmall@side.com

## Leadership

| Person | Title |
|---|---|
| Scott Attwood | Engineering Manager |
| Jen Sekar | Product Manager |
| Golan Gingold | Product Manager |
| Kai Karrasch | Designer |

## Engineering

| Person | Title | Focus | TZ |
|---|---|---|---|
| Xavier Del Castillo | Lead Software Engineer | Back-end | PT |
| Steven Sullivan | Lead Software Engineer | Front-end | PT |
| Brett Porcelli | Senior Software Engineer | Front-end, full stack | ET |
| Megan Bailey | Senior Software Engineer | Front-end, full stack | ET |
| Stas Danishevskiy | Senior Software Engineer | Back-end, full stack | MT |
| Cristian Muller | Senior Software Engineer | Back-end | ET |

## Domain

TXM owns the full outbound real estate transaction workflow:
- **Listings** — creating and managing property listings
- **Offers** — drafting, negotiating, tracking offers
- **Leases** — lease transaction management
- **DocuSign** — sending and tracking document envelopes for signatures
- **Document Templates** — admin UI tooling for managing transaction document templates

## Service Ownership

| Service | Notes |
|---|---|
| `core-service` (future: `txm-service`) | System of Record for real estate transactions |
| TXM UI | Agent-facing transaction UI in the Side App monorepo |
| `transactions-runner-service` (future: `doc-processor-service`) | PDF generation, OCR, DocuSign |
| Core Functions | Serverless functions supporting transaction workflows |
| Graph API | Part owner (shared) |
| Pantry | Part owner (shared) |

## Jira & Atlassian

| Resource | Value |
|---|---|
| **Jira project** | [CORE](https://residenetwork.atlassian.net/browse/CORE) |
| **Board** | [Board 101](https://residenetwork.atlassian.net/jira/software/c/projects/CORE/boards/101) |
| **Backlog** | [Board 101 Backlog](https://residenetwork.atlassian.net/jira/software/c/projects/CORE/boards/101/backlog) |
| **Confluence** | [Transactions Management](https://residenetwork.atlassian.net/wiki/spaces/ENG/pages/1127841930/Transactions+Management) |
| **Sprint naming** | `TXM-2026-Sprint-N` (2-week cadence) |
| **Story points field** | `customfield_10100` |

## Active Initiatives

### SideXSide (SxS) Deliverables (Q1 2026 Focus)

| Initiative | Description |
|---|---|
| Doc List View | Improved document list UI for agents within transactions |
| Autotagging | Automated tagging of transaction documents |
| AI Chat | In-app AI assistant for transaction workflows |
| Extract and Autopopulate | AI-driven data extraction to autopopulate transaction fields |
| MLS Enhancements | Improvements to MLS data integration |

### Tech Debt & Modernization

| Initiative | Description |
|---|---|
| Graph API Deprecation | Migrating away from shared Graph API toward direct service integrations |
| Leases Refactor | Refactoring leases domain for maintainability |
| Feature Flag -> Identity Scopes | Replacing permanent LaunchDarkly flags with Identity-based permission scopes |

## Key Collaborators

| Team/Person | Relevance |
|---|---|
| Broker Ops | Compliance, document review, post-transaction operations |
| [[Compliance Vision\|Compliance]] | Downstream consumer of transaction data |
| [[Payments Team]] | Downstream consumer; disbursements and billing |
| [[Platform Team]] | Shared services: Identity, Notifications, Provision |

## Related

- [[Side Service Architecture]]
- [[Side Company Context]]
- [[Compliance Vision]]
- [[Identity Project]]
- [[Platform Team]]
- [[Payments Team]]
