import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env';
import { authenticatedManagementRequest, createManagerActivation, forgotPasswordResponse, loginResponse, managerActivationResponse } from '../src/auth';
import { accessibleProjects, managementPrincipalFromRequest } from '../src/access-control';

const authEnv = {
	...env,
	DASHBOARD_USERNAME: 'admin',
	DASHBOARD_PASSWORD: 'recovery-password',
	DASHBOARD_SESSION_SECRET: 'test-session-secret-that-is-long-enough',
} as WorkerEnv;

function post(path: string, data: Record<string, string>): Request {
	return new Request(`https://example.com${path}`, {
		method: 'POST',
		headers: { Origin: 'https://example.com', 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(data),
	});
}

describe('individual management authentication', () => {
	beforeEach(async () => {
		await env.DB.prepare(`DELETE FROM management_users WHERE email='manager@example.com'`).run();
	});

	it('activates a manager, signs in by email and restores the database identity', async () => {
		const manager = await env.DB.prepare(`
			INSERT INTO management_users (tenant_id, external_subject, display_name, email, tenant_role)
			VALUES (1, 'manager@example.com', 'Project Manager', 'manager@example.com', 'project_manager') RETURNING id
		`).first<{ id:number }>();
		expect(manager).toBeTruthy();
		await env.DB.prepare(`INSERT INTO project_memberships (project_id, management_user_id) VALUES (1, ?)`).bind(manager!.id).run();
		const token = await createManagerActivation(env.DB, manager!.id);
		const activated = await managerActivationResponse(post('/manager/activate', { token, password: 'StrongPassword123', confirm_password: 'StrongPassword123' }), authEnv);
		expect(activated.status).toBe(303);
		expect(activated.headers.get('Location')).toBe('/login?activated=1');

		const login = await loginResponse(post('/login', { username: 'manager@example.com', password: 'StrongPassword123', next: '/dashboard' }), authEnv);
		expect(login.status).toBe(303);
		const sessionCookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0];
		const authenticated = await authenticatedManagementRequest(new Request('https://example.com/dashboard', { headers: { Cookie: sessionCookie } }), authEnv);
		expect(authenticated).not.toBeNull();
		const principal = managementPrincipalFromRequest(authenticated!);
		expect(principal).toEqual({ userId: manager!.id, tenantId: 1, role: 'project_manager' });
		const projects = await accessibleProjects(env.DB, principal!);
		expect(projects.map((project) => project.id)).toEqual([1]);
	});

	it('allows an administrator to revoke an unused activation link by creating another', async () => {
		const manager = await env.DB.prepare(`
			INSERT INTO management_users (tenant_id, external_subject, display_name, email, tenant_role)
			VALUES (1, 'manager@example.com', 'Project Manager', 'manager@example.com', 'project_manager') RETURNING id
		`).first<{ id:number }>();
		const first = await createManagerActivation(env.DB, manager!.id);
		const second = await createManagerActivation(env.DB, manager!.id);
		const rejected = await managerActivationResponse(post('/manager/activate', { token: first, password: 'StrongPassword123', confirm_password: 'StrongPassword123' }), authEnv);
		expect(await rejected.text()).toContain('invalid, expired or already used');
		const accepted = await managerActivationResponse(post('/manager/activate', { token: second, password: 'StrongPassword123', confirm_password: 'StrongPassword123' }), authEnv);
		expect(accepted.status).toBe(303);
	});

	it('creates a one-time reset link without revealing whether an email exists', async () => {
		const manager = await env.DB.prepare(`
			INSERT INTO management_users (tenant_id, external_subject, display_name, email, tenant_role)
			VALUES (1, 'reset-manager@example.com', 'Reset Manager', 'reset-manager@example.com', 'project_manager') RETURNING id
		`).first<{ id:number }>();
		expect(manager).toBeTruthy();
		const response = await forgotPasswordResponse(post('/forgot-password', { email: 'reset-manager@example.com' }), authEnv);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('If that account exists');
		const token = await env.DB.prepare(`SELECT id FROM management_activation_tokens WHERE management_user_id=? AND revoked_at IS NULL`).bind(manager!.id).first();
		expect(token).toBeTruthy();
	});
});
