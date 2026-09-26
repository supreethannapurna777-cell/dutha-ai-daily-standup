import { managementPrincipalFromRequest, type TenantRole } from './access-control';
import { emailSettings, sendManagerActivationEmail } from './email';
import type { WorkerEnv } from './env';

type Profile = { whatsapp_business_name: string | null; whatsapp_business_number: string | null };
const esc = (v: unknown) => String(v ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const phoneOk = (v: string) => /^[1-9][0-9]{7,14}$/.test(v);

function auth(request: Request, env: WorkerEnv) {
	return request.headers.get('Authorization') === 'Basic ' + btoa(env.DASHBOARD_USERNAME + ':' + env.DASHBOARD_PASSWORD);
}
function sameOrigin(request: Request) {
	const origin = request.headers.get('Origin');
	return origin && origin !== 'null' ? origin === new URL(request.url).origin : request.headers.get('Sec-Fetch-Site') === 'same-origin';
}
async function profile(db: D1Database, tenantId: number) {
	return db.prepare('SELECT whatsapp_business_name, whatsapp_business_number FROM organisation_connection_profiles WHERE tenant_id=?').bind(tenantId).first<Profile>();
}
function headers(): HeadersInit {
	return {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"};
}
function badge(connected: boolean, saved: boolean) {
	return connected ? '<span class="pill connected">Connected</span>' : saved ? '<span class="pill pending">Details saved · platform setup pending</span>' : '<span class="pill">Needs setup</span>';
}

async function render(env: WorkerEnv, tenantId: number, role: TenantRole, message = '', error = ''): Promise<Response> {
	const [settings, wa] = await Promise.all([emailSettings(env.DB, tenantId), profile(env.DB, tenantId)]);
	const emailReady = Boolean(env.RESEND_API_KEY && settings?.from_email);
	const whatsAppReady = Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_APP_SECRET && wa?.whatsapp_business_number);
	const jiraReady = Boolean(env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN && env.JIRA_PROJECT_KEY);
	const admin = role === 'admin';
	const field = (label: string, name: string, value: string, extra = '') => '<label>' + label + '<input name="' + name + '" ' + extra + ' value="' + esc(value) + '"></label>';
	const tile = (name: string, copy: string, state: string, href = '') => '<article class="tile"><small>CHANNEL</small><h2>' + name + '</h2><p>' + copy + '</p>' + state + (href ? '<a href="' + href + '">Technical setup →</a>' : '') + '</article>';
	const body = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Company connections · Dutha</title><style>:root{font-family:Inter,Arial,sans-serif;color:#dbeafe;background:#070b18}*{box-sizing:border-box}body{margin:0;padding:28px;min-height:100vh;background:radial-gradient(circle at 12% 0,#172554 0,transparent 38%),radial-gradient(circle at 92% 8%,#312e81 0,transparent 34%),#070b18}main{max-width:1100px;margin:auto}.head{display:flex;justify-content:space-between;gap:18px;margin-bottom:22px}h1,h2{color:#f8fafc;margin:0 0 7px}.muted,p{color:#94a3b8}.button,button{border:0;border-radius:10px;padding:11px 15px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;text-decoration:none;font-weight:800;cursor:pointer}.secondary{background:#334155}.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.tile,.card{background:#111827d9;border:1px solid #334155;border-radius:18px;box-shadow:0 18px 50px #0005}.tile{padding:18px;min-height:205px;display:flex;flex-direction:column;align-items:start}.tile small{color:#60a5fa;font-weight:900}.tile p{line-height:1.45;flex:1}.tile a{color:#bfdbfe;margin-top:14px;font-weight:800}.pill{padding:5px 9px;border-radius:99px;background:#312e81;color:#ddd6fe;font-size:12px;font-weight:800}.connected{background:#1e3a8a;color:#bfdbfe}.pending{background:#3b2f71}.card{padding:24px;margin-top:20px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}label{display:grid;gap:7px;font-weight:700;margin:8px 0;color:#cbd5e1}input{padding:11px;border:1px solid #475569;border-radius:10px;background:#0b1220;color:#f8fafc;font:inherit}.note{color:#94a3b8;font-size:13px;line-height:1.5}.notice,.error{padding:12px;border-radius:11px;margin:14px 0}.notice{background:#0c4a6e}.error{background:#450a0a;color:#fecaca}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}@media(max-width:760px){body{padding:15px}.head{flex-direction:column}.tiles,.grid{grid-template-columns:1fr}}</style></head><body><main><header class="head"><div><small>' + (role === 'ceo' ? 'CHIEF EXECUTIVE CONTROL' : 'ORGANISATION CONTROL') + '</small><h1>Company connections</h1><p class="muted">Official communication identity and live connection health.</p></div><a class="button secondary" href="/dashboard">Dashboard</a></header>' + (message ? '<div class="notice">' + esc(message) + '</div>' : '') + (error ? '<div class="error">' + esc(error) + '</div>' : '') + '<section class="tiles">' + tile('Email','Official sender and reply-to email.',badge(emailReady,Boolean(settings?.from_email))) + tile('WhatsApp','Company business number for stand-ups and confirmations.',badge(whatsAppReady,Boolean(wa?.whatsapp_business_number)),admin ? '/dashboard/channels' : '') + tile('Jira','Issue creation and verified-resolution health.',badge(jiraReady,false),admin ? '/dashboard/channels' : '') + '</section><section class="card"><small>COMPANY IDENTITY</small><h2>Official channels</h2><p class="note">CEO and Administrator can maintain company details. Meta, Jira and email-provider keys remain protected Cloudflare secrets and are never displayed here.</p><form method="post"><input type="hidden" name="action" value="save_identity"><div class="grid">' + field('Company name','company_name',settings?.company_name ?? '','maxlength="100" required') + field('Official WhatsApp business name','whatsapp_business_name',wa?.whatsapp_business_name ?? '','maxlength="100"') + field('WhatsApp business number','whatsapp_business_number',wa?.whatsapp_business_number ?? '','inputmode="numeric" maxlength="15" placeholder="Country code and number"') + field('Sender name','sender_name',settings?.sender_name ?? 'Dutha WorkOps','maxlength="100" required') + field('Verified sender email','from_email',settings?.from_email ?? '','type="email" maxlength="254" required') + field('Reply-to / received email','reply_to_email',settings?.reply_to_email ?? '','type="email" maxlength="254"') + '</div><div class="actions"><button>Save company identity</button></div></form>' + (settings ? '<form method="post" class="actions"><input type="hidden" name="action" value="test_email"><button class="secondary">Send test email to reply-to address</button></form>' : '') + '</section></main></body></html>';
	return new Response(body,{status:error?400:200,headers:headers()});
}

export async function settingsManagementResponse(request: Request, env: WorkerEnv): Promise<Response> {
	if (!auth(request,env)) return new Response('Authentication required.',{status:401});
	const actor = managementPrincipalFromRequest(request) ?? {userId:1,tenantId:1,role:'admin' as const};
	if (!['admin','ceo'].includes(actor.role)) return new Response('CEO or Administrator access required.',{status:403});
	if (request.method === 'GET') return render(env,actor.tenantId,actor.role,new URL(request.url).searchParams.get('saved')?'Company identity saved.':'');
	if (request.method !== 'POST') return new Response('Method not allowed.',{status:405});
	if (!sameOrigin(request)) return new Response('Invalid request origin.',{status:403});
	const form = await request.formData();
	if (String(form.get('action')) === 'test_email') {
		const settings = await emailSettings(env.DB,actor.tenantId);
		const recipient = settings?.reply_to_email || settings?.from_email;
		if (!settings || !recipient) return render(env,actor.tenantId,actor.role,'','Save valid email settings first.');
		const result = await sendManagerActivationEmail(env,actor.tenantId,recipient,settings.sender_name,new URL(request.url).origin + '/login');
		return render(env,actor.tenantId,actor.role,result.sent?'Test email sent.':'',result.sent?'':result.reason ?? 'Test email failed.');
	}
	const company = String(form.get('company_name')??'').trim(), sender = String(form.get('sender_name')??'').trim(), from = String(form.get('from_email')??'').trim().toLowerCase(), reply = String(form.get('reply_to_email')??'').trim().toLowerCase(), waName = String(form.get('whatsapp_business_name')??'').trim(), waNumber = String(form.get('whatsapp_business_number')??'').replaceAll(/[^0-9]/g,'');
	if (!company || company.length>100 || !sender || sender.length>100 || !emailOk(from) || (reply && !emailOk(reply)) || waName.length>100 || (waNumber && !phoneOk(waNumber))) return render(env,actor.tenantId,actor.role,'','Enter valid company email and WhatsApp details.');
	await env.DB.batch([
		env.DB.prepare('INSERT INTO organisation_email_settings (tenant_id,company_name,sender_name,from_email,reply_to_email) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET company_name=excluded.company_name,sender_name=excluded.sender_name,from_email=excluded.from_email,reply_to_email=excluded.reply_to_email,updated_at=CURRENT_TIMESTAMP').bind(actor.tenantId,company,sender,from,reply||null),
		env.DB.prepare('INSERT INTO organisation_connection_profiles (tenant_id,whatsapp_business_name,whatsapp_business_number) VALUES (?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET whatsapp_business_name=excluded.whatsapp_business_name,whatsapp_business_number=excluded.whatsapp_business_number,updated_at=CURRENT_TIMESTAMP').bind(actor.tenantId,waName||null,waNumber||null),
	]);
	return new Response(null,{status:303,headers:{Location:'/dashboard/settings?saved=1'}});
}
