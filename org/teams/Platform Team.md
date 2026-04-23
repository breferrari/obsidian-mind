---
date: 2026-04-23
description: "Platform Engineering team — foundational infrastructure and core domain services powering the Side Brokerage Platform"
tags:
  - team
---

# Platform Team

Platform Engineering is responsible for foundational infrastructure and core domain services powering the Side Brokerage Platform.

**Slack:** #eng-platform | **Email:** eng.platform@side.com

## Leadership

| Person | Title | Location | TZ |
|---|---|---|---|
| [[Nathan Lee]] | Senior Director of Engineering | San Francisco, CA | PT |
| [[Eddie Leffler]] | Software Architect | Denver, CO | MT |
| [[Adriano Castro]] | Principal PM | San Francisco, CA | PT |

## Engineering

| Person | Title | Location | TZ | Sub-Team |
|---|---|---|---|---|
| Alexander Supplee | Sr. Software Engineer | San Francisco, CA | PT | Platform Services, DevOps |
| Frito Alline | Sr. Software Engineer | Remote - NY | ET | Platform Services |
| Mathieu Di Majo | Lead DevOps Engineer | Remote - France | CET | Platform Tools (DevOps) |
| Scott Prue | Principal Software Engineer | Boulder, CO | MT | Platform Services |
| Raj Vanteddu | Sr. Software Engineer | Remote - CA | PT | Platform Services |
| Swetha Vallabhaneni | Lead Data Engineer | Remote - TX | CT | Platform Tools (Data Eng) |

## Sub-Teams

- **Platform Services** — Identity, Provision, Notifications
- **Platform Tools** — DevOps, Data Engineering

## Key Pods

| Pod | Responsibilities |
|---|---|
| **Identity** | User, Team, Brokerage, License, Auth management. See [[Identity Project]] |
| **Provision** | Provisioning/de-provisioning of Side Stack systems (Okta, Side app, Growth Stack) |
| **Tools** | Engineering efficiencies, shareable libraries, CI/CD tooling |
| **DevOps** | GCP infrastructure, Terraform, CI/CD (contact: @engplatform-devops) |
| **Data Engineering** | Data infrastructure, pipelines, BigQuery |
| **Notifications** | Horizontal notification service. See [[Notifications Platform]] |

## Jira & Atlassian

| Resource | Value |
|---|---|
| **Jira project** | [PLAT](https://residenetwork.atlassian.net/browse/PLAT) |
| **Board** | [Board 191](https://residenetwork.atlassian.net/jira/software/c/projects/PLAT/boards/191) |
| **Backlog** | [Board 191 Backlog](https://residenetwork.atlassian.net/jira/software/c/projects/PLAT/boards/191/backlog) |
| **Confluence space** | [PLAT](https://residenetwork.atlassian.net/wiki/spaces/PLAT) (space ID: 1462403076) |
| **Sprint planning** | [Sprint Planning](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/4487053313/Sprint+Planning) |
| **Sprint prefix** | `Platform` (overrides default `PLAT`) |
| **Sprint naming** | `Platform-2026-Sprint-N` (2-week cadence, resets yearly) |
| **Story points field** | `customfield_10100` |

**Required labels:** Every PLAT ticket must have one of:
- `platform-services` — Platform Services (Identity, Provision, Notifications)
- `platform-tools` — Platform Tools (DevOps, Data Engineering)

## Service Ownership

See [[Side Service Architecture]] for the full three-plane model. Platform owns:
- `identity-service` — Users, teams, brokerages, licensing, auth
- `notification-service` — Multi-channel messaging
- `provision-service` — Third-party system access

## Engineering Goals: 2026

1. Data models more accurately represent the business (Company as first-class, proper team hierarchy, multiple offices)
2. Mission-critical data out of third-party systems (Platform Fee out of SFDC, no feature flags as permissions)
3. Data owned in correct domains ([[Identity Project|Identity as SoT]] for user/team data)
4. Easier self-managed setup (Side Stack access, Partner Map visibility, Platform Fee exclusions)
5. Improved testing, SRE, and metrics

## Q1 2026 Priorities

| # | Initiative | Focus |
|---|---|---|
| 1 | [[Identity Project|Identity as SoT]] | Support PIWI, add full CRUD support |
| 2 | PIWI | Missing data points (Live Date, Billing Email), team member tenures |
| 3 | 360Learning | Go GA by end of Q1 |
| 4 | Boomi Deprecation | Wrap up loose ends, support TSS |
| 5 | SSTM | Bug fixes and enhancements for all SSTM workflows |
| 6 | AI Foundations | Support AI-related work for SxS and prod-candidate features |
| 7 | RTB/Tech debt | Testing, SRE, metrics |

## Key Stakeholders

| Person | Role |
|---|---|
| [[Steven Price]] | Approver for SSTM and Identity work |
| [[Ryan Smith]] | Stakeholder; informed on major initiatives |
| Kat Sattele | Associate PM; driver on SSTM |
| Kylie James | Oversees Success Managers and Launch |
| Jill Lemons | Broker Ops; manages broker licenses in Identity |
| [[Curtis Campbell]] | TSS; post-signing systems setup |
| Alex Harvey | Launch; team member transitions and upgrades |

## Related

- [[Side Company Context]]
- [[Side Service Architecture]]
- [[Identity Project]]
- [[Notifications Platform]]
- [[TXM Team]]
- [[Payments Team]]
