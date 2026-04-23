---
date: 2026-04-23
description: "Notifications platform service — multi-channel messaging architecture, Courier integration, delivery preferences"
tags:
  - reference
  - architecture
  - project/notifications
---

# Notifications Platform

Horizontal platform service enabling any feature team to send configurable, personalized notifications to Side App users across multiple channels.

**Owner:** [[Adriano Castro]] (PM)
**Approvers:** [[Adriano Castro]], Amy Malanga, [[Steven Price]]
**Team:** [[Platform Team]]

## Channels

| Channel | Provider | Status |
|---|---|---|
| Email | Mandrill | Live |
| SMS | Twilio | Live |
| Mobile Push | OneSignal | Live |
| In-App / Inbox | Courier | Not yet supported |

## Architecture

- **Platform:** [Courier](https://www.courier.com/)
- **Notification Service** accepts: User ID(s), Topic ID, Subject, Body, URL — looks up user channel preferences — routes to selected channels
- **Delivery Preferences UI:** [agent.sideinc.com notification-preferences](https://agent.sideinc.com/identity/user/account/notification-preferences)
- **Shared library:** `@side/notifications` in `platform-tools`

### Key Concepts

| Concept | Description |
|---|---|
| **Event** | User action, data change, scheduled task, or trigger warranting a notification |
| **Channel** | Delivery method (email, SMS, push, in-app) |
| **Topic** | Category of events; users set channel preferences per topic |
| **Section** | Grouping of topics in preferences UI |

### Template Conventions

- **Naming:** `<Product Area>: Notification Name` (e.g. `TXM: Offer Accepted`)
- **Alias:** `<product_area>_notification_name` (e.g. `txm_offer_accepted`)
- **Link instrumentation:** UTM params per channel (`utm_source=notification&utm_medium=<channel>&sltProductArea=<area>&sltTopic=<topic>`)
- **Error handling:** On send failure, falls back to in-app notification + failure notice

## Confluence Documentation

| Page | Description |
|---|---|
| [Notifications Vision](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/3389292595) | Product vision |
| [Creation, Management, & Monitoring](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/3536224314) | How-to guide for Courier templates |
| [Delivery Preferences Center](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/3477733394) | User preferences UI spec |
| [Link Instrumentation](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/3456335901) | UTM and tracking |
| [Guidelines and Best Practices](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/3454664732) | Template naming, content guidelines |
| [Courier Notifications Runbook](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/3496542246) | Ops runbook, monitors |
| [Handling Notification Failures](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/3511156756) | DACI for failure handling |
| [License Renewal & Expiration](https://residenetwork.atlassian.net/wiki/spaces/PLAT/pages/4008411145) | License expiration notification spec |

## Related

- [[Side Service Architecture]]
- [[Platform Team]]
- [[Identity Project]]
