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
	const emailReady = Boolean(env.RESEND_API_KEY && settings?.from_email);
	const whatsappReady = Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_APP_SECRET);
	const jiraReady = Boolean(env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN && env.JIRA_PROJECT_KEY);
	const tile = (name: string, ready: boolean, copy: string, href: string) => `<article class="integration"><span class="eyebrow">CHANNEL</span><h2>${name}</h2><p>${copy}</p><span class="pill ${ready ? 'ready' : 'needs'}">${ready ? 'Connected' : 'Needs setup'}</span><a href="${href}">${ready ? 'Manage connection' : 'Open setup'}</a></article>`;
	const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connection hub · Dutha</title><style>:root{font-family:Inter,Arial,sans-serif;color:#dbeafe;background:#070b18;color-scheme:dark}*{box-sizing:border-box}body{margin:0;padding:28px;min-height:100vh;background:radial-gradient(circle at 12% 0,#172554 0,transparent 38%),radial-gradient(circle at 92% 8%,#312e81 0,transparent 34%),#070b18}main{max-width:1040px;margin:auto}.head{display:flex;justify-content:space-between;align-items:start;gap:18px;margin-bottom:22px}h1,h2{color:#f8fafc;margin-top:0}h1{margin-bottom:7px}.muted{color:#94a3b8}.card,.integration{background:#111827d9;border:1px solid #334155;border-radius:18px;box-shadow:0 18px 50px #0005;backdrop-filter:blur(18px)}.card{padding:24px;margin-top:20px}.integrations{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.integration{padding:18px;min-height:198px;display:flex;flex-direction:column;align-items:start}.integration p{color:#94a3b8;line-height:1.45;flex:1}.integration a{color:#bfdbfe;font-weight:800;text-decoration:none;margin-top:14px}.eyebrow{color:#60a5fa;font-size:11px;font-weight:900;letter-spacing:.11em}.pill{padding:5px 9px;border-radius:99px;font-size:12px;font-weight:800}.ready{background:#1e3a8a;color:#bfdbfe}.needs{background:#312e81;color:#ddd6fe}.notice,.error{padding:12px;border-radius:11px;margin:14px 0}.notice{background:#0c4a6e;color:#e0f2fe}.error{background:#450a0a;color:#fecaca}label{display:grid;gap:7px;font-weight:700;margin:14px 0;color:#cbd5e1}input{padding:11px;border:1px solid #475569;border-radius:10px;font:inherit;background:#0b1220;color:#f8fafc}button,.button{display:inline-block;border:0;border-radius:10px;padding:11px 15px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;text-decoration:none;font-weight:800;cursor:pointer}.status{background:#0f2747;color:#bfdbfe;border-radius:11px;padding:12px}.actions{display:flex;gap:10px;flex-wrap:wrap}.secondary{background:#334155}.security{margin-top:16px;color:#94a3b8;font-size:13px;line-height:1.5}@media(max-width:760px){body{padding:15px}.head{flex-direction:column}.integrations{grid-template-columns:1fr}}</style></head><body><main><div class="head"><div><span class="eyebrow">ORGANISATION CONTROL</span><h1>Connection hub</h1><p class="muted">Keep Dutha’s communication channels ready for your team.</p></div><a class="button secondary" href="/dashboard">Dashboard</a></div>${message ? `<div class="notice">${escapeHtml(message)}</div>` : ''}${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}<section class="integrations">${tile('Email', emailReady, 'Sender identity, test delivery and reply-to address.', '#email')}${tile('WhatsApp', whatsappReady, 'Templates, business number and employee enrolment.', '/dashboard/channels')}${tile('Jira', jiraReady, 'Issue creation, updates and resolution verification.', '/dashboard/channels')}</section><section class="card" id="email"><span class="eyebrow">EMAIL CONNECTION</span><h2>Email delivery</h2><p class="status">Resend API key: ${env.RESEND_API_KEY ? 'Configured' : 'Not configured'}</p><p class="security">Your sender identity is managed here. The Resend API key remains a protected Cloudflare secret and is never displayed or stored in D1.</p><form method="post"><input type="hidden" name="action" value="save"><label>Company name<input name="company_name" maxlength="100" required value="${escapeHtml(settings?.company_name ?? '')}"></label><label>Sender name<input name="sender_name" maxlength="100" required value="${escapeHtml(settings?.sender_name ?? 'Dutha WorkOps')}"></label><label>Verified sender email<input name="from_email" type="email" maxlength="254" required value="${escapeHtml(settings?.from_email ?? '')}"></label><label>Reply-to email<input name="reply_to_email" type="email" maxlength="254" value="${escapeHtml(settings?.reply_to_email ?? '')}"></label><div class="actions"><button>Save email identity</button></div></form>${settings ? `<form method="post"><input type="hidden" name="action" value="test"><button class="secondary">Send test email to reply-to address</button></form>` : ''}</section></main></body></html>`;
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
