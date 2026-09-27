import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env';
import { integrationHealthResponse } from '../src/integration-health';

const healthEnv={...env,DASHBOARD_USERNAME:'admin',DASHBOARD_PASSWORD:'password'} as WorkerEnv;
function request(role='ceo',method='GET') {
	return new Request('https://example.com/dashboard/integrations/health',{method,headers:{Authorization:`Basic ${btoa('admin:password')}`,'X-Dutha-User-Id':'1','X-Dutha-Tenant-Id':'1','X-Dutha-Tenant-Role':role}});
}

describe('organisation integration health',()=>{
	it('shows tenant-scoped connection, queue, project and recovery summaries',async()=>{
		const response=await integrationHealthResponse(request(),healthEnv);
		const body=await response.text();
		expect(response.status).toBe(200);
		expect(body).toContain('Integration health');
		expect(body).toContain('Business messaging');
		expect(body).toContain('Company email');
		expect(body).toContain('Project connections');
		expect(body).toContain('Pending or sending');
		expect(body).toContain('Failed deliveries to review');
		expect(body).not.toContain('api_token_ciphertext');
		expect(body).not.toContain('access_token_ciphertext');
	});

	it('limits the page to CEO and administrator roles',async()=>{
		expect((await integrationHealthResponse(request('project_manager'),healthEnv)).status).toBe(403);
	});

	it('serves only read requests',async()=>{
		expect((await integrationHealthResponse(request('ceo','POST'),healthEnv)).status).toBe(405);
	});
});
