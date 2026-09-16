import type { WorkerEnv } from './env';

const COOKIE_NAME = 'dutha_session';
const SESSION_SECONDS = 8 * 60 * 60;

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

async function validSession(request: Request, env: WorkerEnv): Promise<boolean> {
	const secret = env.DASHBOARD_SESSION_SECRET;
	const session = cookieValue(request);
	if (!secret || !session) return false;

	const [expiresText, suppliedSignature, extra] = session.split('.');
	if (!expiresText || !suppliedSignature || extra) return false;
	const expires = Number(expiresText);
	if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) {
		return false;
	}

	const expected = await signature(expiresText, secret);
	return safeEqual(suppliedSignature, expected);
}

export async function authenticatedManagementRequest(request: Request, env: WorkerEnv): Promise<Request | null> {
	if (request.headers.has('Authorization')) {
		return request;
	}
	if (!(await validSession(request, env))) return null;

	const headers = new Headers(request.headers);
	headers.set('Authorization', `Basic ${btoa(`${env.DASHBOARD_USERNAME}:${env.DASHBOARD_PASSWORD}`)}`);
	// The existing environment login is the seeded Aurowise administrator.
	// Future identity providers must replace these values with the authenticated
	// management_users record, never client-supplied headers.
	headers.set('X-Dutha-User-Id', '1');
	headers.set('X-Dutha-Tenant-Id', '1');
	headers.set('X-Dutha-Tenant-Role', 'admin');
	return new Request(request, { headers });
}

function safeNext(value: string | null): string {
	return value?.startsWith('/dashboard') && !value.startsWith('//') ? value : '/dashboard';
}

function loginPage(next: string, error = ''): Response {
	const errorHtml = error ? `<div class="error" role="alert">${html(error)}</div>` : '';
	const body = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Dutha WorkOps</title><style>
:root{font-family:Inter,Arial,sans-serif;color:#172033;background:#eef4fb}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at top right,#dbeafe 0,transparent 36%),#eef4fb}
.shell{width:min(920px,100%);display:grid;grid-template-columns:1.05fr .95fr;background:#fff;border-radius:22px;overflow:hidden;box-shadow:0 24px 70px #173f6b26}
.brand{padding:58px;background:linear-gradient(145deg,#173f6b,#1769aa);color:#fff}.mark{font-size:44px;font-weight:800}.brand p{font-size:19px;line-height:1.55;color:#dbeafe}.pill{display:inline-block;padding:7px 11px;border:1px solid #ffffff55;border-radius:999px;font-size:13px}
.form{padding:58px 48px;display:flex;flex-direction:column;justify-content:center}h1{margin:0 0 8px;color:#173f6b}.muted{margin:0 0 28px;color:#64748b}
label{font-weight:700;margin:13px 0 7px}input{width:100%;padding:13px;border:1px solid #cbd5e1;border-radius:9px;font:inherit}input:focus{outline:3px solid #bfdbfe;border-color:#1769aa}
button{margin-top:22px;padding:13px;border:0;border-radius:9px;background:#1769aa;color:#fff;font:inherit;font-weight:800;cursor:pointer}.error{padding:11px;border-radius:8px;color:#991b1b;background:#fee2e2}.note{margin-top:20px;color:#64748b;font-size:12px}
@media(max-width:720px){.shell{grid-template-columns:1fr}.brand{padding:32px}.form{padding:36px 28px}}
</style></head><body><main class="shell"><section class="brand"><span class="pill">Private management workspace</span><div class="mark">Dutha</div><p>Stand-ups, blockers and coordination—one calm view for the manager.</p></section>
<section class="form"><h1>Welcome back</h1><p class="muted">Sign in to your WorkOps dashboard.</p>${errorHtml}
<form method="post" action="/login"><input type="hidden" name="next" value="${html(next)}"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required autofocus><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in securely</button></form>
<div class="note">Authorised managers only · Session expires after 8 hours</div></section></main></body></html>`;
	return new Response(body, { status: error ? 401 : 200, headers: secureHeaders() });
}

export async function loginResponse(request: Request, env: WorkerEnv): Promise<Response> {
	if (!env.DASHBOARD_USERNAME || !env.DASHBOARD_PASSWORD || !env.DASHBOARD_SESSION_SECRET) {
		return new Response('Dashboard login is not configured.', { status: 503 });
	}
	const url = new URL(request.url);
	if (request.method === 'GET') return loginPage(safeNext(url.searchParams.get('next')));
	if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

	const data = await request.formData();
	const username = String(data.get('username') ?? '');
	const password = String(data.get('password') ?? '');
	const next = safeNext(String(data.get('next') ?? ''));
	if (!safeEqual(username, env.DASHBOARD_USERNAME) || !safeEqual(password, env.DASHBOARD_PASSWORD)) {
		return loginPage(next, 'The username or password is incorrect.');
	}

	const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
	const token = `${expires}.${await signature(String(expires), env.DASHBOARD_SESSION_SECRET)}`;
	return new Response(null, {
		status: 303,
		headers: {
			Location: next,
			'Set-Cookie': `${COOKIE_NAME}=${token}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`,
			'Cache-Control': 'no-store',
		},
	});
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
