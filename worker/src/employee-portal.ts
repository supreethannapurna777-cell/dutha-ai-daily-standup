import type { WorkerEnv } from './env';
import { generateEnrolmentCode, hashEnrolmentCode } from './enrolment';

const COOKIE_NAME = 'dutha_employee_session';
const SESSION_SECONDS = 8 * 60 * 60;
// Cloudflare Workers Web Crypto supports PBKDF2 up to 100,000 iterations.
const PASSWORD_ITERATIONS = 100_000;

function escapeHtml(value: unknown): string {
	return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function headers(): HeadersInit {
	return {
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-store',
		'X-Frame-Options': 'DENY',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'no-referrer',
		'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	};
}

function page(title: string, content: string): Response {
	return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Dutha</title><style>
:root{font-family:Inter,Arial,sans-serif;color:#172033;background:#f3f7fb}*{box-sizing:border-box}body{margin:0;padding:24px}main{max-width:920px;margin:auto}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}.brand{font-size:25px;font-weight:900;color:#173f6b}.card{background:#fff;border-radius:16px;padding:24px;box-shadow:0 8px 30px #173f6b14;margin-bottom:18px}h1,h2{color:#173f6b;margin-top:0}.muted{color:#64748b}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.channel{border:1px solid #dbe4ef;border-radius:14px;padding:20px}.ready{border-color:#86efac}.soon{background:#f8fafc}.badge{display:inline-block;border-radius:999px;padding:5px 9px;background:#e2e8f0;font-size:12px;font-weight:800}.green{background:#dcfce7;color:#166534}.error{background:#fee2e2;color:#991b1b;padding:11px;border-radius:9px}.success{background:#dcfce7;color:#166534;padding:13px;border-radius:9px}label{display:grid;gap:7px;font-weight:700;margin:14px 0}input{padding:12px;border:1px solid #cbd5e1;border-radius:9px;font:inherit}button,.button{display:inline-block;border:0;border-radius:9px;padding:12px 16px;background:#1769aa;color:#fff;text-decoration:none;font-weight:800;cursor:pointer}.secondary{background:#475569}code{display:block;padding:13px;background:#0f172a;color:#e2e8f0;border-radius:9px;overflow-wrap:anywhere}form.inline{display:inline}@media(max-width:700px){.grid{grid-template-columns:1fr}.top{align-items:start}}
</style></head><body><main><div class="top"><div class="brand">Dutha WorkOps</div></div>${content}</main></body></html>`, { headers: headers() });
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64ToBytes(value: string): Uint8Array {
	const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function sha256(value: string): Promise<string> {
	return bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

async function hmac(value: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return bytesToBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))));
}

function safeEqual(left: string, right: string): boolean {
	const a = new TextEncoder().encode(left);
	const b = new TextEncoder().encode(right);
	let difference = a.length ^ b.length;
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
	return difference === 0;
}

async function passwordHash(password: string, salt: Uint8Array): Promise<string> {
	const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PASSWORD_ITERATIONS }, material, 256);
	return bytesToBase64(new Uint8Array(bits));
}

function cookie(request: Request, name: string): string | null {
	for (const item of (request.headers.get('Cookie') ?? '').split(';')) {
		const [key, ...value] = item.trim().split('=');
		if (key === name) return value.join('=');
	}
	return null;
}

async function memberFromSession(request: Request, env: WorkerEnv): Promise<number | null> {
	const secret = env.DASHBOARD_SESSION_SECRET;
	const value = cookie(request, COOKIE_NAME);
	if (!secret || !value) return null;
	const [memberText, expiryText, supplied, extra] = value.split('.');
	const memberId = Number(memberText);
	const expiry = Number(expiryText);
	if (extra || !Number.isSafeInteger(memberId) || memberId <= 0 || !Number.isSafeInteger(expiry) || expiry <= Math.floor(Date.now() / 1000)) return null;
	const expected = await hmac(`${memberText}.${expiryText}`, secret);
	return safeEqual(supplied ?? '', expected) ? memberId : null;
}

function sameOrigin(request: Request): boolean {
	const origin = request.headers.get('Origin');
	if (origin && origin !== 'null') return origin === new URL(request.url).origin;
	return request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

function strongPassword(value: string): boolean {
	return value.length >= 12 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
}

export async function createEmployeeActivation(db: D1Database, memberId: number, tenantId: number, email: string, now = new Date()): Promise<string> {
	const token = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
	const tokenHash = await sha256(token);
	const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
	await db.batch([
		db.prepare(`INSERT INTO employee_accounts (team_member_id, tenant_id, email) VALUES (?, ?, ?) ON CONFLICT(team_member_id) DO UPDATE SET email=excluded.email, updated_at=CURRENT_TIMESTAMP`).bind(memberId, tenantId, email.trim().toLowerCase()),
		db.prepare(`UPDATE employee_activation_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE team_member_id=? AND used_at IS NULL AND revoked_at IS NULL`).bind(memberId),
		db.prepare(`INSERT INTO employee_activation_tokens (team_member_id, token_hash, expires_at) VALUES (?, ?, ?)`).bind(memberId, tokenHash, expires),
	]);
	return token;
}

function activationForm(token: string, error = ''): Response {
	return page('Activate account', `<section class="card"><h1>Activate your employee account</h1><p class="muted">Create your private password. Use at least 12 characters with uppercase, lowercase and a number.</p>${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}<form method="post" action="/employee/activate"><input type="hidden" name="token" value="${escapeHtml(token)}"><label>Password<input type="password" name="password" minlength="12" autocomplete="new-password" required></label><label>Confirm password<input type="password" name="confirm_password" minlength="12" autocomplete="new-password" required></label><button>Activate account</button></form></section>`);
}

async function activationResponse(request: Request, env: WorkerEnv): Promise<Response> {
	if (request.method === 'GET') return activationForm(new URL(request.url).searchParams.get('token') ?? '');
	if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
	if (!sameOrigin(request)) return new Response('Invalid request origin.', { status: 403 });
	const form = await request.formData();
	const token = String(form.get('token') ?? '');
	const password = String(form.get('password') ?? '');
	if (!token || !strongPassword(password) || password !== String(form.get('confirm_password') ?? '')) return activationForm(token, 'Passwords must match and meet all password requirements.');
	const row = await env.DB.prepare(`SELECT token.id, token.team_member_id FROM employee_activation_tokens AS token INNER JOIN employee_accounts AS account ON account.team_member_id=token.team_member_id WHERE token.token_hash=? AND token.used_at IS NULL AND token.revoked_at IS NULL AND token.expires_at>? LIMIT 1`).bind(await sha256(token), new Date().toISOString()).first<{ id: number; team_member_id: number }>();
	if (!row) return activationForm('', 'This activation link is invalid, expired or already used.');
	const salt = crypto.getRandomValues(new Uint8Array(16));
	await env.DB.batch([
		env.DB.prepare(`UPDATE employee_accounts SET password_hash=?, password_salt=?, activated_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE team_member_id=?`).bind(await passwordHash(password, salt), bytesToBase64(salt), row.team_member_id),
		env.DB.prepare(`UPDATE employee_activation_tokens SET used_at=CURRENT_TIMESTAMP WHERE id=?`).bind(row.id),
	]);
	return new Response(null, { status: 303, headers: { Location: '/employee/login?activated=1', 'Cache-Control': 'no-store' } });
}

function loginForm(error = '', activated = false): Response {
	return page('Employee sign in', `<section class="card"><h1>Employee sign in</h1>${activated ? '<div class="success">Account activated. You can sign in now.</div>' : ''}${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}<form method="post" action="/employee/login"><label>Work email<input type="email" name="email" autocomplete="username" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><button>Sign in</button></form></section>`);
}

async function loginResponse(request: Request, env: WorkerEnv): Promise<Response> {
	if (request.method === 'GET') return loginForm('', new URL(request.url).searchParams.get('activated') === '1');
	if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
	if (!sameOrigin(request)) return new Response('Invalid request origin.', { status: 403 });
	const form = await request.formData();
	const email = String(form.get('email') ?? '').trim().toLowerCase();
	const password = String(form.get('password') ?? '');
	const account = await env.DB.prepare(`SELECT team_member_id, password_hash, password_salt FROM employee_accounts WHERE lower(email)=? AND activated_at IS NOT NULL LIMIT 1`).bind(email).first<{ team_member_id: number; password_hash: string; password_salt: string }>();
	if (!account || !safeEqual(await passwordHash(password, account ? base64ToBytes(account.password_salt) : crypto.getRandomValues(new Uint8Array(16))), account?.password_hash ?? '')) return loginForm('The email or password is incorrect.');
	if (!env.DASHBOARD_SESSION_SECRET) return new Response('Employee login is not configured.', { status: 503 });
	await env.DB.prepare(`UPDATE employee_accounts SET last_login_at=CURRENT_TIMESTAMP WHERE team_member_id=?`).bind(account.team_member_id).run();
	const expiry = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
	const payload = `${account.team_member_id}.${expiry}`;
	return new Response(null, { status: 303, headers: { Location: '/employee', 'Set-Cookie': `${COOKIE_NAME}=${payload}.${await hmac(payload, env.DASHBOARD_SESSION_SECRET)}; Max-Age=${SESSION_SECONDS}; Path=/employee; HttpOnly; Secure; SameSite=Strict`, 'Cache-Control': 'no-store' } });
}

async function dashboardResponse(request: Request, env: WorkerEnv, memberId: number): Promise<Response> {
	const member = await env.DB.prepare(`SELECT id, tenant_id, primary_project_id, name, email, department FROM team_members WHERE id=? AND active=1 LIMIT 1`).bind(memberId).first<{ id:number; tenant_id:number; primary_project_id:number; name:string; email:string|null; department:string }>();
	if (!member) return new Response('Employee account not found.', { status: 404 });
	const identity = await env.DB.prepare(`SELECT external_id FROM channel_identities WHERE team_member_id=? AND channel='whatsapp' LIMIT 1`).bind(memberId).first();
	if (request.method === 'POST') {
		if (!sameOrigin(request)) return new Response('Invalid request origin.', { status: 403 });
		const form = await request.formData();
		if (String(form.get('action')) === 'connect_whatsapp' && member.email) {
			const businessNumber = (env.WHATSAPP_BUSINESS_NUMBER ?? '').replace(/\D/g, '');
			if (!businessNumber) return new Response('WhatsApp connection is not configured.', { status: 503 });
			const code = generateEnrolmentCode();
			await env.DB.prepare(`INSERT INTO enrolment_invites (tenant_id, project_id, created_by_management_user_id, code_hash, expires_at, max_uses) VALUES (?, ?, 1, ?, ?, 1)`).bind(member.tenant_id, member.primary_project_id, await hashEnrolmentCode(code), new Date(Date.now()+30*60*1000).toISOString()).run();
			const message = `JOIN ${code} ${member.email}`;
			return new Response(null, {
				status: 303,
				headers: {
					Location: `https://wa.me/${businessNumber}?text=${encodeURIComponent(message)}`,
					'Cache-Control': 'no-store',
				},
			});
		}
	}
	return page('Employee dashboard', `<div class="top"><div><h1>Hello, ${escapeHtml(member.name)}</h1><p class="muted">${escapeHtml(member.department)}</p></div><form class="inline" method="post" action="/employee/logout"><button class="secondary">Sign out</button></form></div><section class="card"><h2>Communication channels</h2><p class="muted">Choose how Dutha should send your reminders, confirmations and Jira results.</p><div class="grid"><article class="channel ready"><span class="badge green">${identity ? 'Connected' : 'Available'}</span><h2>WhatsApp</h2><p>Text and voice stand-ups, reminders and confirmations.</p>${identity ? '<p><strong>Your WhatsApp channel is verified.</strong></p>' : '<form method="post"><input type="hidden" name="action" value="connect_whatsapp"><button>Connect WhatsApp</button></form>'}</article><article class="channel soon"><span class="badge">Coming soon</span><h2>Microsoft Teams</h2><p>Receive and reply inside Teams.</p></article><article class="channel soon"><span class="badge">Coming soon</span><h2>Slack</h2><p>Stand-ups and actions from Slack.</p></article><article class="channel soon"><span class="badge">Coming soon</span><h2>Email</h2><p>Notifications and activity summaries.</p></article></div></section>`);
}

export async function employeePortalResponse(request: Request, env: WorkerEnv): Promise<Response> {
	const path = new URL(request.url).pathname;
	if (path === '/employee/activate') return activationResponse(request, env);
	if (path === '/employee/login') return loginResponse(request, env);
	if (path === '/employee/logout') return new Response(null, { status: 303, headers: { Location: '/employee/login', 'Set-Cookie': `${COOKIE_NAME}=; Max-Age=0; Path=/employee; HttpOnly; Secure; SameSite=Strict` } });
	const memberId = await memberFromSession(request, env);
	if (!memberId) return Response.redirect(`${new URL(request.url).origin}/employee/login`, 302);
	return dashboardResponse(request, env, memberId);
}
