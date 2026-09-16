import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { accessibleProjects, canAccessProject, managementPrincipalFromRequest, requireProjectAccess } from '../src/access-control';

async function createTenant(name: string): Promise<number> {
	const row = await env.DB.prepare(
		`
                INSERT INTO tenants (slug, name) VALUES (?, ?) RETURNING id
        `,
	)
		.bind(name.toLowerCase().replaceAll(' ', '-'), name)
		.first<{ id: number }>();
	if (!row) throw new Error('Tenant was not created.');
	return row.id;
}

async function createProject(tenantId: number, key: string): Promise<number> {
	const row = await env.DB.prepare(
		`
                INSERT INTO projects (tenant_id, project_key, name)
                VALUES (?, ?, ?) RETURNING id
        `,
	)
		.bind(tenantId, key, `${key} project`)
		.first<{ id: number }>();
	if (!row) throw new Error('Project was not created.');
	return row.id;
}

async function createManager(tenantId: number, subject: string): Promise<number> {
	const row = await env.DB.prepare(
		`
                INSERT INTO management_users (
                        tenant_id, external_subject, display_name, tenant_role
                ) VALUES (?, ?, ?, 'project_manager') RETURNING id
        `,
	)
		.bind(tenantId, subject, subject)
		.first<{ id: number }>();
	if (!row) throw new Error('Manager was not created.');
	return row.id;
}

describe('tenant and project access foundation', () => {
	beforeEach(async () => {
		await env.DB.prepare('DELETE FROM project_memberships WHERE management_user_id > 1').run();
		await env.DB.prepare('DELETE FROM management_users WHERE id > 1').run();
		await env.DB.prepare('DELETE FROM projects WHERE id > 1').run();
		await env.DB.prepare('DELETE FROM tenants WHERE id > 1').run();
	});

	it('backfills the existing Aurowise tenant and pilot project', async () => {
		const tenant = await env.DB.prepare('SELECT slug, name FROM tenants WHERE id = 1').first<{ slug: string; name: string }>();
		const project = await env.DB.prepare('SELECT tenant_id, project_key FROM projects WHERE id = 1').first<{
			tenant_id: number;
			project_key: string;
		}>();

		expect(tenant).toEqual({ slug: 'aurowise', name: 'Aurowise' });
		expect(project).toEqual({ tenant_id: 1, project_key: 'DUTHA' });
	});

	it('limits project managers to explicitly assigned projects', async () => {
		const tenantId = await createTenant('Tenant Alpha');
		const first = await createProject(tenantId, 'ALPHA-1');
		const second = await createProject(tenantId, 'ALPHA-2');
		const managerId = await createManager(tenantId, 'alpha-manager');
		await env.DB.prepare(
			`
                        INSERT INTO project_memberships (project_id, management_user_id)
                        VALUES (?, ?)
                `,
		)
			.bind(first, managerId)
			.run();

		const principal = {
			userId: managerId,
			tenantId,
			role: 'project_manager' as const,
		};
		expect((await accessibleProjects(env.DB, principal)).map((p) => p.id)).toEqual([first]);
		expect(await canAccessProject(env.DB, principal, first)).toBe(true);
		expect(await canAccessProject(env.DB, principal, second)).toBe(false);
		await expect(requireProjectAccess(env.DB, principal, second)).rejects.toThrow('Project access denied.');
	});

	it('lets portfolio leaders see their tenant but never another tenant', async () => {
		const alpha = await createTenant('Tenant Alpha');
		const beta = await createTenant('Tenant Beta');
		const alphaProject = await createProject(alpha, 'ALPHA');
		const betaProject = await createProject(beta, 'BETA');
		const principal = {
			userId: 999,
			tenantId: alpha,
			role: 'portfolio_leader' as const,
		};

		expect(await canAccessProject(env.DB, principal, alphaProject)).toBe(true);
		expect(await canAccessProject(env.DB, principal, betaProject)).toBe(false);
		expect((await accessibleProjects(env.DB, principal)).map((p) => p.id)).toEqual([alphaProject]);
	});

	it('accepts only trusted, complete management identity headers', () => {
		const request = new Request('https://example.com/dashboard', {
			headers: {
				'X-Dutha-User-Id': '7',
				'X-Dutha-Tenant-Id': '3',
				'X-Dutha-Tenant-Role': 'project_manager',
			},
		});
		expect(managementPrincipalFromRequest(request)).toEqual({
			userId: 7,
			tenantId: 3,
			role: 'project_manager',
		});
		expect(
			managementPrincipalFromRequest(new Request('https://example.com/dashboard', { headers: { 'X-Dutha-Tenant-Id': '3' } })),
		).toBeNull();
	});
});
