# Dutha tenant and project foundation

This update is based on commit `7c528eb` and adds the first scalable product boundary without changing the existing Aurowise login, WhatsApp, voice, scheduling or coordination behavior.

## Included

- Migration `0006_tenant_project_foundation.sql`
- Tenants, projects, management users and project memberships
- Team-member-to-project assignments
- Tenant/project ownership on operational records
- Aurowise and Dutha Pilot backfill for all existing records
- Scoped dashboard, history, member-management and coordination-case access
- Admin, portfolio leader and project manager access primitives
- Cross-tenant and project-manager isolation tests

## Safety sequence

1. Expand this ZIP into the repository root.
2. Run `npm test -- --run` in `worker`.
3. Run `npx tsc --noEmit` in `worker`.
4. Commit and push the source.
5. List the remote D1 migration before applying it.
6. Apply migration `0006` to remote D1.
7. Verify the seeded tenant/project and backfilled counts.
8. Deploy the Worker only after those checks pass.

Do not deploy the TypeScript changes before applying migration `0006`; scoped queries depend on the new columns and tables.
