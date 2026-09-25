# Day 5 — Controlled demonstration and prioritised backlog

## Demo objective

Prove one real Aurowise/Dutha workflow from scheduled prompt to verified blocker resolution, with database and UI evidence at every transition.

## Demo sequence

1. Show the production version and health endpoint.
2. Show the active WhatsApp templates and exact `en_US` names.
3. Let the scheduler send a real initial request to the approved pilot members.
4. Leave one approved test participant unanswered and demonstrate reminder 1.
5. Submit a real blocker reply and show its processed update and coordination case.
6. Approve the case, assign the responsible member and open the created Jira ticket.
7. Collect availability and show automatic common-time selection.
8. Save the meeting link and show submitted/delivered/read or failed status.
9. Move Jira to Done, show resolution evidence, then verify the resolution.
10. Show the event timeline and final resolved case.

## Evidence checklist

- Git commit and Cloudflare version ID
- No pending D1 migrations
- Preflight: 30 files / 174 tests / 19 migrations
- Initial and reminder rows with no Meta `#132001` error
- At least one WhatsApp `delivered` callback, not only `sent`
- Jira issue URL and return-webhook events
- Availability selections and agreed time
- Meeting-notification delivery state
- Resolution evidence and verification event

## Prioritised backlog

### P0 — before another company

1. Tenant integration connection model and encrypted secret references.
2. Per-connection WhatsApp sender/template routing.
3. Per-project Jira connection and connection-aware webhook correlation.
4. Cross-tenant negative test suite for every manager and integration route.
5. Tenant lifecycle, administrator onboarding and audited break-glass access.

### P1 — pilot quality

1. Executive control-tower shell and portfolio/project KPIs.
2. Integration health page with retry/error visibility.
3. Delivery and response funnel with correct status semantics.
4. Central tenant audit log and export.
5. Opt-out, consent and roster-verification operations.

### P2 — expansion

1. Teams release after a controlled tenant pilot.
2. Slack and Google Chat adapters.
3. GitHub and ServiceNow evidence connectors.
4. XLSX import/export.
5. Plans, entitlements, usage metering and billing.

## Exit criteria

Day 5 is complete when the real demo evidence is captured, P0 items have owners, and the team explicitly keeps unrelated companies off the current single-connection deployment.

