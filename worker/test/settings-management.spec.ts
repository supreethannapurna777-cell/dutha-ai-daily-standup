import { env } from 'cloudflare:test';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEnv } from '../src/env';
import { settingsManagementResponse } from '../src/settings-management';

const settingsEnv = { ...env, DASHBOARD_USERNAME:'admin', DASHBOARD_PASSWORD:'password' } as WorkerEnv;

function request(method = 'GET', body?: string): Request {
	return new Request('https://example.com/dashboard/settings', { method, headers:{ Authorization:`Basic ${btoa('admin:password')}`, 'X-Dutha-User-Id':'1', 'X-Dutha-Tenant-Id':'1', 'X-Dutha-Tenant-Role':'admin', ...(method === 'POST' ? { Origin:'https://example.com', 'Content-Type':'application/x-www-form-urlencoded' } : {}) }, body });
}

describe('organisation email settings', () => {
	beforeEach(async () => env.DB.prepare(`DELETE FROM organisation_email_settings WHERE tenant_id=1`).run());
	afterEach(() => vi.unstubAllGlobals());

	it('saves editable sender identity without storing an API key', async () => {
		const response = await settingsManagementResponse(request('POST', new URLSearchParams({ action:'save', company_name:'Aurowise', sender_name:'Dutha WorkOps', from_email:'dutha@example.com', reply_to_email:'ops@example.com' }).toString()), settingsEnv);
		expect(response.status).toBe(303);
		const row = await env.DB.prepare(`SELECT company_name, sender_name, from_email, reply_to_email FROM organisation_email_settings WHERE tenant_id=1`).first();
		expect(row).toEqual({ company_name:'Aurowise', sender_name:'Dutha WorkOps', from_email:'dutha@example.com', reply_to_email:'ops@example.com' });
		expect(JSON.stringify(row)).not.toContain('API');
	});

	it('rejects project managers from organisation settings', async () => {
		const denied = request();
		denied.headers.set('X-Dutha-Tenant-Role', 'project_manager');
		expect((await settingsManagementResponse(denied, settingsEnv)).status).toBe(403);
	});

	it('allows a CEO to save company WhatsApp identity without provider credentials', async () => {
		const ceo = request('POST', new URLSearchParams({ action:'save_identity', company_name:'Aurowise', sender_name:'Dutha WorkOps', from_email:'dutha@example.com', reply_to_email:'ops@example.com', whatsapp_business_name:'Aurowise', whatsapp_business_number:'919876543210' }).toString());
		ceo.headers.set('X-Dutha-Tenant-Role', 'ceo');
		const response = await settingsManagementResponse(ceo, settingsEnv);
		expect(response.status).toBe(303);
		expect(await env.DB.prepare('SELECT whatsapp_business_name, whatsapp_business_number FROM organisation_connection_profiles WHERE tenant_id=1').first()).toEqual({ whatsapp_business_name:'Aurowise', whatsapp_business_number:'919876543210' });
	});

	it('verifies and encrypts each company Resend key before saving it', async () => {
		const key=btoa('0123456789abcdef0123456789abcdef');
		const fetcher=vi.fn(async ()=>new Response(JSON.stringify({data:[{name:'aurowise.example',status:'verified'}]}),{status:200}));
		vi.stubGlobal('fetch',fetcher);
		const requestEnv={...settingsEnv,INTEGRATION_ENCRYPTION_KEY:key} as WorkerEnv;
		const body=new URLSearchParams({action:'save_identity',company_name:'Aurowise',sender_name:'Aurowise WorkOps',from_email:'ops@aurowise.example',reply_to_email:'help@aurowise.example',resend_api_key:'re_company_secret'}).toString();
		const response=await settingsManagementResponse(request('POST',body),requestEnv);
		expect(response.status).toBe(303);
		const row=await env.DB.prepare('SELECT resend_api_key_ciphertext,resend_api_key_iv,email_connection_status,email_last_verified_at FROM organisation_email_settings WHERE tenant_id=1').first<{resend_api_key_ciphertext:string;resend_api_key_iv:string;email_connection_status:string;email_last_verified_at:string}>();
		expect(row?.email_connection_status).toBe('connected');
		expect(row?.resend_api_key_ciphertext).not.toBe('re_company_secret');
		expect(row?.resend_api_key_iv).toBeTruthy();
		expect(row?.email_last_verified_at).toBeTruthy();
		expect(fetcher).toHaveBeenCalledWith('https://api.resend.com/domains',{headers:{Authorization:'Bearer re_company_secret'}});
	});

	it('does not save an email key when the sender domain is not verified', async () => {
		vi.stubGlobal('fetch',vi.fn(async ()=>new Response(JSON.stringify({data:[]}),{status:200})));
		const key=btoa('0123456789abcdef0123456789abcdef');
		const body=new URLSearchParams({action:'save_identity',company_name:'Aurowise',sender_name:'Aurowise WorkOps',from_email:'ops@aurowise.example',reply_to_email:'help@aurowise.example',resend_api_key:'re_company_secret'}).toString();
		const response=await settingsManagementResponse(request('POST',body),{...settingsEnv,INTEGRATION_ENCRYPTION_KEY:key} as WorkerEnv);
		expect(response.status).toBe(400);
		expect(await env.DB.prepare('SELECT tenant_id FROM organisation_email_settings WHERE tenant_id=1').first()).toBeNull();
	});
});
