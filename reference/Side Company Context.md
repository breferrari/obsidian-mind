---
date: 2026-04-23
description: "Side Inc company context — business model, BHAG, terminology, customers, geography, platform vision"
tags:
  - reference
  - org
---

# Side Company Context

Side is a real estate brokerage platform enabling top-producing agents to run their own companies under their own brand without managing traditional brokerage operations. Side handles compliance, licensing, tooling, and support while partners retain ownership and control.

## Business Model

- **Commission splits** — primary revenue; Side takes a share of each transaction
- **SaaS fees** — secondary revenue stream

## Customers

### Founding Partners (ICP)

The ideal customer: an agent who has founded their own company and wants to run their own business/brand rather than sit inside a large brokerage.

ICP characteristics (as of Q4 2022):
- Based in one of Side's active states
- 5-15 years of experience
- Team size: 5-15 producing agents
- Avg. production volume: ~$30MM over 3 years
- Avg. listing price: $750K+
- Listing ratio: ~60%
- GCI: $750K-$7.5MM

### Associates

Transacting agents who are not Founding Partners. ICP: 2+ years experience, $5-15MM production, $750K+ avg listing price.

## Company BHAG (2026)

Migrate all operational data out of Salesforce (SFDC) and into the Side platform. See [[Identity Project]] for the primary initiative driving this.

**Operational data** = data customers and internal teams need to run the business (users, teams, team memberships, licenses, pricing). Distinct from **CRM data** (Sales and PSM workflows), which stays in SFDC.

Target state: [[Identity Project|Identity]] is the source of truth for all operational data. SFDC becomes a consumer, continuing as CRM but no longer functioning as Side's operational database.

## Platform Vision: From Operations to Intelligence

The BHAG is the foundation, not the destination. Migrating operational data creates a machine-readable model of Side's business.

### Strategic Progression

1. **Own the data** (BHAG — in progress) — migrate operational data into the platform
2. **Expose composable capabilities** (partially built) — atomic service primitives via APIs
3. **Unify the partner model** (next) — converge data from Identity, Payments, TXM, Compliance
4. **Build the intelligence layer** (future) — compose capabilities proactively based on partner context

See [[Side Service Architecture]] for the atomic capabilities and [[Partner Intelligence Vision]] for the intelligence layer vision.

## Key Terminology

### People & Roles

| Term | Definition |
|---|---|
| **Partner / Founding Partner** | Agent who founded their company. Has `LEAD` role on root team in Identity. |
| **Associate** | Transacting agent who is not a Founding Partner. Not `LEAD` on the root team. |
| **Team Lead** | An Associate who leads a subteam. Has `LEAD` role on a non-root team. |
| **EO (Extended Offer)** | An Associate with special status/benefits based on production volume. |
| **TC (Transaction Coordinator)** | Supports agents with transaction paperwork. Two types: **Side TCs** (employed by Side) and **Team TCs** (work for agent teams). |
| **Administrator** | Team member in a support/ops role. Identity `MEMBER` role. |
| **inSider** | A Side employee. |

### Entities

| Term | Definition |
|---|---|
| **Person** | A unique human in the Side Platform. |
| **User** | An Identity user representing a Person; authenticated via Okta. |
| **Team** | A hierarchical Identity Team. Root team = Company. |
| **Company** | The root Team in a Team tree structure. |
| **Expansion Market Team** | Sub-team operating in another market, shares Company's brand. |
| **EO Standalone Team** | Sub-team with its own registered name and brand. |
| **ICA** | Independent Contractor Agreement — contract agents/partners sign with Side. |
| **SFDC** | Salesforce — Side's legacy operational data store. |

## Geography

Active in 19 states/territories (as of March 2026): AZ, CA, CO, DC, FL, GA, KY, MA, MD, NC, NJ, NV, NY, OH, OR, SC, TX, VA, WA.

## Key References

- [Side Glossary (Confluence)](https://residenetwork.atlassian.net/wiki/spaces/CM/pages/2830631053/Side+Glossary)
- [Side's ICP (Confluence)](https://residenetwork.atlassian.net/wiki/spaces/CM/pages/2888073265/Side+s+Ideal+Customer+Profile+ICP)
- [Extended Offering Details (Confluence)](https://residenetwork.atlassian.net/wiki/spaces/CM/pages/2864644226/Extended+Offering+-+Official+Details)
- [Identity SoT One-Pager (Confluence)](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/4396023843/Identity+as+Source-of-Truth+One-Pager)

## Related

- [[Side Service Architecture]]
- [[Identity Project]]
- [[Partner Intelligence Vision]]
- [[Platform Team]]
- [[TXM Team]]
- [[Payments Team]]
