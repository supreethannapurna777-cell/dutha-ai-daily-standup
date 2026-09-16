# Dutha project and access interface

Base commit: `aa1af3e`

## Adds

- Admin-only `/dashboard/projects` interface
- Project creation
- Management-user records and tenant roles
- Project-manager/project assignments
- Employee/project assignments
- Dashboard project selector
- Project context preserved in dashboard navigation and history
- Tenant-isolation and administrator-access tests

No database migration is required. Migration `0006` must already be applied.

Run the complete test suite and TypeScript validation before committing and deploying.
