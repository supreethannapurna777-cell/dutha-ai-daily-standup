import { managementPrincipalFromRequest, type TenantRole } from './access-control';
import { emailSettings, sendTestEmail, verifyResendConnection } from './email';
import type { WorkerEnv } from './env';
import { encryptIntegrationSecret } from './integration-secrets';

type Connection = { email_connection_status: string; email_last_verified_at: string | null };
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const esc=(value:unknown)=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');

function authorized(request:Request,env:WorkerEnv):boolean {
	return Boolean(env.DASHBOARD_USERNAME&&env.DASHBOARD_PASSWORD&&request.headers.get('Authorization')===`Basic ${btoa(`${env.DASHBOARD_USERNAME}:${env.DASHBOARD_PASSWORD}`)}`);
}
function sameOrigin(request:Request):boolean {
	const origin=request.headers.get('Origin');
	return origin&&origin!=='null'?origin===new URL(request.url).origin:request.headers.get('Sec-Fetch-Site')==='same-origin';
}
function html(body:string,status=200):Response {
	return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email sender setup · Dutha</title><style>:root{font-family:Inter,Arial,sans-serif;color:#dbeafe;background:#070b18}*{box-sizing:border-box}body{margin:0;padding:28px;min-height:100vh;background:radial-gradient(circle at 12% 0,#172554 0,transparent 38%),radial-gradient(circle at 92% 8%,#312e81 0,transparent 34%),#070b18}main{max-width:850px;margin:auto}.head{display:flex;justify-content:space-between;gap:18px;margin-bottom:22px}h1,h2{color:#f8fafc;margin:0 0 7px}.muted,p{color:#94a3b8;line-height:1.55}.eyebrow{font-size:11px;font-weight:900;letter-spacing:.12em;color:#60a5fa}.button,button{border:0;border-radius:10px;padding:11px 15px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;text-decoration:none;font-weight:800;cursor:pointer}.secondary{background:#334155}.card{background:#111827e8;border:1px solid #334155;border-radius:18px;padding:24px;margin:18px 0;box-shadow:0 18px 50px #0005}.state{padding:12px;border-radius:10px;background:#0b1220;color:#bfdbfe}.state.connected{background:#172554}.notice,.error{padding:12px;border-radius:10px;margin:14px 0}.notice{background:#0c4a6e}.error{background:#450a0a;color:#fecaca}label{display:grid;gap:7px;font-weight:700;margin:14px 0;color:#cbd5e1}input{padding:11px;border:1px solid #475569;border-radius:10px;background:#0b1220;color:#f8fafc;font:inherit;width:100%}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}.muted.small{font-size:13px}@media(max-width:650px){body{padding:15px}.head{flex-direction:column}.card{padding:18px}}</style></head><body><main>${body}</main></body></html>`,{status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});
}

async function render(env:WorkerEnv,tenantId:number,role:TenantRole,message='',error=''):Promise<Response> {
	const [settings,connection]=await Promise.all([
		emailSettings(env.DB,tenantId),
		env.DB.prepare('SELECT email_connection_status,email_last_verified_at FROM organisation_email_settings WHERE tenant_id=?').bind(tenantId).first<Connection>(),
	]);
	const connected=connection?.email_connection_status==='connected';
	const status=connected?`Connected · verified ${esc(connection?.email_last_verified_at)}`:connection?.email_connection_status==='disconnected'?'Disconnected':settings?.from_email?'Identity saved · provider setup needed':'Needs setup';
	const banner=message?`<div class="notice">${esc(message)}</div>`:'';
	const alert=error?`<div class="error">${esc(error)}</div>`:'';
	const setup=settings?`<form method="post"><input type="hidden" name="action" value="connect"><label>Company Resend API key<input name="resend_api_key" type="password" autocomplete="new-password" maxlength="500" placeholder="${connected?'Enter a new key only to rotate the saved key':'Paste the company Resend API key'}" ${connected?'':'required'}></label><p class="muted small">Sender: <strong>${esc(settings.sender_name)} &lt;${esc(settings.from_email)}&gt;</strong><br>Replies go to: <strong>${esc(settings.reply_to_email||settings.from_email)}</strong></p><p class="muted small">The sender’s domain must be verified in this company’s Resend account. Dutha tests the key and domain before saving it encrypted. Do not paste the key into chat.</p><div class="actions"><button type="submit">Verify and connect email</button></div></form><form method="post" class="actions"><input type="hidden" name="action" value="test"><button class="secondary" type="submit">Send test email</button></form>${connected?`<form method="post" class="actions"><input type="hidden" name="action" value="disconnect"><button class="secondary" type="submit">Disconnect sender</button></form>`:''}`:`<p class="muted">Add the company name, sender name, verified sender email, and reply-to email in Company connections first.</p><a class="button" href="/dashboard/settings">Open company identity</a>`;
	const body=`<header class="head"><div><div class="eyebrow">COMPANY EMAIL SENDER</div><h1>Email delivery setup</h1><p class="muted">Connect the company’s Resend account for secure outgoing Dutha emails.</p></div><a class="button secondary" href="/dashboard/settings">Connection hub</a></header>${banner}${alert}<section class="card"><div class="eyebrow">${role==='ceo'?'CHIEF EXECUTIVE CONTROL':'ORGANISATION CONTROL'}</div><h2>Resend connection</h2><p class="state ${connected?'connected':''}">${status}</p>${setup}</section>`;
	return html(body,error?400:200);
}

export async function emailConnectionManagementResponse(request:Request,env:WorkerEnv,fetcher:Fetcher=fetch):Promise<Response> {
	if(!authorized(request,env)) return new Response('Authentication required.',{status:401});
	const actor=managementPrincipalFromRequest(request)??{userId:1,tenantId:1,role:'admin' as const};
	if(!['admin','ceo'].includes(actor.role)) return new Response('CEO or Administrator access required.',{status:403});
	const url=new URL(request.url);
	if(request.method==='GET') {
		const message=url.searchParams.has('connected')?'Company email sender connected.':url.searchParams.has('tested')?'Test email sent.':url.searchParams.has('disconnected')?'Company email sender disconnected.':'';
		return render(env,actor.tenantId,actor.role,message);
	}
	if(request.method!=='POST') return new Response('Method not allowed.',{status:405});
	if(!sameOrigin(request)) return new Response('Invalid request origin.',{status:403});
	const form=await request.formData();
	const action=String(form.get('action')??'');
	if(action==='disconnect') {
		await env.DB.prepare("UPDATE organisation_email_settings SET resend_api_key_ciphertext=NULL,resend_api_key_iv=NULL,email_connection_status='disconnected',email_last_verified_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=?").bind(actor.tenantId).run();
		return new Response(null,{status:303,headers:{Location:'/dashboard/email?disconnected=1','Cache-Control':'no-store'}});
	}
	const settings=await emailSettings(env.DB,actor.tenantId);
	if(action==='test') {
		const recipient=settings?.reply_to_email||settings?.from_email;
		if(!recipient) return render(env,actor.tenantId,actor.role,'','Save a valid sender email before testing delivery.');
		const result=await sendTestEmail(env,actor.tenantId,recipient,fetcher);
		return render(env,actor.tenantId,actor.role,result.sent?'Test email sent.':'',result.sent?'':result.reason??'Email test failed.');
	}
	if(action!=='connect') return new Response('Invalid email setup action.',{status:400});
	if(!settings?.from_email) return render(env,actor.tenantId,actor.role,'','Save the company sender identity in the Connection Hub first.');
	const apiKey=String(form.get('resend_api_key')??'').trim();
	if(!apiKey) {
		const status=await env.DB.prepare("SELECT email_connection_status FROM organisation_email_settings WHERE tenant_id=?").bind(actor.tenantId).first<{email_connection_status:string}>();
		if(status?.email_connection_status==='connected') return render(env,actor.tenantId,actor.role,'','This sender is already connected. Enter a new API key only if you need to rotate it.');
		return render(env,actor.tenantId,actor.role,'','Enter the company Resend API key.');
	}
	if(apiKey.length>500||!env.INTEGRATION_ENCRYPTION_KEY) return render(env,actor.tenantId,actor.role,'','Email connection needs a valid integration encryption key.');
	try {
		const verification=await verifyResendConnection(apiKey,settings.from_email,fetcher);
		if(!verification.ok) return render(env,actor.tenantId,actor.role,'',verification.reason??'Could not verify the Resend connection.');
		const encrypted=await encryptIntegrationSecret(apiKey,env.INTEGRATION_ENCRYPTION_KEY,actor.tenantId,0,'resend','api_key');
		await env.DB.prepare("UPDATE organisation_email_settings SET resend_api_key_ciphertext=?,resend_api_key_iv=?,email_connection_status='connected',email_last_verified_at=?,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=?").bind(encrypted.ciphertext,encrypted.iv,new Date().toISOString(),actor.tenantId).run();
		return new Response(null,{status:303,headers:{Location:'/dashboard/email?connected=1','Cache-Control':'no-store'}});
	} catch {
		return render(env,actor.tenantId,actor.role,'','Could not verify or securely save this email connection. Check the API key and try again.');
	}
}
