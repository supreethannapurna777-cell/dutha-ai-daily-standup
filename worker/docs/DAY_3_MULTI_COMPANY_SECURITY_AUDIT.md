# Day 3 — Multi-company and security audit

Date: 25 September 2026
Audited release: commit `4b42f98` plus production migration `0019`

## Result

Dutha has solid tenant and project foundations, but the deployed Worker must remain a single-organisation pilot. It is not yet safe to onboard unrelated customer companies into the same deployment because integration credentials and webhook identities are global.

## Verified controls

- Manager sessions are signed, secure, HTTP-only, same-site cookies with an eight-hour expiry.
- Employee sessions are independently signed and scoped to a team-member ID.
- Management routes authenticate before dispatch and inject the verified principal internally.
- Project access checks include tenant ID; project managers require explicit project membership.
- Project/member assignment mutations verify that project, manager and employee belong to the actor's tenant.
- Coordination cases are loaded using tenant ID and project ID before manager decisions.
- Manager, member, case, availability, channel and settings mutations enforce same-origin requests.
- WhatsApp inbound webhooks require a valid Meta HMAC signature.
- Jira inbound webhooks require the configured secret.
- Passwords use salted PBKDF2 hashes; activation tokens are hashed, expiring and single-use.
- Migration `0019` attributes self-service WhatsApp invites to the authenticated employee rather than management user 1.
- The complete preflight passes: 30 test files, 174 tests and 19 ordered migrations.

## P0 multi-company blockers

| Finding | Current state | Required change |
|---|---|---|
| WhatsApp connection | Access token, phone-number ID, app secret, templates and business number are Worker-wide | Tenant integration record plus encrypted secret reference and sender/WABA routing |
| Jira connection | Base URL, email, token, project key and webhook secret are Worker-wide | Project/tenant Jira connection, secret reference and connection-aware webhook routing |
| Atlassian MCP | Authentication is Worker-wide | Tenant connection and scoped context fetch |
| Management recovery login | Environment username/password always maps to tenant 1 admin | Break-glass account outside normal tenant login, audited and disabled by default |
| Webhook correlation | Jira issue ID/key is searched globally | Include Jira connection ID in link uniqueness and webhook lookup |
| Channel identity uniqueness | External WhatsApp identity belongs to the shared sender model | Define whether one phone may join multiple tenants and enforce the chosen policy explicitly |

## Important P1 findings

- Integration health is not displayed per tenant because connections are not tenant resources yet.
- There is no subscription, entitlement or quota enforcement.
- There is no tenant lifecycle for self-registration, suspension, export or deletion.
- Security audit events exist for selected flows but not as one searchable tenant audit log.
- Automated tests cover important tenant/project boundaries, but a complete query-by-query cross-tenant negative suite is still required.

## Release decision

- Approved use: one controlled Aurowise/Dutha pilot deployment.
- Not approved: onboarding an unrelated organisation into the current Worker/D1 instance.
- Safe next architecture: create tenant integration connections and route outbound/inbound operations through a verified connection ID before customer onboarding.

