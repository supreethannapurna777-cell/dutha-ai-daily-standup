import { managementPrincipalFromRequest } from './access-control';
import type { WorkerEnv } from './env';
import { decryptIntegrationSecret, encryptIntegrationSecret } from './integration-secrets';

export interface WhatsAppCredentials {
	accessToken: string;
	phoneNumberId: string;
}

type Stored = { phone_number_id: string; access_token_ciphertext: string; access_token_iv: string; connection_status: string; last_verified_at: string };
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const esc = (value: unknown) => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');

export async function whatsappCredentialsForTenant(env: WorkerEnv, tenantId?: number): Promise<WhatsAppCredentials | null> {
	if (!tenantId) return env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID ? { accessToken: env.WHATSAPP_ACCESS_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID } : null;
	const row = await env.DB.prepare('SELECT phone_number_id, access_token_ciphertext, access_token_iv, connection_status FROM organisation_whatsapp_connections WHERE tenant_id=?').bind(tenantId).first<Stored>();
	if (row && row.connection_status !== 'connected') return null;
	if (row?.connection_status === 'connected' && env.INTEGRATION_ENCRYPTION_KEY) {
		try {
			const accessToken = await decryptIntegrationSecret(row.access_token_ciphertext, row.access_token_iv, env.INTEGRATION_ENCRYPTION_KEY, tenantId, 0, 'whatsapp', 'access_token');
			return { accessToken, phoneNumberId: row.phone_number_id };
		} catch { return null; }
	}
	// Keep the existing pilot tenant working during migration. Other tenants
	// must configure their own sender; credentials are never shared across them.
	if (tenantId === 1 && env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) return { accessToken: env.WHATSAPP_ACCESS_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID };
	return null;
}

function authorized(request: Request, env: WorkerEnv): boolean {
	return Boolean(env.DASHBOARD_USERNAME && env.DASHBOARD_PASSWORD && request.headers.get('Authorization') === `Basic ${btoa(`${env.DASHBOARD_USERNAME}:${env.DASHBOARD_PASSWORD}`)}`);
}
function sameOrigin(request: Request): boolean {
	const origin = request.headers.get('Origin');
	return origin && origin !== 'null' ? origin === new URL(request.url).origin : request.headers.get('Sec-Fetch-Site') === 'same-origin';
}
function html(body: string, status = 200): Response {
	return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp connection · Dutha</title><style>:root{font-family:Inter,Arial,sans-serif;color:#dbeafe;background:#070b18}*{box-sizing:border-box}body{margin:0;padding:28px;background:radial-gradient(circle at 10% 0,#172554 0,transparent 36%),radial-gradient(circle at 92% 7%,#312e81 0,transparent 30%),#070b18}main{max-width:850px;margin:auto}.head{display:flex;justify-content:space-between;gap:16px;align-items:start}.card{background:#111827e8;border:1px solid #334155;border-radius:18px;padding:24px;margin:18px 0;box-shadow:0 18px 48px #0006}h1,h2{color:#f8fafc;margin-top:0}.eyebrow{font-size:11px;font-weight:900;letter-spacing:.12em;color:#93c5fd}.muted{color:#94a3b8;line-height:1.6}.notice,.error{padding:12px;border-radius:10px;margin:14px 0}.notice{background:#172554;color:#bfdbfe}.error{background:#450a0a;color:#fecaca}label{display:grid;gap:7px;margin:14px 0;font-weight:700}input{font:inherit;padding:11px;border:1px solid #475569;border-radius:9px;background:#0b1220;color:#f8fafc;width:100%}button,.button{border:0;border-radius:9px;padding:11px 15px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:white;font-weight:800;text-decoration:none;cursor:pointer}.secondary{background:#334155}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}.pill{display:inline-block;padding:6px 10px;border-radius:99px;background:#312e81;color:#ddd6fe;font-size:12px;font-weight:800}.connected{background:#1e3a8a;color:#bfdbfe}code{overflow-wrap:anywhere}@media(max-width:620px){body{padding:14px}.head{flex-direction:column}.card{padding:17px}}</style></head><body><main>${body}</main></body></html>`,{status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});
}

export async function whatsappConnectionResponse(request: Request, env: WorkerEnv, fetcher: Fetcher = fetch): Promise<Response> {
	if (!authorized(request, env)) return new Response('Authentication required.',{status:401,headers:{'WWW-Authenticate':'Basic realm="Dutha WorkOps"'}});
	const actor = managementPrincipalFromRequest(request) ?? {userId:1,tenantId:1,role:'admin' as const};
	if (!['admin','ceo'].includes(actor.role)) return new Response('CEO or Administrator access required.',{status:403});
	const url = new URL(request.url);
	let message = url.searchParams.has('saved') ? 'WhatsApp connection verified and saved. Outgoing messages for this company now use its own sender.' : '';
	let error = '';
	let existing = await env.DB.prepare('SELECT phone_number_id, connection_status, last_verified_at FROM organisation_whatsapp_connections WHERE tenant_id=?').bind(actor.tenantId).first<Pick<Stored,'phone_number_id'|'connection_status'|'last_verified_at'>>();
	if (request.method === 'POST') {
		if (!sameOrigin(request)) return new Response('Invalid request origin.',{status:403});
		const form = await request.formData();
		if (String(form.get('action') ?? '') === 'disconnect') {
			await env.DB.prepare("UPDATE organisation_whatsapp_connections SET connection_status='disconnected', access_token_ciphertext='', access_token_iv='', updated_at=CURRENT_TIMESTAMP WHERE tenant_id=?").bind(actor.tenantId).run();
			return new Response(null,{status:303,headers:{Location:'/dashboard/whatsapp?disconnected=1','Cache-Control':'no-store'}});
		}
		if (!env.INTEGRATION_ENCRYPTION_KEY) error = 'Integration encryption is not configured. Set the INTEGRATION_ENCRYPTION_KEY Worker secret first.';
		const phoneNumberId = String(form.get('phone_number_id') ?? '').trim();
		let accessToken = String(form.get('access_token') ?? '').trim();
		if (!error && (!/^\d{5,30}$/.test(phoneNumberId) || accessToken.length > 4096)) error = 'Enter a valid Meta Phone Number ID and access token.';
		if (!error && !accessToken && existing && env.INTEGRATION_ENCRYPTION_KEY) {
			const encrypted = await env.DB.prepare('SELECT access_token_ciphertext,access_token_iv FROM organisation_whatsapp_connections WHERE tenant_id=? AND connection_status=\'connected\'').bind(actor.tenantId).first<{access_token_ciphertext:string;access_token_iv:string}>();
			if (encrypted) try { accessToken = await decryptIntegrationSecret(encrypted.access_token_ciphertext,encrypted.access_token_iv,env.INTEGRATION_ENCRYPTION_KEY,actor.tenantId,0,'whatsapp','access_token'); } catch { error = 'Saved token could not be decrypted. Enter the access token again.'; }
		}
		if (!error && (!accessToken || accessToken.length < 20)) error = 'Enter a valid Meta access token.';
		let verifiedBusinessNumber = '';
		let verifiedBusinessName = '';
		if (!error) {
			try {
				const probe = await fetcher(`https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${encodeURIComponent(phoneNumberId)}?fields=id,display_phone_number,verified_name`,{headers:{Authorization:`Bearer ${accessToken}`,Accept:'application/json'}});
				const data = await probe.json() as {id?:unknown;display_phone_number?:unknown;verified_name?:unknown;error?:{message?:string}};
				if (!probe.ok || String(data.id ?? '') !== phoneNumberId) error = `Meta verification failed (HTTP ${probe.status}). Check the phone ID and token${data.error?.message ? `: ${data.error.message}` : '.'}`;
				else {
					verifiedBusinessNumber = String(data.display_phone_number ?? '').replaceAll(/\D/g,'');
					verifiedBusinessName = String(data.verified_name ?? '').slice(0,100);
				}
			} catch { error = 'Could not reach Meta over HTTPS. Check the Phone Number ID and try again.'; }
		}
		if (!error) {
			const claimed = await env.DB.prepare("SELECT tenant_id FROM organisation_whatsapp_connections WHERE phone_number_id=? AND connection_status='connected' AND tenant_id<>? LIMIT 1").bind(phoneNumberId,actor.tenantId).first<{tenant_id:number}>();
			if (claimed) error = 'This Meta phone number is already connected to another company workspace.';
		}
		if (!error && env.INTEGRATION_ENCRYPTION_KEY) {
			const encrypted = await encryptIntegrationSecret(accessToken,env.INTEGRATION_ENCRYPTION_KEY,actor.tenantId,0,'whatsapp','access_token');
			const verifiedAt = new Date().toISOString();
			await env.DB.batch([
				env.DB.prepare(`INSERT INTO organisation_whatsapp_connections (tenant_id,phone_number_id,access_token_ciphertext,access_token_iv,connection_status,last_verified_at,configured_by_management_user_id) VALUES (?,?,?,?,'connected',?,?) ON CONFLICT(tenant_id) DO UPDATE SET phone_number_id=excluded.phone_number_id,access_token_ciphertext=excluded.access_token_ciphertext,access_token_iv=excluded.access_token_iv,connection_status='connected',last_verified_at=excluded.last_verified_at,configured_by_management_user_id=excluded.configured_by_management_user_id,updated_at=CURRENT_TIMESTAMP`).bind(actor.tenantId,phoneNumberId,encrypted.ciphertext,encrypted.iv,verifiedAt,actor.userId),
				...(verifiedBusinessNumber ? [env.DB.prepare(`INSERT INTO organisation_connection_profiles (tenant_id,whatsapp_business_name,whatsapp_business_number) VALUES (?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET whatsapp_business_name=excluded.whatsapp_business_name,whatsapp_business_number=excluded.whatsapp_business_number,updated_at=CURRENT_TIMESTAMP`).bind(actor.tenantId,verifiedBusinessName || null,verifiedBusinessNumber)] : []),
			]);
			return new Response(null,{status:303,headers:{Location:'/dashboard/whatsapp?saved=1','Cache-Control':'no-store'}});
		}
		message = '';
	}
	if (url.searchParams.has('disconnected')) message = 'Company WhatsApp sender disconnected.';
	existing = await env.DB.prepare('SELECT phone_number_id, connection_status, last_verified_at FROM organisation_whatsapp_connections WHERE tenant_id=?').bind(actor.tenantId).first<Pick<Stored,'phone_number_id'|'connection_status'|'last_verified_at'>>();
	const notice = message ? `<p class="notice">${esc(message)}</p>` : '';
	const alert = error ? `<p class="error">${esc(error)}</p>` : '';
	const status = existing?.connection_status === 'connected' ? `<span class="pill connected">Connected · verified ${esc(existing.last_verified_at)}</span>` : '<span class="pill">Needs setup</span>';
	return html(`<header class="head"><div><div class="eyebrow">COMPANY WHATSAPP SENDER</div><h1>Connect WhatsApp Business</h1><p class="muted">Connect the company’s own Meta WhatsApp Cloud API sender. Credentials are verified before saving and encrypted in D1 using the Worker’s integration key.</p></div><a class="button secondary" href="/dashboard/settings">Connection hub</a></header>${notice}${alert}<section class="card"><div class="head"><div><h2>WhatsApp Cloud API</h2><p class="muted">${existing?.connection_status==='connected'?'Saved token is protected and will not be displayed. Re-enter a new token only when rotating it.':'Your company’s Meta Business account must grant this app access to its WhatsApp Business Account.'}</p></div>${status}</div><form method="post"><input type="hidden" name="action" value="save"><label>Phone Number ID<input name="phone_number_id" inputmode="numeric" pattern="[0-9]{5,30}" value="${esc(existing?.phone_number_id)}" required></label><label>Permanent access token<input name="access_token" type="password" autocomplete="new-password" maxlength="4096" placeholder="${existing?.connection_status==='connected'?'Leave blank to keep saved token':'Paste Meta system-user access token'}" ${existing?.connection_status==='connected'?'':'required'}></label><p class="muted">Find the Phone Number ID in Meta WhatsApp Manager → API Setup. Use a system-user token with WhatsApp messaging permissions. Do not paste the token into chat. The shared Meta app webhook and signature secret must also be configured in Cloudflare.</p><div class="actions"><button type="submit">Verify and save connection</button></div></form>${existing?.connection_status==='connected'?'<form method="post" class="actions"><input type="hidden" name="action" value="disconnect"><button class="secondary" type="submit">Disconnect company sender</button></form>':''}</section>`,error?400:200);
}
