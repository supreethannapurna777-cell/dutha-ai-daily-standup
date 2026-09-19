import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env';
import { createEmployeeActivation, employeePortalResponse } from '../src/employee-portal';

const portalEnv = {
	...env,
	DASHBOARD_SESSION_SECRET: 'test-session-secret-that-is-long-enough',
} as WorkerEnv;

let memberId: number;

function post(path: string, data: Record<string, string>, cookie?: string): Request {
	return new Request(`https://example.com${path}`, {
		method: 'POST',
		headers: {
			Origin: 'https://example.com',
			'Content-Type': 'application/x-www-form-urlencoded',
			...(cookie ? { Cookie: cookie } : {}),
		},
		body: new URLSearchParams(data),
	});
}

describe('employee portal', () => {
	beforeEach(async () => {
		await env.DB.prepare(`DELETE FROM team_members WHERE email='employee@example.com'`).run();
		const row = await env.DB.prepare(`
			INSERT INTO team_members (name, phone, department, tenant_id, primary_project_id, email, enrolment_status, scheduling_enabled)
			VALUES ('Employee One', ?, 'DevOps', 1, 1, 'employee@example.com', 'invited', 0)
			RETURNING id
		`).bind(`pending-${crypto.randomUUID()}`).first<{ id: number }>();
		memberId = row!.id;
	});

	it('activates once and creates a secure password record', async () => {
		const token = await createEmployeeActivation(env.DB, memberId, 1, 'employee@example.com');
		const response = await employeePortalResponse(post('/employee/activate', {
			token,
			password: 'StrongPassword123',
			confirm_password: 'StrongPassword123',
		}), portalEnv);
		expect(response.status).toBe(303);
		expect(response.headers.get('Location')).toBe('/employee/login?activated=1');
		const account = await env.DB.prepare(`SELECT activated_at, password_hash FROM employee_accounts WHERE team_member_id=?`).bind(memberId).first<{ activated_at:string; password_hash:string }>();
		expect(account?.activated_at).toBeTruthy();
		expect(account?.password_hash).not.toContain('StrongPassword123');
		const reused = await employeePortalResponse(post('/employee/activate', {
			token,
			password: 'StrongPassword123',
			confirm_password: 'StrongPassword123',
		}), portalEnv);
		expect(await reused.text()).toContain('invalid, expired or already used');
	});

	it('logs in and shows available and coming-soon channels', async () => {
		const token = await createEmployeeActivation(env.DB, memberId, 1, 'employee@example.com');
		await employeePortalResponse(post('/employee/activate', {
			token,
			password: 'StrongPassword123',
			confirm_password: 'StrongPassword123',
		}), portalEnv);
		const login = await employeePortalResponse(post('/employee/login', {
			email: 'employee@example.com',
			password: 'StrongPassword123',
		}), portalEnv);
		expect(login.status).toBe(303);
		const cookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0];
		expect(cookie).toContain('dutha_employee_session=');
		const dashboard = await employeePortalResponse(new Request('https://example.com/employee', { headers: { Cookie: cookie } }), portalEnv);
		const html = await dashboard.text();
		expect(html).toContain('Connect WhatsApp');
		expect(html).toContain('Microsoft Teams');
		expect(html).toContain('Slack');
		expect(html.match(/Coming soon/g)?.length).toBeGreaterThanOrEqual(3);
	});

	it('creates a personal WhatsApp JOIN instruction', async () => {
		const token = await createEmployeeActivation(env.DB, memberId, 1, 'employee@example.com');
		await employeePortalResponse(post('/employee/activate', { token, password: 'StrongPassword123', confirm_password: 'StrongPassword123' }), portalEnv);
		const login = await employeePortalResponse(post('/employee/login', { email: 'employee@example.com', password: 'StrongPassword123' }), portalEnv);
		const cookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0];
		const response = await employeePortalResponse(post('/employee', { action: 'connect_whatsapp' }, cookie), portalEnv);
		const html = await response.text();
		expect(html).toMatch(/JOIN [A-Z0-9]{10} employee@example\.com/);
		const invite = await env.DB.prepare(`SELECT max_uses FROM enrolment_invites WHERE project_id=1 ORDER BY id DESC LIMIT 1`).first<{ max_uses:number }>();
		expect(invite?.max_uses).toBe(1);
	});
});

