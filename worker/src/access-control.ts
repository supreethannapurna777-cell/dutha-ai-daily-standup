export type TenantRole = 'admin' | 'ceo' | 'portfolio_leader' | 'project_manager' | 'team_lead';

export interface ManagementPrincipal {
	userId: number;
	tenantId: number;
	role: TenantRole;
}

export interface AccessibleProject {
	id: number;
	tenant_id: number;
	project_key: string;
	name: string;
}

const positiveInteger = (value: string | null): number | null => {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

export function managementPrincipalFromRequest(request: Request): ManagementPrincipal | null {
	const userId = positiveInteger(request.headers.get('X-Dutha-User-Id'));
	const tenantId = positiveInteger(request.headers.get('X-Dutha-Tenant-Id'));
	const role = request.headers.get('X-Dutha-Tenant-Role');

	if (!userId || !tenantId || !['admin', 'ceo', 'portfolio_leader', 'project_manager', 'team_lead'].includes(role ?? '')) {
		return null;
	}

	return { userId, tenantId, role: role as TenantRole };
}

export async function accessibleProjects(db: D1Database, principal: ManagementPrincipal): Promise<AccessibleProject[]> {
	const statement =
		principal.role === 'project_manager'
			? db
					.prepare(
						`
                        SELECT project.id, project.tenant_id,
                                project.project_key, project.name
                        FROM projects AS project
                        INNER JOIN project_memberships AS membership
                                ON membership.project_id = project.id
                        WHERE project.tenant_id = ?
                                AND project.active = 1
                                AND membership.management_user_id = ?
                        ORDER BY project.name
                `,
					)
					.bind(principal.tenantId, principal.userId)
			: principal.role === 'team_lead'
				? db.prepare(`
                        SELECT project.id, project.tenant_id, project.project_key, project.name
                        FROM projects AS project
                        INNER JOIN team_lead_assignments AS assignment ON assignment.project_id = project.id
                        WHERE project.tenant_id = ? AND project.active = 1 AND assignment.management_user_id = ?
                        ORDER BY project.name
                `).bind(principal.tenantId, principal.userId)
			: db
					.prepare(
						`
                        SELECT id, tenant_id, project_key, name
                        FROM projects
                        WHERE tenant_id = ? AND active = 1
                        ORDER BY name
                `,
					)
					.bind(principal.tenantId);

	return (await statement.all<AccessibleProject>()).results;
}

export async function canAccessProject(db: D1Database, principal: ManagementPrincipal, projectId: number): Promise<boolean> {
	if (!Number.isSafeInteger(projectId) || projectId <= 0) return false;

	const allowed =
		principal.role === 'project_manager'
			? await db
					.prepare(
						`
                        SELECT 1 AS allowed
                        FROM projects AS project
                        INNER JOIN project_memberships AS membership
                                ON membership.project_id = project.id
                        WHERE project.id = ?
                                AND project.tenant_id = ?
                                AND project.active = 1
                                AND membership.management_user_id = ?
                        LIMIT 1
                `,
					)
					.bind(projectId, principal.tenantId, principal.userId)
					.first<{ allowed: number }>()
			: principal.role === 'team_lead'
				? await db.prepare(`
                        SELECT 1 AS allowed FROM projects AS project
                        INNER JOIN team_lead_assignments AS assignment ON assignment.project_id = project.id
                        WHERE project.id = ? AND project.tenant_id = ? AND project.active = 1
                          AND assignment.management_user_id = ? LIMIT 1
                `).bind(projectId, principal.tenantId, principal.userId).first<{ allowed: number }>()
			: await db
					.prepare(
						`
                        SELECT 1 AS allowed
                        FROM projects
                        WHERE id = ? AND tenant_id = ? AND active = 1
                        LIMIT 1
                `,
					)
					.bind(projectId, principal.tenantId)
					.first<{ allowed: number }>();

	return allowed?.allowed === 1;
}

export async function teamLeadDepartment(db: D1Database, principal: ManagementPrincipal, projectId: number): Promise<string | null> {
	if (principal.role !== 'team_lead') return null;
	const row = await db.prepare(`
                SELECT assignment.department
                FROM team_lead_assignments AS assignment
                INNER JOIN projects AS project ON project.id = assignment.project_id
                WHERE assignment.project_id = ? AND assignment.management_user_id = ?
                  AND project.tenant_id = ? AND project.active = 1 LIMIT 1
        `).bind(projectId, principal.userId, principal.tenantId).first<{ department: string }>();
	return row?.department ?? null;
}

export async function requireProjectAccess(db: D1Database, principal: ManagementPrincipal, projectId: number): Promise<void> {
	if (!(await canAccessProject(db, principal, projectId))) {
		throw new Error('Project access denied.');
	}
}
