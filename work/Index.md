---
date: 2026-04-23
description: "Central map of all work notes — active projects, completed work by quarter, decisions log"
tags:
  - index
  - moc
---

# Work Notes

Central map of content. All work notes and decisions link back here. For quick navigation, use [[Home]] or open `bases/Work Dashboard.base`.

**Folder structure**: `active/` = current projects, `archive/` = completed (by year), `incidents/` = incident docs, `1-1/` = meetings.

## Incidents

Incident docs live in `work/incidents/`. See `Incidents.base` for overview.

-

## Active Projects
All projects are locally available at ~/Dev/Code/reside-eng/* - for example side-app is located at ~/Dev/Code/reside-eng/side-app

- [side-app](https://github.com/reside-eng/side-app)-  UIs monorepo (locally at ~/Dev/Code/reside-eng/side-app)
- [provision-service](https://github.com/reside-eng/provision-service) - Backend for provisioning and managing user/team external services
- [identity-service](https://github.com/reside-eng/identity-service) - Backend for managing users/teams/team-members etc
- [workflow-templates](https://github.com/reside-eng/workflow-templates)- CI workflows for all UIs and Backends
- [platform-tools](https://github.com/reside-eng/platform-tools) - Collection of libraries used by UIs and Services
- [platform-functions](https://github.com/reside-eng/platform-functions) - Cloud functions for handling events consumed by identity-service
- [terraform](https://github.com/reside-eng/terraform) - Infrastructure as code for all environments (including load balancers, service accounts, databases etc)
- [terraform-organization](https://github.com/reside-eng/terraform-organization)- Terraform automation for our GCP organization resources (such as secret management)
- [platform-playground](https://github.com/reside-eng/platform-playground)- playground repo for testing out new UIs/utilities before making them production ready (local only)
- [payment-service](https://github.com/reside-eng/payment-service)- 

## Review Prep

-

## Recently Completed

-

## Completed

### Current Quarter
- Integrating 360 Learning (LMS) into provision service
- AI tooling for migrating off of GraphQL into calling services via REST

### Previous Quarters
-

## Reference

Architecture and project context (see `reference/`):

- [[Side Company Context]] — business model, BHAG, terminology, geography
- [[Side Service Architecture]] — three-plane service architecture and principles
- [[Identity Project]] — vision, entities, lifecycle, SoT/PIWI/SSTM initiatives
- [[Compliance Vision]] — rules engine, risk engine, review routing
- [[Notifications Platform]] — multi-channel messaging architecture
- [[Partner Intelligence Vision]] — future unified partner model

## Decisions Log

| Date | Decision | Status | Link |
|------|----------|--------|------|
|      |          |        |      |

## Open Questions

-

## Archive

-
