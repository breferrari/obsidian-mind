---
date: 2026-04-23
description: "Identity domain deep dive — vision, design principles, entities, lifecycle, SoT/PIWI/SSTM initiatives, BHAG dependency chain"
tags:
  - reference
  - architecture
  - project/identity
---

# Identity Project

Identity is the foundational domain at Side for all people and organizational data. It is the authoritative system of record and lifecycle authority for Users, Teams, Team Members, Brokerages, AORs, and MLSs.

**Owner:** [[Adriano Castro]] (PM), [[Eddie Leffler]] (Architect)
**Team:** [[Platform Team]]

## Vision

Identity will be the single authoritative write surface and lifecycle authority for all people and team structures that participate in brokerage operations at Side. Other systems — including Salesforce — will consume Identity data but will not define or mutate it.

As of April 2026, critical operational data is still created/driven by SFDC and synchronized into Identity. The goal is for Identity to own this truth directly.

## Design Principles

1. **Compliance First** — correctness, auditability, and regulatory safety over convenience
2. **Single Write Authority** — Identity is the sole system that creates/mutates Identity-owned data
3. **Stable Contracts, Additive Evolution** — favor adding new fields/states over redefining existing ones
4. **Lifecycle as a Trusted Signal** — lifecycle statuses are the canonical interpretation of transactability
5. **Temporal Truth Matters** — support "what was true at any point in time" for audits and reporting
6. **Constrained Self-Service** — self-service enabled but never at the expense of compliance or integrity
7. **Identity Serves the Platform** — other systems adapt to Identity's model, not vice versa

## Core Entities

| Entity | Description | SoT Status (Apr 2026) |
|---|---|---|
| **User** | A person in the Side platform | SoT in Identity |
| **Team** | Hierarchical group operating under a brand | SoT in progress (Q2 2026) |
| **Team Member** | User's membership in a team (role, tenure, lifecycle) | TODO (EOY 2026) |
| **Brokerage** | Licensed brokerage entity | SoT in Identity |
| **AOR** | Association of Realtors membership | SoT in Identity |
| **MLS** | Multiple Listing Service membership | SoT in Identity |
| **License** | Real estate license (number, state, type, expiration) | SoT in Identity |

## Roles

**Global Roles** (platform-wide, internal): `ADMIN`, `BROKER`, `TRANSACTION_COORDINATOR`, `AUDITOR`, `PAYMENT_SPECIALIST`

**Team Member Roles** (within a team): `LEAD`, `AGENT`, `REFERRAL_AGENT`, `TRANSACTION_COORDINATOR`, `MEMBER`

| Identity Role | Business Label |
|---|---|
| `LEAD` on root team | Founding Partner |
| `AGENT` (not `LEAD`) | Associate Agent |
| `REFERRAL_AGENT` | Referral Agent |
| `LEAD` on Expansion Market team | Team Lead Associate |
| `LEAD` on EO Standalone/Co-Brand | EO Team Lead |
| `TRANSACTION_COORDINATOR` | Transaction Coordinator |
| `MEMBER` | Administrator |

## Lifecycle States

| State | Meaning |
|---|---|
| `Draft` | Record created but not yet operational — hard deletes allowed |
| `Onboarding` | Being set up (contract, license transfer, systems) |
| `Active` | Fully operational, allowed to transact |
| `Offboarding` | Departing (license transfer, listing transfer) |
| `Inactive` | No longer operational on the platform |

Lifecycle-critical data: Contract Sign/End Date, License Transfer/Termination Date, Team Launch Date, License Number/State/Expiration.

## Domain Boundaries

### What Identity Owns
- All entity data for Users, Teams, Team Members, Brokerages, AORs, MLSs
- Lifecycle definitions, transitions, enforcement
- License data, contract dates, roles and role changes
- References to external systems (Okta ID, SFDC Contact ID)

### What Identity Does NOT Own
- **Transactions** — owned by [[TXM Team]]
- **Pricing Plans / Billing** — owned by [[Payments Team]] (consumes Identity via PIWI)
- **Contract content** (ICA documents) — managed via DocuSign
- **CRM workflows** — Sales/PSM workflows remain in SFDC
- **Authentication** — Okta owns auth; Identity creates Okta users and syncs

### Relationship to Salesforce
- Today: SFDC events trigger syncs into Identity
- Target: Identity pushes authoritative data to SFDC
- Post-SoT: SFDC changes do not propagate back to Identity
- SFDC continues as CRM for Sales/PSM

## Active Initiatives

### 1. Identity as Source of Truth (SoT)

**Status:** Ongoing — foundational prerequisite for everything below
**Owner:** [[Adriano Castro]]

Migrating operational data ownership from SFDC to Identity. Staged per entity:
- **Users:** SoT complete
- **Teams:** In progress, targeting Q2 2026. Includes syncing to SFDC as read-only
- **Team Members:** Targeting EOY 2026. Includes lifecycle (tenures, dates)

SFDC sync feature flags: `identityContactWrite`, `identityAccountWrite`, `identityTeamContactWrite`

See [Identity Source of Truth (Confluence)](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/4283105282).

### 2. PIWI — Payments Integration with Identity

**Status:** In progress — targeting H1 completion for Phases I & II
**Owner:** Tom Bucchere ([[Payments Team]]); [[Adriano Castro]] key stakeholder; Matt Ross main engineering driver; [[Eddie Leffler]] cross-team engineering

- **Phase I:** Payments reads Team/User/Team Membership from Identity (not SFDC)
- **Phase II:** Payments uses Identity IDs as first-class; removes all SFDC ID dependencies

As of April 2026, tentative timeline for post-SxS Payments engagement, but no hard commitment. PIWI is a **blocker for the BHAG** and a **hindrance for SoT** progress without active Payments engagement.

### 3. SSTM — Self-Service Team Management

**Status:** Rolling out milestone by milestone
**Driver:** Kat Sattele (PM) | **Overseer:** [[Adriano Castro]]

Transforms team management from manual, SM-driven process into Partner-led, in-app experience.

| Milestone | Status | Notes |
|---|---|---|
| **PoLO** (Post-Launch Onboarding) | Live Q3 2025 | In-app onboarding for Associate Agent, Referral Agent, TC, Admin |
| **Update Roles** | Live Q1 2026 | Role changes: upgrades, downgrades, adding roles |
| **Offboarding** | TBD (H2 2026) | — |
| **EO / Multi-state support** | TBD | — |
| **Pricing Plan Amendments** | TBD | Requires PIWI |
| **Contract Automation** | Future | Auto-generation, sending, tracking of ICAs |

See [SSTM Vision (Confluence)](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/4235427841).

## BHAG Dependency Chain

```
BHAG: Move all operational data out of Salesforce
  |
  v
Identity as Source of Truth (Platform team)
  |
  v
PIWI — Payments Integration with Identity (Payments team)
  |
  v
Direct Pricing Plan integration (replace onboarding's custom UI with Payments')
```

## Future Capabilities Unlocked by SoT

- Company and Multiple Offices — richer organizational structures
- Bring-Your-Own-Broker models
- Franchise support
- AI-driven workflows — reliable data foundation for automation
- Contract Automation — automated ICA generation, sending, tracking
- Expanded self-service

## Architecture

- **identity-service** — Fastify 5 backend
- **Identity Admin UI** — internal-only interface for managing Identity data
- **Side App** — customer-facing (agent.sideinc.com); SSTM workflows live here
- **SFDC Sync** — event-based integration via Platform Functions
- **Okta Integration** — Identity creates Okta users on creation, syncs updates

## Confluence Documentation

| Page | Description |
|---|---|
| [Identity SoT One-Pager](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/4396023843) | Executive summary — SFDC migration rationale, milestones |
| [Identity Source of Truth](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/4283105282) | Detailed SoT backlog and timeline |
| [Identity Vision](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/3397189713) | Original northstar (June 2024) |
| [Product Vision <> Platform/Identity](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/3256418305) | Maps Identity to broader product roadmap |
| [SSTM Vision](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/4235427841) | Onboarding, role changes, offboarding |
| [PoLO Vision](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/3737157633) | Detailed onboarding workflow |
| [SSTM IA](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/4247158814) | Information architecture for team management |

## Related

- [[Side Company Context]]
- [[Side Service Architecture]]
- [[Platform Team]]
- [[Payments Team]]
- [[Compliance Vision]]
- [[Partner Intelligence Vision]]
