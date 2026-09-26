import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env';
import { settingsManagementResponse } from '../src/settings-management';

const settingsEnv = { ...env, DASHBOARD_USERNAME:'admin', DASHBOARD_PASSWORD:'password' } as WorkerEnv;

function request(method = 'GET', body?: string): Request {
	return new Request('https://example.com/dashboard/settings', { method, headers:{ Authorization:`Basic ${btoa('admin:password')}`, 'X-Dutha-User-Id':'1', 'X-Dutha-Tenant-Id':'1', 'X-Dutha-Tenant-Role':'admin', ...(method === 'POST' ? { Origin:'https://example.com', 'Content-Type':'application/x-www-form-urlencoded' } : {}) }, body });
}

describe('organisation email settings', () => {
	beforeEach(async () => env.DB.prepare(`DELETE FROM organisation_email_settings WHERE tenant_id=1`).run());

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
});
