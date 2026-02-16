---
date: 2026-03-19
topic: devin-v3-api-upgrade
---

# Devin V3 API Upgrade

## What We're Building

Upgrade the Devin sync (`src/sync/devin.ts`) from the legacy V1 API to the V3 API. This moves
authentication from personal legacy API keys to service user credentials (`cog_` prefix keys),
and updates all endpoint URLs to the V3 org-scoped paths.

The sync currently calls `/v1/playbooks` and `/v1/knowledge`. V1 is deprecated — it still works
but receives no new features. V3 is the supported path going forward.

## Plan Requirements

**Minimum plan: Enterprise.**

All knowledge operations (`GET`, `POST`, `PUT`, `DELETE`) require `ManageAccountKnowledge` — an
enterprise-level permission. Playbooks require `ManageOrgPlaybooks` (org-level, all plans), but
since knowledge also needs Enterprise, the effective minimum for full sync is Enterprise.

| Operation | Required Permission | Min Plan |
|-----------|-------------------|----------|
| Playbooks (all CRUD) | `ManageOrgPlaybooks` | Core/Teams |
| Knowledge (all CRUD) | `ManageAccountKnowledge` | **Enterprise** |

## V3 Endpoint Mapping

| Operation | V1 (current) | V3 org (target) |
|-----------|-------------|-----------------|
| List playbooks | `GET /v1/playbooks` | `GET /v3beta1/organizations/{org_id}/playbooks` |
| Create playbook | `POST /v1/playbooks` | `POST /v3beta1/organizations/{org_id}/playbooks` |
| Update playbook | `PUT /v1/playbooks/{id}` | `PUT /v3beta1/organizations/{org_id}/playbooks/{id}` |
| Delete playbook | `DELETE /v1/playbooks/{id}` | `DELETE /v3beta1/organizations/{org_id}/playbooks/{id}` |
| List knowledge | `GET /v1/knowledge` | `GET /v3/organizations/{org_id}/knowledge/notes` |
| Create knowledge | `POST /v1/knowledge` | `POST /v3/organizations/{org_id}/knowledge/notes` |
| Update knowledge | `PUT /v1/knowledge/{id}` | `PUT /v3/organizations/{org_id}/knowledge/notes/{id}` |
| Delete knowledge | `DELETE /v1/knowledge/{id}` | `DELETE /v3/organizations/{org_id}/knowledge/notes/{id}` |

Note: playbooks use `v3beta1` (still in beta); knowledge uses stable `v3`.

## Auth Changes

| | V1 | V3 |
|--|----|----|
| Key type | Personal legacy key | Service user key (`cog_` prefix) |
| Key source | Settings > API Keys (Legacy) | Settings > Service Users |
| Extra config | none | `orgId` required in all requests |

## Why This Approach

Full V3 migration (not a dual-mode approach) is preferred because:

- Dual-mode (auto-detect key type, route to V1 or V3) adds ongoing maintenance burden with two code paths.
- The user base for this tool is small and internal — a clean breaking change is acceptable.
- V1 deprecation means eventually dual-mode fails anyway.
- A helpful error message on non-`cog_` keys covers the migration UX concern without added complexity.

## Key Decisions

- **Full replacement, not dual-mode:** Remove V1 code entirely after V3 migration.
- **`orgId` as required config:** Add `--org-id` CLI flag and `DEVIN_ORG_ID` env var alongside `DEVIN_API_KEY`.
- **Key validation message:** If a non-`cog_` key is detected, emit a clear migration error pointing to Settings > Service Users.
- **Playbooks use `v3beta1`:** Accept the beta label — it's documented, functional, and the only org-level path available.
- **Required permissions:** `ManageOrgPlaybooks` (playbooks, all plans) + `ManageAccountKnowledge` (knowledge, Enterprise). Create service user via Organization Settings > Service Users.
- **Backwards-incompatible change:** Bump minor version and document in README/CHANGELOG.

## Resolved Questions

- **V3 playbook response shape:** Same key fields as V1 — `playbook_id`, `title`, `body`, `macro`. Plus new: `access_type`, `org_id`, `created_at`, `updated_at`, `created_by`, `updated_by`.
- **What permission does the service user need?** `ManageOrgPlaybooks` for playbooks (all plans). `ManageAccountKnowledge` for all knowledge operations (**Enterprise only**). Since the tool syncs both, **Enterprise plan is required**.
- **V3 knowledge response shape:** To be confirmed against live API — field names likely similar to V1 (`note_id`, `body`, `trigger_description`) but need verification during implementation.

## Next Steps

→ `/workflows-plan` for implementation details
