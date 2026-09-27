import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env';
import { encryptIntegrationSecret } from '../src/integration-secrets';
import { emailConnectionManagementResponse } from '../src/email-connection-management';

const key=btoa('0123456789abcdef0123456789abcdef');
const testEnv={...env,DASHBOARD_USERNAME:'admin',DASHBOARD_PASSWORD:'password',INTEGRATION_ENCRYPTION_KEY:key} as WorkerEnv;
function request(method='GET',body?:FormData,role='admin') {
	return new Request('https://example.com/dashboard/email',{method,headers:{Authorization:`Basic ${btoa('admin:password')}`,'X-Dutha-User-Id':'1','X-Dutha-Tenant-Id':'1','X-Dutha-Tenant-Role':role,...(method==='POST'?{Origin:'https://example.com'}:{})},body});
}
async function addIdentity() {
	await env.DB.prepare("INSERT INTO organisation_email_settings (tenant_id,company_name,sender_name,from_email,reply_to_email) VALUES (1,'Aurowise','Aurowise WorkOps','ops@aurowise.example','help@aurowise.example')").run();
}

describe('company email setup page',()=>{
	beforeEach(async()=>env.DB.prepare('DELETE FROM organisation_email_settings WHERE tenant_id=1').run());

	it('shows company sender details and setup actions without exposing a saved key',async()=>{
		await addIdentity();
		const encrypted=await encryptIntegrationSecret('private-resend-key',key,1,0,'resend','api_key');
		await env.DB.prepare("UPDATE organisation_email_settings SET resend_api_key_ciphertext=?,resend_api_key_iv=?,email_connection_status='connected',email_last_verified_at='2026-09-27T00:00:00.000Z' WHERE tenant_id=1").bind(encrypted.ciphertext,encrypted.iv).run();
		const response=await emailConnectionManagementResponse(request(),testEnv);
		const page=await response.text();
		expect(response.status).toBe(200);
		expect(page).toContain('Email delivery setup');
		expect(page).toContain('ops@aurowise.example');
		expect(page).toContain('Send test email');
		expect(page).not.toContain('private-resend-key');
	});

	it('verifies and encrypts the company key on the dedicated setup page',async()=>{
		await addIdentity();
		const form=new FormData(); form.set('action','connect'); form.set('resend_api_key','re_aurowise_secret');
		const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{
			expect(String(input)).toBe('https://api.resend.com/domains');
			expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer re_aurowise_secret');
			return Response.json({data:[{name:'aurowise.example',status:'verified'}]});
		};
		const response=await emailConnectionManagementResponse(request('POST',form),testEnv,fetcher);
		expect(response.status).toBe(303);
		expect(response.headers.get('Location')).toBe('/dashboard/email?connected=1');
		const saved=await env.DB.prepare('SELECT resend_api_key_ciphertext,resend_api_key_iv,email_connection_status,email_last_verified_at FROM organisation_email_settings WHERE tenant_id=1').first<{resend_api_key_ciphertext:string;resend_api_key_iv:string;email_connection_status:string;email_last_verified_at:string}>();
		expect(saved?.email_connection_status).toBe('connected');
		expect(saved?.resend_api_key_ciphertext).not.toBe('re_aurowise_secret');
		expect(saved?.resend_api_key_iv).toBeTruthy();
		expect(saved?.email_last_verified_at).toBeTruthy();
	});

	it('rejects unverified sender domains without changing the saved identity',async()=>{
		await addIdentity();
		const form=new FormData(); form.set('action','connect'); form.set('resend_api_key','re_aurowise_secret');
		const response=await emailConnectionManagementResponse(request('POST',form),testEnv,async()=>Response.json({data:[]}));
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Verify the aurowise.example domain');
		const saved=await env.DB.prepare('SELECT email_connection_status,resend_api_key_ciphertext FROM organisation_email_settings WHERE tenant_id=1').first();
		expect(saved).toEqual({email_connection_status:'pending',resend_api_key_ciphertext:null});
	});

	it('uses the encrypted company key for the dedicated test-email action',async()=>{
		await addIdentity();
		const encrypted=await encryptIntegrationSecret('private-resend-key',key,1,0,'resend','api_key');
		await env.DB.prepare("UPDATE organisation_email_settings SET resend_api_key_ciphertext=?,resend_api_key_iv=?,email_connection_status='connected' WHERE tenant_id=1").bind(encrypted.ciphertext,encrypted.iv).run();
		const form=new FormData(); form.set('action','test');
		const fetcher=async(_input:RequestInfo|URL,init?:RequestInit)=>{
			expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-resend-key');
			const body=JSON.parse(String(init?.body)) as {to:string[];subject:string};
			expect(body.to).toEqual(['help@aurowise.example']);
			expect(body.subject).toContain('connection test');
			return Response.json({id:'test-email'});
		};
		const response=await emailConnectionManagementResponse(request('POST',form),testEnv,fetcher);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('Test email sent.');
	});

	it('disconnects the saved company sender',async()=>{
		await addIdentity();
		const encrypted=await encryptIntegrationSecret('private-resend-key',key,1,0,'resend','api_key');
		await env.DB.prepare("UPDATE organisation_email_settings SET resend_api_key_ciphertext=?,resend_api_key_iv=?,email_connection_status='connected' WHERE tenant_id=1").bind(encrypted.ciphertext,encrypted.iv).run();
		const form=new FormData(); form.set('action','disconnect');
		const response=await emailConnectionManagementResponse(request('POST',form),testEnv);
		expect(response.status).toBe(303);
		expect(response.headers.get('Location')).toBe('/dashboard/email?disconnected=1');
		expect(await env.DB.prepare('SELECT resend_api_key_ciphertext,resend_api_key_iv,email_connection_status FROM organisation_email_settings WHERE tenant_id=1').first()).toEqual({resend_api_key_ciphertext:null,resend_api_key_iv:null,email_connection_status:'disconnected'});
	});

	it('requires CEO/admin and same-origin requests',async()=>{
		expect((await emailConnectionManagementResponse(request('GET',undefined,'project_manager'),testEnv)).status).toBe(403);
		const crossSite=request('POST',new FormData()); crossSite.headers.set('Origin','https://attacker.example');
		expect((await emailConnectionManagementResponse(crossSite,testEnv)).status).toBe(403);
	});
});
