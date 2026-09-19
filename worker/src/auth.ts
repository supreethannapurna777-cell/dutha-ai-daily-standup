import type { WorkerEnv } from './env';

const COOKIE_NAME = 'dutha_session';
const SESSION_SECONDS = 8 * 60 * 60;
const PASSWORD_ITERATIONS = 100_000;

interface SessionPrincipal {
	userId: number;
	tenantId: number;
	role: 'admin' | 'portfolio_leader' | 'project_manager';
}

function html(value: unknown): string {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;');
}

function secureHeaders(): HeadersInit {
	return {
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-store',
		'X-Frame-Options': 'DENY',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'no-referrer',
		'Content-Security-Policy':
			"default-src 'none'; style-src 'unsafe-inline'; " + "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	};
}

function safeEqual(left: string, right: string): boolean {
	const leftBytes = new TextEncoder().encode(left);
	const rightBytes = new TextEncoder().encode(right);
	let difference = leftBytes.length ^ rightBytes.length;
	const length = Math.max(leftBytes.length, rightBytes.length);

	for (let index = 0; index < length; index += 1) {
		difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
	}

	return difference === 0;
}

function base64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlToBytes(value: string): Uint8Array {
	const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function sha256(value: string): Promise<string> {
	return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

async function passwordHash(password: string, salt: Uint8Array): Promise<string> {
	const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PASSWORD_ITERATIONS }, material, 256);
	return base64Url(new Uint8Array(bits));
}

async function signature(payload: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
	return base64Url(new Uint8Array(signed));
}

function cookieValue(request: Request): string | null {
	const cookies = request.headers.get('Cookie') ?? '';
	for (const part of cookies.split(';')) {
		const [name, ...value] = part.trim().split('=');
		if (name === COOKIE_NAME) return value.join('=');
	}
	return null;
}

async function validSession(request: Request, env: WorkerEnv): Promise<SessionPrincipal | null> {
	const secret = env.DASHBOARD_SESSION_SECRET;
	const session = cookieValue(request);
	if (!secret || !session) return null;

	const parts = session.split('.');
	if (parts.length === 2) {
		const [expiresText, suppliedSignature] = parts;
		const expires = Number(expiresText);
		if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) return null;
		return safeEqual(suppliedSignature, await signature(expiresText, secret)) ? { userId: 1, tenantId: 1, role: 'admin' } : null;
	}
	if (parts.length !== 5) return null;
	const [userText, tenantText, roleText, expiresText, suppliedSignature] = parts;
	const userId = Number(userText);
	const tenantId = Number(tenantText);
	const expires = Number(expiresText);
	if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(tenantId) || tenantId <= 0 || !['admin', 'portfolio_leader', 'project_manager'].includes(roleText) || !Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) return null;
	const payload = `${userText}.${tenantText}.${roleText}.${expiresText}`;
	return safeEqual(suppliedSignature, await signature(payload, secret)) ? { userId, tenantId, role: roleText as SessionPrincipal['role'] } : null;
}

export async function authenticatedManagementRequest(request: Request, env: WorkerEnv): Promise<Request | null> {
	if (request.headers.has('Authorization')) {
		return request;
	}
	const principal = await validSession(request, env);
	if (!principal) return null;

	const headers = new Headers(request.headers);
	headers.set('Authorization', `Basic ${btoa(`${env.DASHBOARD_USERNAME}:${env.DASHBOARD_PASSWORD}`)}`);
	// The existing environment login is the seeded Aurowise administrator.
	// Future identity providers must replace these values with the authenticated
	// management_users record, never client-supplied headers.
	headers.set('X-Dutha-User-Id', String(principal.userId));
	headers.set('X-Dutha-Tenant-Id', String(principal.tenantId));
	headers.set('X-Dutha-Tenant-Role', principal.role);
	return new Request(request, { headers });
}

function safeNext(value: string | null): string {
	return value?.startsWith('/dashboard') && !value.startsWith('//') ? value : '/dashboard';
}

function loginPage(next: string, error = '', activated = false): Response {
	const errorHtml = error ? `<div class="error" role="alert">${html(error)}</div>` : '';
	const successHtml = activated ? '<div class="success">Account activated. You can sign in now.</div>' : '';
	const body = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Dutha WorkOps</title><style>
:root{font-family:Inter,Arial,sans-serif;color:#172033;background:#eef4fb}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at top right,#dbeafe 0,transparent 36%),#eef4fb}
.shell{width:min(920px,100%);display:grid;grid-template-columns:1.05fr .95fr;background:#fff;border-radius:22px;overflow:hidden;box-shadow:0 24px 70px #173f6b26}
.brand{padding:58px;background:linear-gradient(145deg,#173f6b,#1769aa);color:#fff}.mark{font-size:44px;font-weight:800}.brand p{font-size:19px;line-height:1.55;color:#dbeafe}.pill{display:inline-block;padding:7px 11px;border:1px solid #ffffff55;border-radius:999px;font-size:13px}
.form{padding:58px 48px;display:flex;flex-direction:column;justify-content:center}h1{margin:0 0 8px;color:#173f6b}.muted{margin:0 0 28px;color:#64748b}
label{font-weight:700;margin:13px 0 7px}input{width:100%;padding:13px;border:1px solid #cbd5e1;border-radius:9px;font:inherit}input:focus{outline:3px solid #bfdbfe;border-color:#1769aa}
button{margin-top:22px;padding:13px;border:0;border-radius:9px;background:#1769aa;color:#fff;font:inherit;font-weight:800;cursor:pointer}.error,.success{padding:11px;border-radius:8px}.error{color:#991b1b;background:#fee2e2}.success{color:#166534;background:#dcfce7}.note{margin-top:20px;color:#64748b;font-size:12px}
@media(max-width:720px){.shell{grid-template-columns:1fr}.brand{padding:32px}.form{padding:36px 28px}}
</style></head><body><main class="shell"><section class="brand"><span class="pill">Private management workspace</span><div class="mark">Dutha</div><p>Stand-ups, blockers and coordination—one calm view for the manager.</p></section>
<section class="form"><h1>Welcome back</h1><p class="muted">Sign in to your WorkOps dashboard.</p>${successHtml}${errorHtml}
<form method="post" action="/login"><input type="hidden" name="next" value="${html(next)}"><label for="username">Work email or recovery username</label><input id="username" name="username" autocomplete="username" required autofocus><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in securely</button></form>
<div class="note">Authorised managers only · Session expires after 8 hours</div></section></main></body></html>`;
	return new Response(body, { status: error ? 401 : 200, headers: secureHeaders() });
}

export async function loginResponse(request: Request, env: WorkerEnv): Promise<Response> {
	if (!env.DASHBOARD_USERNAME || !env.DASHBOARD_PASSWORD || !env.DASHBOARD_SESSION_SECRET) {
		return new Response('Dashboard login is not configured.', { status: 503 });
	}
	const url = new URL(request.url);
	if (request.method === 'GET') return loginPage(safeNext(url.searchParams.get('next')), '', url.searchParams.get('activated') === '1');
	if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

	const data = await request.formData();
	const username = String(data.get('username') ?? '');
	const password = String(data.get('password') ?? '');
	const next = safeNext(String(data.get('next') ?? ''));
	let principal: SessionPrincipal | null = null;
	if (safeEqual(username, env.DASHBOARD_USERNAME) && safeEqual(password, env.DASHBOARD_PASSWORD)) {
		principal = { userId: 1, tenantId: 1, role: 'admin' };
	} else {
		const account = await env.DB.prepare(`
			SELECT user.id, user.tenant_id, user.tenant_role, account.password_hash, account.password_salt
			FROM management_users AS user
			INNER JOIN management_accounts AS account ON account.management_user_id = user.id
			WHERE lower(user.email) = ? AND user.active = 1 AND account.activated_at IS NOT NULL
			LIMIT 1
		`).bind(username.trim().toLowerCase()).first<{ id:number; tenant_id:number; tenant_role:SessionPrincipal['role']; password_hash:string; password_salt:string }>();
		if (account && safeEqual(await passwordHash(password, base64UrlToBytes(account.password_salt)), account.password_hash)) {
			principal = { userId: account.id, tenantId: account.tenant_id, role: account.tenant_role };
			await env.DB.prepare(`UPDATE management_accounts SET last_login_at=CURRENT_TIMESTAMP WHERE management_user_id=?`).bind(account.id).run();
		}
	}
	if (!principal) {
		return loginPage(next, 'The username or password is incorrect.');
	}

	const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
	const payload = `${principal.userId}.${principal.tenantId}.${principal.role}.${expires}`;
	const token = `${payload}.${await signature(payload, env.DASHBOARD_SESSION_SECRET)}`;
	return new Response(null, {
		status: 303,
		headers: {
			Location: next,
			'Set-Cookie': `${COOKIE_NAME}=${token}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`,
			'Cache-Control': 'no-store',
		},
	});
}

function sameOrigin(request: Request): boolean {
	const origin = request.headers.get('Origin');
	if (origin && origin !== 'null') return origin === new URL(request.url).origin;
	return request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

function strongPassword(value: string): boolean {
	return value.length >= 12 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
}

export async function createManagerActivation(db: D1Database, managementUserId: number, now = new Date()): Promise<string> {
	const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
	await db.batch([
		db.prepare(`INSERT OR IGNORE INTO management_accounts (management_user_id) VALUES (?)`).bind(managementUserId),
		db.prepare(`UPDATE management_activation_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE management_user_id=? AND used_at IS NULL AND revoked_at IS NULL`).bind(managementUserId),
		db.prepare(`INSERT INTO management_activation_tokens (management_user_id, token_hash, expires_at) VALUES (?, ?, ?)`).bind(managementUserId, await sha256(token), new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()),
	]);
	return token;
}

function activationPage(token: string, error = ''): Response {
	return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Activate manager account · Dutha</title><style>:root{font-family:Inter,Arial,sans-serif;color:#172033;background:#eef4fb}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(560px,100%);background:#fff;border-radius:18px;padding:30px;box-shadow:0 18px 55px #173f6b24}h1{color:#173f6b}p{color:#64748b}label{display:grid;gap:7px;font-weight:700;margin:14px 0}input{padding:12px;border:1px solid #cbd5e1;border-radius:9px;font:inherit}button{padding:12px 16px;border:0;border-radius:9px;background:#1769aa;color:#fff;font-weight:800}.error{background:#fee2e2;color:#991b1b;padding:11px;border-radius:9px}</style></head><body><main class="card"><h1>Activate your manager account</h1><p>Create a private password with at least 12 characters, uppercase, lowercase and a number.</p>${error ? `<div class="error">${html(error)}</div>` : ''}<form method="post" action="/manager/activate"><input type="hidden" name="token" value="${html(token)}"><label>Password<input type="password" name="password" minlength="12" required></label><label>Confirm password<input type="password" name="confirm_password" minlength="12" required></label><button>Activate account</button></form></main></body></html>`, { headers: secureHeaders() });
}

export async function managerActivationResponse(request: Request, env: WorkerEnv): Promise<Response> {
	if (request.method === 'GET') return activationPage(new URL(request.url).searchParams.get('token') ?? '');
	if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
	if (!sameOrigin(request)) return new Response('Invalid request origin.', { status: 403 });
	const form = await request.formData();
	const token = String(form.get('token') ?? '');
	const password = String(form.get('password') ?? '');
	if (!token || !strongPassword(password) || password !== String(form.get('confirm_password') ?? '')) return activationPage(token, 'Passwords must match and meet all password requirements.');
	const row = await env.DB.prepare(`SELECT id, management_user_id FROM management_activation_tokens WHERE token_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>? LIMIT 1`).bind(await sha256(token), new Date().toISOString()).first<{ id:number; management_user_id:number }>();
	if (!row) return activationPage('', 'This activation link is invalid, expired or already used.');
	const salt = crypto.getRandomValues(new Uint8Array(16));
	await env.DB.batch([
		env.DB.prepare(`UPDATE management_accounts SET password_hash=?, password_salt=?, activated_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE management_user_id=?`).bind(await passwordHash(password, salt), base64Url(salt), row.management_user_id),
		env.DB.prepare(`UPDATE management_activation_tokens SET used_at=CURRENT_TIMESTAMP WHERE id=?`).bind(row.id),
	]);
	return new Response(null, { status: 303, headers: { Location: '/login?activated=1', 'Cache-Control': 'no-store' } });
}

export function logoutResponse(): Response {
	return new Response(null, {
		status: 303,
		headers: {
			Location: '/login',
			'Set-Cookie': `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`,
			'Cache-Control': 'no-store',
		},
	});
}
