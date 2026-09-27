import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env';
import { encryptIntegrationSecret } from '../src/integration-secrets';
import { sendTextMessage } from '../src/whatsapp';
import { whatsappConnectionResponse, whatsappCredentialsForTenant } from '../src/whatsapp-connection';

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const testEnv = { ...env, DASHBOARD_USERNAME:'admin', DASHBOARD_PASSWORD:'password', WHATSAPP_API_VERSION:'v26.0', INTEGRATION_ENCRYPTION_KEY:key } as WorkerEnv;
function request(method='GET', body?: FormData, role='admin') {
	return new Request('https://example.com/dashboard/whatsapp', { method, headers:{ Authorization:`Basic ${btoa('admin:password')}`, 'X-Dutha-User-Id':'1', 'X-Dutha-Tenant-Id':'1', 'X-Dutha-Tenant-Role':role, ...(method==='POST'?{Origin:'https://example.com'}:{}) }, body });
}

describe('company WhatsApp connection', () => {
	beforeEach(async () => {
		await env.DB.prepare('DELETE FROM organisation_whatsapp_connections').run();
		await env.DB.prepare("INSERT OR IGNORE INTO tenants (id,slug,name) VALUES (2,'test-company','Test Company')").run();
	});

	it('verifies the Meta phone ID and saves the token encrypted for that tenant', async () => {
		const form = new FormData(); form.set('phone_number_id','123456789012'); form.set('access_token','a-long-secret-meta-access-token');
		let called = '';
		const response = await whatsappConnectionResponse(request('POST',form),testEnv,async (input,init) => {
			called = String(input);
			expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer a-long-secret-meta-access-token');
			return Response.json({id:'123456789012',display_phone_number:'+91 99999 99999',verified_name:'Aurowise'});
		});
		expect(response.status).toBe(303);
		expect(called).toContain('/v26.0/123456789012?fields=id,display_phone_number,verified_name');
		const stored = await env.DB.prepare('SELECT phone_number_id,access_token_ciphertext,connection_status FROM organisation_whatsapp_connections WHERE tenant_id=1').first<{phone_number_id:string;access_token_ciphertext:string;connection_status:string}>();
		expect(stored?.phone_number_id).toBe('123456789012');
		expect(stored?.connection_status).toBe('connected');
		expect(stored?.access_token_ciphertext).not.toContain('a-long-secret-meta-access-token');
		expect(await whatsappCredentialsForTenant(testEnv,1)).toEqual({accessToken:'a-long-secret-meta-access-token',phoneNumberId:'123456789012'});
		expect(await env.DB.prepare('SELECT whatsapp_business_name,whatsapp_business_number FROM organisation_connection_profiles WHERE tenant_id=1').first()).toEqual({whatsapp_business_name:'Aurowise',whatsapp_business_number:'919999999999'});
	});

	it('does not use one tenant’s saved credentials for another tenant', async () => {
		const encrypted = await encryptIntegrationSecret('tenant-one-token',key,1,0,'whatsapp','access_token');
		await env.DB.prepare("INSERT INTO organisation_whatsapp_connections (tenant_id,phone_number_id,access_token_ciphertext,access_token_iv,connection_status,last_verified_at) VALUES (1,'123456789012',?,?,'connected',CURRENT_TIMESTAMP)").bind(encrypted.ciphertext,encrypted.iv).run();
		const otherEnv = { ...testEnv, WHATSAPP_ACCESS_TOKEN:'fallback-secret', WHATSAPP_PHONE_NUMBER_ID:'fallback-id' } as WorkerEnv;
		expect(await whatsappCredentialsForTenant(otherEnv,2)).toBeNull();
	});

	it('blocks a company from claiming another company’s connected phone number', async () => {
		const encrypted=await encryptIntegrationSecret('tenant-two-token',key,2,0,'whatsapp','access_token');
		await env.DB.prepare("INSERT INTO organisation_whatsapp_connections (tenant_id,phone_number_id,access_token_ciphertext,access_token_iv,connection_status,last_verified_at) VALUES (2,'222222222222',?,?,'connected',CURRENT_TIMESTAMP)").bind(encrypted.ciphertext,encrypted.iv).run();
		const form=new FormData(); form.set('phone_number_id','222222222222'); form.set('access_token','another-long-meta-access-token');
		const response=await whatsappConnectionResponse(request('POST',form),testEnv,async()=>Response.json({id:'222222222222',display_phone_number:'+91 99999 99999',verified_name:'Other company'}));
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('already connected to another company workspace');
		expect(await env.DB.prepare('SELECT tenant_id FROM organisation_whatsapp_connections WHERE tenant_id=1').first()).toBeNull();
	});

	it('sends outbound messages from that tenant’s connected Meta number', async () => {
		const encrypted = await encryptIntegrationSecret('company-two-token',key,2,0,'whatsapp','access_token');
		await env.DB.prepare("INSERT INTO organisation_whatsapp_connections (tenant_id,phone_number_id,access_token_ciphertext,access_token_iv,connection_status,last_verified_at) VALUES (2,'222222222222',?,?,'connected',CURRENT_TIMESTAMP)").bind(encrypted.ciphertext,encrypted.iv).run();
		let calledUrl = ''; let authorization = '';
		const result = await sendTextMessage(testEnv,'919876543210','pilot message',async (input,init) => {
			calledUrl=String(input); authorization=new Headers(init?.headers).get('Authorization') ?? '';
			return Response.json({messages:[{id:'wamid.company'}]});
		},2);
		expect(result).toEqual({success:true,messageId:'wamid.company'});
		expect(calledUrl).toContain('/222222222222/messages');
		expect(authorization).toBe('Bearer company-two-token');
	});

	it('requires CEO or administrator permissions and same-origin posts', async () => {
		expect((await whatsappConnectionResponse(request('GET',undefined,'project_manager'),testEnv)).status).toBe(403);
		const crossSite = request('POST',new FormData()); crossSite.headers.set('Origin','https://attacker.example');
		expect((await whatsappConnectionResponse(crossSite,testEnv)).status).toBe(403);
	});

	it('clears the saved token when disconnecting, including for the legacy pilot tenant', async () => {
		const encrypted = await encryptIntegrationSecret('tenant-one-token',key,1,0,'whatsapp','access_token');
		await env.DB.prepare("INSERT INTO organisation_whatsapp_connections (tenant_id,phone_number_id,access_token_ciphertext,access_token_iv,connection_status,last_verified_at) VALUES (1,'123456789012',?,?,'connected',CURRENT_TIMESTAMP)").bind(encrypted.ciphertext,encrypted.iv).run();
		const form = new FormData(); form.set('action','disconnect');
		const response = await whatsappConnectionResponse(request('POST',form),testEnv);
		expect(response.status).toBe(303);
		expect(await whatsappCredentialsForTenant(testEnv,1)).toBeNull();
		expect(await env.DB.prepare('SELECT access_token_ciphertext,connection_status FROM organisation_whatsapp_connections WHERE tenant_id=1').first()).toEqual({access_token_ciphertext:'',connection_status:'disconnected'});
	});
});
