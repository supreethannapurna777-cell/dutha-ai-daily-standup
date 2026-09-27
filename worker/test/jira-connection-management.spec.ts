import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env';
import { jiraConnectionManagementResponse } from '../src/jira-connection-management';
import { jiraConfigForProject } from '../src/jira-sync';

const key=btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const testEnv={...env,DASHBOARD_USERNAME:'admin',DASHBOARD_PASSWORD:'test-password',INTEGRATION_ENCRYPTION_KEY:key} as WorkerEnv;
const authorization=`Basic ${btoa('admin:test-password')}`;
let requestNumber=0;
function formRequest(data:Record<string,string>) {
	return new Request('https://example.com/dashboard/jira?project=1',{method:'POST',headers:{Authorization:authorization,Origin:'https://example.com','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data)});
}
const mockFetch=async (input:RequestInfo|URL):Promise<Response>=>{
	requestNumber++;
	const url=String(input);
	if(url.endsWith('/rest/api/3/myself')) return Response.json({accountId:'test-account'});
	if(url.endsWith('/rest/api/3/project/AURO')) return Response.json({key:'AURO'});
	return new Response('Not found',{status:404});
};

describe('project Jira connection setup',()=>{
	beforeEach(async()=>{
		await env.DB.prepare('DELETE FROM project_jira_connections WHERE tenant_id=1 AND project_id=1').run();
		requestNumber=0;
	});

	it('tests Jira before saving and encrypts the token at rest',async()=>{
		const response=await jiraConnectionManagementResponse(formRequest({project_id:'1',base_url:'https://example.atlassian.net',account_email:'ops@example.com',project_key:'AURO',issue_type:'Task',api_token:'private-jira-token-123'}),testEnv,mockFetch);
		expect(response.status).toBe(303);
		expect(response.headers.get('Location')).toContain('saved=1');
		expect(requestNumber).toBe(2);
		const stored=await env.DB.prepare('SELECT account_email,api_token_ciphertext,project_key FROM project_jira_connections WHERE tenant_id=1 AND project_id=1').first<{account_email:string;api_token_ciphertext:string;project_key:string}>();
		expect(stored?.account_email).toBe('ops@example.com');
		expect(stored?.api_token_ciphertext).not.toContain('private-jira-token-123');
		expect(await jiraConfigForProject(env.DB,testEnv,1,1)).toEqual({baseUrl:'https://example.atlassian.net',email:'ops@example.com',apiToken:'private-jira-token-123',projectKey:'AURO',issueType:'Task'});
	});

	it('does not save credentials when Jira verification fails',async()=>{
		const failedFetch=async()=>new Response('denied',{status:401});
		const response=await jiraConnectionManagementResponse(formRequest({project_id:'1',base_url:'https://example.atlassian.net',account_email:'ops@example.com',project_key:'AURO',issue_type:'Task',api_token:'private-jira-token-123'}),testEnv,failedFetch);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('verification failed (HTTP 401)');
		const stored=await env.DB.prepare('SELECT 1 AS found FROM project_jira_connections WHERE tenant_id=1 AND project_id=1').first();
		expect(stored).toBeNull();
	});

	it('refuses to save credentials when the encryption key is absent',async()=>{
		const missingKey={...testEnv,INTEGRATION_ENCRYPTION_KEY:undefined} as unknown as WorkerEnv;
		const response=await jiraConnectionManagementResponse(formRequest({project_id:'1',base_url:'https://example.atlassian.net',account_email:'ops@example.com',project_key:'AURO',issue_type:'Task',api_token:'private-jira-token-123'}),missingKey,mockFetch);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('INTEGRATION_ENCRYPTION_KEY');
	});
});
