# Dutha blocker resolution lifecycle

Base commit: `856a142`

## Adds

- Resolution states: detected, triaged, in coordination, awaiting verification, resolved and escalated
- Priority-based SLA due date during manager approval
- Resolution evidence table and audit events
- Two-step closure: submit resolution evidence, then verify and close
- Escalation to critical with a required reason
- Existing case status compatibility and production-data backfill

## Safety order

1. Expand into the repository root.
2. Run all tests and TypeScript validation.
3. Commit and push.
4. Record a D1 Time Travel bookmark.
5. Apply migration `0007` remotely.
6. Verify schema/backfill.
7. Deploy the Worker.

Do not deploy the TypeScript code before applying migration `0007`.
