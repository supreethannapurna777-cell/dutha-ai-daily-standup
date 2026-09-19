import { managementPrincipalFromRequest } from './access-control';
import { emailSettings, sendManagerActivationEmail } from './email';
import type { WorkerEnv } from './env';

function escapeHtml(value: unknown): string {
	return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function sameOrigin(request: Request): boolean {
	const origin = request.headers.get('Origin');
	if (origin && origin !== 'null') return origin === new URL(request.url).origin;
	return request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

function authorised(request: Request, env: WorkerEnv): boolean {
	return request.headers.get('Authorization') === `Basic ${btoa(`${env.DASHBOARD_USERNAME}:${env.DASHBOARD_PASSWORD}`)}`;
}

function validEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function render(env: WorkerEnv, tenantId: number, message = '', error = ''): Promise<Response> {
	const settings = await emailSettings(env.DB, tenantId);
	const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Organisation settings · Dutha</title><style>:root{font-family:Inter,Arial,sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0;padding:28px}main{max-width:850px;margin:auto}.head{display:flex;justify-content:space-between;align-items:center}.card{background:#fff;border-radius:15px;padding:24px;box-shadow:0 5px 22px #0f172a12;margin-top:20px}h1,h2{color:#173f6b}label{display:grid;gap:6px;font-weight:700;margin:14px 0}input{padding:11px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}button,.button{display:inline-block;border:0;border-radius:8px;padding:11px 15px;background:#1769aa;color:#fff;text-decoration:none;font-weight:800}.status,.notice,.error{padding:12px;border-radius:9px}.status,.notice{background:#dcfce7;color:#166534}.error{background:#fee2e2;color:#991b1b}.muted{color:#64748b}.actions{display:flex;gap:10px;flex-wrap:wrap}.secondary{background:#475569}@media(max-width:650px){body{padding:15px}.head{align-items:start;flex-direction:column;gap:10px}}</style></head><body><main><div class="head"><div><h1>Organisation settings</h1><p class="muted">Configure the identity used for automatic Dutha emails.</p></div><a class="button secondary" href="/dashboard">Dashboard</a></div>${message ? `<div class="notice">${escapeHtml(message)}</div>` : ''}${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}<section class="card"><h2>Email delivery</h2><p class="status">Resend API key: ${env.RESEND_API_KEY ? 'Configured' : 'Not configured'}</p><p class="muted">The API key is stored only as a protected Cloudflare secret. It cannot be viewed or changed here.</p><form method="post"><input type="hidden" name="action" value="save"><label>Company name<input name="company_name" maxlength="100" required value="${escapeHtml(settings?.company_name ?? '')}"></label><label>Sender name<input name="sender_name" maxlength="100" required value="${escapeHtml(settings?.sender_name ?? 'Dutha WorkOps')}"></label><label>Verified sender email<input name="from_email" type="email" maxlength="254" required value="${escapeHtml(settings?.from_email ?? '')}"></label><label>Reply-to email<input name="reply_to_email" type="email" maxlength="254" value="${escapeHtml(settings?.reply_to_email ?? '')}"></label><div class="actions"><button>Save settings</button></div></form>${settings ? `<form method="post"><input type="hidden" name="action" value="test"><button class="secondary">Send test email to reply-to address</button></form>` : ''}</section></main></body></html>`;
	return new Response(body, { status: error ? 400 : 200, headers: { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store', 'X-Frame-Options':'DENY', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" } });
}

export async function settingsManagementResponse(request: Request, env: WorkerEnv): Promise<Response> {
	if (!authorised(request, env)) return new Response('Authentication required.', { status: 401 });
	const actor = managementPrincipalFromRequest(request) ?? { userId:1, tenantId:1, role:'admin' as const };
	if (actor.role !== 'admin') return new Response('Administrator access required.', { status: 403 });
	if (request.method === 'GET') return render(env, actor.tenantId, new URL(request.url).searchParams.get('saved') ? 'Settings saved.' : '');
	if (request.method !== 'POST') return new Response('Method not allowed.', { status: 405 });
	if (!sameOrigin(request)) return new Response('Invalid request origin.', { status: 403 });
	const form = await request.formData();
	if (String(form.get('action')) === 'test') {
		const settings = await emailSettings(env.DB, actor.tenantId);
		const recipient = settings?.reply_to_email || settings?.from_email;
		if (!settings || !recipient) return render(env, actor.tenantId, '', 'Save valid email settings first.');
		const result = await sendManagerActivationEmail(env, actor.tenantId, recipient, 'Dutha Administrator', `${new URL(request.url).origin}/login`);
		return render(env, actor.tenantId, result.sent ? 'Test email sent.' : '', result.sent ? '' : result.reason ?? 'Test email failed.');
	}
	const company = String(form.get('company_name') ?? '').trim();
	const sender = String(form.get('sender_name') ?? '').trim();
	const from = String(form.get('from_email') ?? '').trim().toLowerCase();
	const reply = String(form.get('reply_to_email') ?? '').trim().toLowerCase();
	if (!company || company.length > 100 || !sender || sender.length > 100 || !validEmail(from) || (reply && !validEmail(reply))) return render(env, actor.tenantId, '', 'Enter valid organisation email settings.');
	await env.DB.prepare(`INSERT INTO organisation_email_settings (tenant_id, company_name, sender_name, from_email, reply_to_email) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET company_name=excluded.company_name, sender_name=excluded.sender_name, from_email=excluded.from_email, reply_to_email=excluded.reply_to_email, updated_at=CURRENT_TIMESTAMP`).bind(actor.tenantId, company, sender, from, reply || null).run();
	return new Response(null, { status:303, headers:{ Location:'/dashboard/settings?saved=1' } });
}
