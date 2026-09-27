import type { WorkerEnv } from './env';
import { decryptIntegrationSecret } from './integration-secrets';

export interface OrganisationEmailSettings {
	company_name: string;
	sender_name: string;
	from_email: string;
	reply_to_email: string | null;
}

export async function emailSettings(db: D1Database, tenantId: number): Promise<OrganisationEmailSettings | null> {
	return db.prepare(`SELECT company_name, sender_name, from_email, reply_to_email FROM organisation_email_settings WHERE tenant_id=? LIMIT 1`).bind(tenantId).first<OrganisationEmailSettings>();
}

async function resendApiKey(env: WorkerEnv, tenantId: number): Promise<string | null> {
	const connection = await env.DB.prepare(`SELECT resend_api_key_ciphertext,resend_api_key_iv,email_connection_status FROM organisation_email_settings WHERE tenant_id=? LIMIT 1`).bind(tenantId).first<{resend_api_key_ciphertext:string|null;resend_api_key_iv:string|null;email_connection_status:string}>();
	if (connection?.email_connection_status === 'disconnected' || (connection?.resend_api_key_ciphertext && connection.email_connection_status !== 'connected')) return null;
	if (connection?.resend_api_key_ciphertext && connection.resend_api_key_iv && env.INTEGRATION_ENCRYPTION_KEY) {
		return decryptIntegrationSecret(connection.resend_api_key_ciphertext, connection.resend_api_key_iv, env.INTEGRATION_ENCRYPTION_KEY, tenantId, 0, 'resend', 'api_key');
	}
	// Keep the existing shared sender working for the original workspace only.
	return tenantId === 1 ? env.RESEND_API_KEY?.trim() || null : null;
}

export async function verifyResendConnection(apiKey:string, fromEmail:string, fetcher:typeof fetch=fetch):Promise<{ok:boolean;reason?:string}> {
	const response=await fetcher('https://api.resend.com/domains',{headers:{Authorization:`Bearer ${apiKey}`}});
	if (response.status===401 || response.status===403) return {ok:false,reason:'Resend rejected this API key. Check the key and try again.'};
	if (!response.ok) return {ok:false,reason:`Resend verification returned ${response.status}.`};
	let payload:{data?:Array<{name?:string;status?:string}>};
	try { payload=await response.json() as {data?:Array<{name?:string;status?:string}>}; } catch { return {ok:false,reason:'Resend returned an unreadable domains response.'}; }
	const domain=fromEmail.split('@')[1]?.toLowerCase();
	const verified=(payload.data??[]).some(item=>item.name?.toLowerCase()===domain && item.status?.toLowerCase()==='verified');
	return verified ? {ok:true} : {ok:false,reason:`Verify the ${domain||'sender'} domain in Resend before connecting this address.`};
}

export async function sendTestEmail(env:WorkerEnv,tenantId:number,to:string,fetcher:typeof fetch=fetch):Promise<{sent:boolean;reason?:string}> {
	const [settings,apiKey]=await Promise.all([emailSettings(env.DB,tenantId),resendApiKey(env,tenantId)]);
	if (!settings || !apiKey) return {sent:false,reason:'Connect a verified company email sender first.'};
	const response=await fetcher('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({from:`${settings.sender_name} <${settings.from_email}>`,to:[to],reply_to:settings.reply_to_email||undefined,subject:`${settings.company_name} email connection test`,html:`<div style="font-family:Arial,sans-serif"><h2>Email connection verified</h2><p>Dutha WorkOps successfully sent this test for ${escapeHtml(settings.company_name)}.</p><p>Replies will go to ${escapeHtml(settings.reply_to_email||settings.from_email)}.</p></div>`})});
	if (!response.ok) return {sent:false,reason:`Resend could not send the test message (${response.status}).`};
	return {sent:true};
}

function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

export async function sendManagerActivationEmail(
	env: WorkerEnv,
	tenantId: number,
	to: string,
	managerName: string,
	activationUrl: string,
	fetcher: typeof fetch = fetch,
): Promise<{ sent: boolean; reason?: string }> {
	const settings = await emailSettings(env.DB, tenantId);
	const apiKey=await resendApiKey(env,tenantId);
	if (!apiKey || !settings) return { sent: false, reason: 'Email delivery is not configured.' };
	const response = await fetcher('https://api.resend.com/emails', {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			from: `${settings.sender_name} <${settings.from_email}>`,
			to: [to],
			reply_to: settings.reply_to_email || undefined,
			subject: `Activate your ${settings.company_name} Dutha manager account`,
			html: `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#172033"><h1 style="color:#173f6b">Welcome to Dutha WorkOps</h1><p>Hello ${escapeHtml(managerName)},</p><p>Your manager account for <strong>${escapeHtml(settings.company_name)}</strong> is ready.</p><p><a href="${escapeHtml(activationUrl)}" style="display:inline-block;background:#1769aa;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700">Activate manager account</a></p><p>This secure link expires in 24 hours and can be used once.</p><p>If you did not expect this invitation, you can ignore this email.</p></div>`,
		}),
	});
	if (!response.ok) return { sent: false, reason: `Email provider returned ${response.status}.` };
	return { sent: true };
}

export async function sendEmployeeActivationEmail(
	env: WorkerEnv,
	tenantId: number,
	to: string,
	name: string,
	activationUrl: string,
	fetcher: typeof fetch = fetch,
): Promise<{ sent: boolean; reason?: string }> {
	const settings = await emailSettings(env.DB, tenantId);
	const apiKey=await resendApiKey(env,tenantId);
	if (!apiKey || !settings) return { sent: false, reason: 'Email delivery is not configured.' };
	const response = await fetcher('https://api.resend.com/emails', {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			from: `${settings.sender_name} <${settings.from_email}>`,
			to: [to],
			reply_to: settings.reply_to_email || undefined,
			subject: `Reset your ${settings.company_name} Dutha employee account`,
			html: `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#172033"><h1 style="color:#173f6b">Dutha WorkOps</h1><p>Hello ${escapeHtml(name)},</p><p>Use this secure link to create or reset your employee password.</p><p><a href="${escapeHtml(activationUrl)}">Continue securely</a></p><p>This one-time link expires after 24 hours.</p></div>`,
		}),
	});
	if (!response.ok) return { sent: false, reason: `Email provider returned ${response.status}.` };
	return { sent: true };
}
