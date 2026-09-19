import type { WorkerEnv } from './env';

export interface OrganisationEmailSettings {
	company_name: string;
	sender_name: string;
	from_email: string;
	reply_to_email: string | null;
}

export async function emailSettings(db: D1Database, tenantId: number): Promise<OrganisationEmailSettings | null> {
	return db.prepare(`SELECT company_name, sender_name, from_email, reply_to_email FROM organisation_email_settings WHERE tenant_id=? LIMIT 1`).bind(tenantId).first<OrganisationEmailSettings>();
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
	if (!env.RESEND_API_KEY || !settings) return { sent: false, reason: 'Email delivery is not configured.' };
	const response = await fetcher('https://api.resend.com/emails', {
		method: 'POST',
		headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
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
