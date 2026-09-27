import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEnv } from '../src/env';
import { sendManagerActivationEmail } from '../src/email';
import { encryptIntegrationSecret } from '../src/integration-secrets';

describe('transactional manager email', () => {
	beforeEach(async () => {
		await env.DB.prepare(`DELETE FROM organisation_email_settings WHERE tenant_id=1`).run();
		await env.DB.prepare(`INSERT INTO organisation_email_settings (tenant_id, company_name, sender_name, from_email, reply_to_email) VALUES (1, 'Aurowise', 'Dutha WorkOps', 'dutha@example.com', 'ops@example.com')`).run();
	});

	it('sends a branded activation email through Resend without exposing the API key', async () => {
		const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			expect(init?.headers).toEqual(expect.objectContaining({ Authorization:'Bearer secret-resend-key' }));
			const payload = JSON.parse(String(init?.body));
			expect(payload.from).toBe('Dutha WorkOps <dutha@example.com>');
			expect(payload.to).toEqual(['manager@example.com']);
			expect(payload.html).toContain('https://example.com/manager/activate?token=private');
			expect(payload.html).not.toContain('secret-resend-key');
			return new Response(JSON.stringify({ id:'email-1' }), { status:200 });
		});
		const result = await sendManagerActivationEmail({ ...env, RESEND_API_KEY:'secret-resend-key' } as WorkerEnv, 1, 'manager@example.com', 'Manager', 'https://example.com/manager/activate?token=private', fetcher as typeof fetch);
		expect(result).toEqual({ sent:true });
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it('uses the encrypted company Resend key ahead of the legacy shared key', async () => {
		const masterKey=btoa('0123456789abcdef0123456789abcdef');
		const encrypted=await encryptIntegrationSecret('company-resend-key',masterKey,1,0,'resend','api_key');
		await env.DB.prepare("UPDATE organisation_email_settings SET resend_api_key_ciphertext=?,resend_api_key_iv=?,email_connection_status='connected' WHERE tenant_id=1").bind(encrypted.ciphertext,encrypted.iv).run();
		const fetcher=vi.fn(async (_input:RequestInfo|URL,init?:RequestInit)=>{
			expect(init?.headers).toEqual(expect.objectContaining({Authorization:'Bearer company-resend-key'}));
			return new Response(JSON.stringify({id:'email-company'}),{status:200});
		});
		const result=await sendManagerActivationEmail({...env,RESEND_API_KEY:'legacy-platform-key',INTEGRATION_ENCRYPTION_KEY:masterKey} as WorkerEnv,1,'manager@example.com','Manager','https://example.com/activate',fetcher as typeof fetch);
		expect(result).toEqual({sent:true});
	});

	it('does not fall back to a shared key after a company disconnects', async () => {
		await env.DB.prepare("UPDATE organisation_email_settings SET email_connection_status='disconnected',resend_api_key_ciphertext=NULL,resend_api_key_iv=NULL WHERE tenant_id=1").run();
		const fetcher=vi.fn();
		const result=await sendManagerActivationEmail({...env,RESEND_API_KEY:'legacy-platform-key'} as WorkerEnv,1,'manager@example.com','Manager','https://example.com/activate',fetcher as typeof fetch);
		expect(result.sent).toBe(false);
		expect(fetcher).not.toHaveBeenCalled();
	});
});
