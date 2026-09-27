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
		await env.DB.batch([
			env.DB.prepare('DELETE FROM case_events'),
			env.DB.prepare('DELETE FROM case_availability'),
			env.DB.prepare('DELETE FROM case_time_options'),
			env.DB.prepare('DELETE FROM coordination_cases'),
		]);
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
		expect(html).toContain('<h2>Email</h2>');
		expect(html.match(/Coming soon/g)?.length).toBe(2);
	});

	it('shows only the signed-in employee’s recent stand-up history', async () => {
		await env.DB.prepare("UPDATE team_members SET phone='919177700001' WHERE id=?").bind(memberId).run();
		const ownIncoming = await env.DB.prepare("INSERT INTO incoming_messages (whatsapp_message_id, received_at, sender_name, sender_phone, original_reply, processing_status, tenant_id, project_id) VALUES (?, ?, 'Employee One', '919177700001', 'Own update', 'processed', 1, 1) RETURNING id").bind(`wamid.employee-own-${crypto.randomUUID()}`, '2026-09-26T09:00:00.000Z').first<{ id:number }>();
		const otherIncoming = await env.DB.prepare("INSERT INTO incoming_messages (whatsapp_message_id, received_at, sender_name, sender_phone, original_reply, processing_status, tenant_id, project_id) VALUES (?, ?, 'Other Employee', '919177700002', 'Other update', 'processed', 1, 1) RETURNING id").bind(`wamid.employee-other-${crypto.randomUUID()}`, '2026-09-26T09:05:00.000Z').first<{ id:number }>();
		await env.DB.batch([
			env.DB.prepare("INSERT INTO processed_updates (message_id, sender_name, tasks, blockers, expected_completion, original_reply, processing_status, tenant_id, project_id) VALUES (?, 'Employee One', 'Ship private history', 'No blocker', 'Today', 'Own update', 'processed', 1, 1)").bind(ownIncoming!.id),
			env.DB.prepare("INSERT INTO processed_updates (message_id, sender_name, tasks, blockers, expected_completion, original_reply, processing_status, tenant_id, project_id) VALUES (?, 'Other Employee', 'Secret other task', 'Sensitive blocker', 'Tomorrow', 'Other update', 'processed', 1, 1)").bind(otherIncoming!.id),
		]);
		const token = await createEmployeeActivation(env.DB, memberId, 1, 'employee@example.com');
		await employeePortalResponse(post('/employee/activate', { token, password: 'StrongPassword123', confirm_password: 'StrongPassword123' }), portalEnv);
		const login = await employeePortalResponse(post('/employee/login', { email: 'employee@example.com', password: 'StrongPassword123' }), portalEnv);
		const cookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0];
		const dashboard = await employeePortalResponse(new Request('https://example.com/employee', { headers: { Cookie: cookie } }), portalEnv);
		const html = await dashboard.text();
		expect(html).toContain('My submitted updates');
		expect(html).toContain('Ship private history');
		expect(html).not.toContain('Secret other task');
		expect(html).not.toContain('919177700001');
	});

	it('submits an owned update correction without changing the original', async () => {
		const phone = `91${Math.floor(1000000000 + Math.random() * 8999999999)}`;
		await env.DB.prepare('UPDATE team_members SET phone=? WHERE id=?').bind(phone, memberId).run();
		const incoming = await env.DB.prepare("INSERT INTO incoming_messages (whatsapp_message_id, received_at, sender_name, sender_phone, original_reply, processing_status, tenant_id, project_id) VALUES (?, CURRENT_TIMESTAMP, 'Employee One', ?, 'I completed an old task', 'processed', 1, 1) RETURNING id").bind(`wamid.correction-own-${crypto.randomUUID()}`, phone).first<{id:number}>();
		const processed = await env.DB.prepare("INSERT INTO processed_updates (message_id, sender_name, tasks, blockers, expected_completion, original_reply, processing_status, tenant_id, project_id) VALUES (?, 'Employee One', 'Old task', 'No blocker', 'Today', 'I completed an old task', 'processed', 1, 1) RETURNING id").bind(incoming!.id).first<{id:number}>();
		const token = await createEmployeeActivation(env.DB, memberId, 1, 'employee@example.com');
		await employeePortalResponse(post('/employee/activate', { token, password: 'StrongPassword123', confirm_password: 'StrongPassword123' }), portalEnv);
		const login = await employeePortalResponse(post('/employee/login', { email: 'employee@example.com', password: 'StrongPassword123' }), portalEnv);
		const cookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0];
		const response = await employeePortalResponse(post('/employee', { action: 'correct_update', processed_update_id: String(processed!.id), correction_text: 'The task was completed yesterday, not today.' }, cookie), portalEnv);
		expect(response.status).toBe(303);
		expect(response.headers.get('Location')).toContain('correction=submitted');
		const stored = await env.DB.prepare('SELECT status, original_tasks, original_reply, correction_text FROM employee_update_corrections WHERE processed_update_id=?').bind(processed!.id).first<{status:string;original_tasks:string;original_reply:string;correction_text:string}>();
		expect(stored).toMatchObject({ status:'pending_review', original_tasks:'Old task', original_reply:'I completed an old task' });
		const unchanged = await env.DB.prepare('SELECT tasks, expected_completion FROM processed_updates WHERE id=?').bind(processed!.id).first<{tasks:string;expected_completion:string}>();
		expect(unchanged).toEqual({ tasks:'Old task', expected_completion:'Today' });
	});

	it('does not let an employee request correction on another sender’s update', async () => {
		const incoming = await env.DB.prepare("INSERT INTO incoming_messages (whatsapp_message_id, received_at, sender_name, sender_phone, original_reply, processing_status, tenant_id, project_id) VALUES (?, CURRENT_TIMESTAMP, 'Someone Else', '919177700099', 'Other persons private note', 'processed', 1, 1) RETURNING id").bind(`wamid.correction-other-${crypto.randomUUID()}`).first<{id:number}>();
		const processed = await env.DB.prepare("INSERT INTO processed_updates (message_id, sender_name, tasks, original_reply, processing_status, tenant_id, project_id) VALUES (?, 'Someone Else', 'Private other task', 'Other persons private note', 'processed', 1, 1) RETURNING id").bind(incoming!.id).first<{id:number}>();
		const token = await createEmployeeActivation(env.DB, memberId, 1, 'employee@example.com');
		await employeePortalResponse(post('/employee/activate', { token, password: 'StrongPassword123', confirm_password: 'StrongPassword123' }), portalEnv);
		const login = await employeePortalResponse(post('/employee/login', { email: 'employee@example.com', password: 'StrongPassword123' }), portalEnv);
		const cookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0];
		const response = await employeePortalResponse(post('/employee', { action: 'correct_update', processed_update_id: String(processed!.id), correction_text: 'Please change this other task.' }, cookie), portalEnv);
		expect(response.status).toBe(404);
		const corrections = await env.DB.prepare('SELECT COUNT(*) AS count FROM employee_update_corrections WHERE processed_update_id=?').bind(processed!.id).first<{count:number}>();
		expect(corrections?.count).toBe(0);
	});

	it('shows the employee’s own coordination case and only a confirmed HTTPS meeting link', async () => {
		const incoming = await env.DB.prepare("INSERT INTO incoming_messages (whatsapp_message_id, received_at, sender_name, sender_phone, original_reply, processing_status, tenant_id, project_id) VALUES (?, CURRENT_TIMESTAMP, 'Employee One', '919177700010', 'Coordination request', 'processed', 1, 1) RETURNING id").bind(`wamid.employee-case-${crypto.randomUUID()}`).first<{ id:number }>();
		const processed = await env.DB.prepare("INSERT INTO processed_updates (message_id, sender_name, blockers, original_reply, processing_status, tenant_id, project_id) VALUES (?, 'Employee One', 'Need a review', 'Coordination request', 'processed', 1, 1) RETURNING id").bind(incoming!.id).first<{ id:number }>();
		await env.DB.prepare("INSERT INTO coordination_cases (source_update_id, requester_member_id, case_type, issue_summary, status, priority, meeting_link, tenant_id, project_id) VALUES (?, ?, 'coordination', 'Review deployment approach', 'scheduled', 'high', 'https://meet.example.com/dutha-review', 1, 1)").bind(processed!.id, memberId).run();
		const token = await createEmployeeActivation(env.DB, memberId, 1, 'employee@example.com');
		await employeePortalResponse(post('/employee/activate', { token, password: 'StrongPassword123', confirm_password: 'StrongPassword123' }), portalEnv);
		const login = await employeePortalResponse(post('/employee/login', { email: 'employee@example.com', password: 'StrongPassword123' }), portalEnv);
		const cookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0];
		const dashboard = await employeePortalResponse(new Request('https://example.com/employee', { headers: { Cookie: cookie } }), portalEnv);
		const html = await dashboard.text();
		expect(html).toContain('My coordination requests');
		expect(html).toContain('Review deployment approach');
		expect(html).toContain('Join confirmed meeting');
		expect(html).toContain('https://meet.example.com/dutha-review');
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

	it('lets an authenticated employee save communication preferences', async () => {
		const token = await createEmployeeActivation(env.DB, memberId, 1, 'employee@example.com');
		await employeePortalResponse(post('/employee/activate', { token, password: 'StrongPassword123', confirm_password: 'StrongPassword123' }), portalEnv);
		const login = await employeePortalResponse(post('/employee/login', { email: 'employee@example.com', password: 'StrongPassword123' }), portalEnv);
		const cookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0];
		const response = await employeePortalResponse(post('/employee/preferences', {
			language: 'te', content_mode: 'voice', timezone: 'Asia/Kolkata', quiet_hours_start: '22:00', quiet_hours_end: '07:00',
			standup_enabled: 'on', blocker_enabled: 'on', meeting_enabled: 'on',
		}, cookie), portalEnv);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('Preferences saved.');
		const saved = await env.DB.prepare(`SELECT language,content_mode,reminder_enabled FROM employee_communication_preferences WHERE team_member_id=?`).bind(memberId).first<{ language:string; content_mode:string; reminder_enabled:number }>();
		expect(saved).toEqual({ language: 'te', content_mode: 'voice', reminder_enabled: 0 });
	});
});
