import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env';
import { createEmployeeActivation, employeePortalResponse } from '../src/employee-portal';

const portalEnv = {
	...env,
	DASHBOARD_SESSION_SECRET: 'test-session-secret-that-is-long-enough',
	WHATSAPP_BUSINESS_NUMBER: '+91 70132 98834',
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

	it('accepts a same-site activation form when the browser reports a null origin', async () => {
		const token = await createEmployeeActivation(env.DB, memberId, 1, 'employee@example.com');
		const request = post('/employee/activate', {
			token,
			password: 'StrongPassword123',
			confirm_password: 'StrongPassword123',
		});
		request.headers.set('Origin', 'null');
		request.headers.set('Sec-Fetch-Site', 'same-origin');
		const response = await employeePortalResponse(request, portalEnv);
		expect(response.status).toBe(303);
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
		expect(html).toContain('<form method="post" target="_blank">');
		expect(html).toContain('Microsoft Teams');
		expect(html).toContain('Slack');
		expect(html.match(/Coming soon/g)?.length).toBeGreaterThanOrEqual(3);
	});

	it('shows a secure desktop QR code with a personal JOIN instruction', async () => {
		const token = await createEmployeeActivation(env.DB, memberId, 1, 'employee@example.com');
		await employeePortalResponse(post('/employee/activate', { token, password: 'StrongPassword123', confirm_password: 'StrongPassword123' }), portalEnv);
		const login = await employeePortalResponse(post('/employee/login', { email: 'employee@example.com', password: 'StrongPassword123' }), portalEnv);
		const cookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0];
		const response = await employeePortalResponse(post('/employee', { action: 'connect_whatsapp' }, cookie), portalEnv);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain('<svg');
		expect(html).toContain('Scan this QR code');
		expect(html).toMatch(/JOIN [A-Z0-9]{10} employee@example\.com/);
		const invite = await env.DB.prepare(`SELECT max_uses, created_by_management_user_id, created_by_team_member_id, tenant_id FROM enrolment_invites WHERE project_id=1 ORDER BY id DESC LIMIT 1`).first<{ max_uses:number; created_by_management_user_id:number|null; created_by_team_member_id:number|null; tenant_id:number }>();
		expect(invite?.max_uses).toBe(1);
		expect(invite?.created_by_management_user_id).toBeNull();
		expect(invite?.created_by_team_member_id).toBe(memberId);
		expect(invite?.tenant_id).toBe(1);
	});

	it('opens WhatsApp directly with the JOIN message on mobile', async () => {
		const token = await createEmployeeActivation(env.DB, memberId, 1, 'employee@example.com');
		await employeePortalResponse(post('/employee/activate', { token, password: 'StrongPassword123', confirm_password: 'StrongPassword123' }), portalEnv);
		const login = await employeePortalResponse(post('/employee/login', { email: 'employee@example.com', password: 'StrongPassword123' }), portalEnv);
		const cookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0];
		const request = post('/employee', { action: 'connect_whatsapp' }, cookie);
		request.headers.set('User-Agent', 'Mozilla/5.0 (Linux; Android 15) Mobile');
		const response = await employeePortalResponse(request, portalEnv);
		expect(response.status).toBe(303);
		expect(decodeURIComponent(response.headers.get('Location') ?? '')).toMatch(/^https:\/\/wa\.me\/917013298834\?text=JOIN [A-Z0-9]{10} employee@example\.com$/);
	});
});
