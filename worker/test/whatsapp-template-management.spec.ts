import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env';
import { encryptIntegrationSecret } from '../src/integration-secrets';
import { sendInitialRequest } from '../src/whatsapp';
import { whatsappTemplateManagementResponse } from '../src/whatsapp-template-management';

const masterKey=btoa('0123456789abcdef0123456789abcdef');
const testEnv={...env,DASHBOARD_USERNAME:'admin',DASHBOARD_PASSWORD:'password',INTEGRATION_ENCRYPTION_KEY:masterKey,WHATSAPP_API_VERSION:'v26.0',WHATSAPP_TEMPLATE_LANGUAGE:'en_US',WHATSAPP_INITIAL_TEMPLATE_NAME:'daily_standup_request'} as WorkerEnv;
function request(role='admin',method='GET',body?:FormData,userId=1){return new Request('https://example.com/dashboard/whatsapp/templates',{method,headers:{Authorization:`Basic ${btoa('admin:password')}`,'X-Dutha-User-Id':String(userId),'X-Dutha-Tenant-Id':'1','X-Dutha-Tenant-Role':role,...(method==='POST'?{Origin:'https://example.com'}:{})},body});}
async function addConnectedWaba(){const secret=await encryptIntegrationSecret('private-whatsapp-token',masterKey,1,0,'whatsapp','access_token');await env.DB.prepare(`INSERT INTO organisation_whatsapp_connections (tenant_id,phone_number_id,waba_id,access_token_ciphertext,access_token_iv,connection_status,last_verified_at) VALUES (1,'123456789','987654321',?,?,'connected','2026-09-27T00:00:00.000Z') ON CONFLICT(tenant_id) DO UPDATE SET phone_number_id=excluded.phone_number_id,waba_id=excluded.waba_id,access_token_ciphertext=excluded.access_token_ciphertext,access_token_iv=excluded.access_token_iv,connection_status='connected'`).bind(secret.ciphertext,secret.iv).run();}

describe('project WhatsApp template workspace',()=>{
	beforeEach(async()=>{
		await env.DB.prepare('DELETE FROM project_whatsapp_template_mappings WHERE tenant_id=1').run();
		await env.DB.prepare('DELETE FROM whatsapp_message_templates WHERE tenant_id=1').run();
		await env.DB.prepare('DELETE FROM organisation_whatsapp_connections WHERE tenant_id=1').run();
		await env.DB.prepare("DELETE FROM project_memberships WHERE management_user_id IN (SELECT id FROM management_users WHERE external_subject='template-workspace-pm')").run();
		await env.DB.prepare("DELETE FROM management_users WHERE external_subject='template-workspace-pm'").run();
	});

	it('lets a project manager draft a project template but not submit it to Meta',async()=>{
		const created=await env.DB.prepare(`INSERT INTO management_users (tenant_id,external_subject,display_name,email,tenant_role) VALUES (1,'template-workspace-pm','Template PM','template-pm@example.com','project_manager')`).run();
		const userId=Number(created.meta.last_row_id);
		await env.DB.prepare('INSERT INTO project_memberships (project_id,management_user_id) VALUES (1,?)').bind(userId).run();
		const draft=new FormData();draft.set('action','draft');draft.set('project_id','1');draft.set('workflow','initial');draft.set('template_name','aurowise_daily_standup');draft.set('language_code','en_US');draft.set('category','UTILITY');draft.set('body_text','Hello {{1}}, please share your stand-up update.');
		const response=await whatsappTemplateManagementResponse(request('project_manager','POST',draft,userId),testEnv);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('Draft saved for company review.');
		const saved=await env.DB.prepare('SELECT project_id,workflow,meta_status FROM whatsapp_message_templates WHERE tenant_id=1 AND template_name=\'aurowise_daily_standup\'').first();
		expect(saved).toEqual({project_id:1,workflow:'initial',meta_status:'DRAFT'});
		const submit=new FormData();submit.set('action','submit');
		const denied=await whatsappTemplateManagementResponse(request('project_manager','POST',submit,userId),testEnv);
		expect(denied.status).toBe(403);
	});

	it('rejects drafts whose numbered placeholders do not match the workflow',async()=>{
		const form=new FormData();form.set('action','draft');form.set('project_id','1');form.set('workflow','reminder');form.set('template_name','bad_reminder_template');form.set('language_code','en_US');form.set('category','UTILITY');form.set('body_text','Hello {{1}}, reminder.');
		const response=await whatsappTemplateManagementResponse(request('admin','POST',form),testEnv);
		expect(response.status).toBe(400);
		expect(await env.DB.prepare('SELECT id FROM whatsapp_message_templates WHERE template_name=\'bad_reminder_template\'').first()).toBeNull();
	});

	it('submits a company draft to the connected WABA for Meta review',async()=>{
		await addConnectedWaba();
		const draft=await env.DB.prepare(`INSERT INTO whatsapp_message_templates (tenant_id,project_id,template_name,language_code,category,body_text,workflow,meta_status,created_by_management_user_id) VALUES (1,1,'aurowise_daily_standup','en_US','UTILITY','Hello {{1}}, please share your stand-up update.','initial','DRAFT',1)`).run();
		const form=new FormData();form.set('action','submit');form.set('template_id',String(draft.meta.last_row_id));
		const response=await whatsappTemplateManagementResponse(request('admin','POST',form),testEnv,async(input,init)=>{expect(String(input)).toContain('/987654321/message_templates');expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-whatsapp-token');const body=JSON.parse(String(init?.body));expect(body.name).toBe('aurowise_daily_standup');expect(body.components[0].example.body_text).toEqual([['Supreeth']]);return Response.json({id:'meta-template-1',status:'PENDING'});});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('Template submitted to Meta for review.');
		const saved=await env.DB.prepare('SELECT meta_template_id,meta_status FROM whatsapp_message_templates WHERE tenant_id=1 AND template_name=\'aurowise_daily_standup\'').first();
		expect(saved).toEqual({meta_template_id:'meta-template-1',meta_status:'PENDING'});
	});

	it('syncs Meta approval state and lets a project manager map an approved template',async()=>{
		await addConnectedWaba();
		const syncForm=new FormData();syncForm.set('action','sync');
		let pageCount=0;
		const syncResponse=await whatsappTemplateManagementResponse(request('admin','POST',syncForm),testEnv,async(input,init)=>{const pageUrl=new URL(String(input));expect(pageUrl.pathname).toContain('/987654321/message_templates');expect(pageUrl.searchParams.get('fields')).toBe('id,name,status,category,language,components');expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-whatsapp-token');pageCount++;if(!pageUrl.searchParams.has('after'))return Response.json({data:[{id:'meta-template-2',name:'approved_standup',status:'APPROVED',category:'UTILITY',language:'en_US',components:[{type:'BODY',text:'Hello {{1}}, send your update.'}]}],paging:{cursors:{after:'next-page'}}});expect(pageUrl.searchParams.get('after')).toBe('next-page');return Response.json({data:[{id:'meta-template-3',name:'pending_reminder',status:'PENDING',category:'UTILITY',language:'en_US',components:[{type:'BODY',text:'Hello {{1}}, reminder at {{2}}.'}]}]});});
		expect(syncResponse.status).toBe(200);
		expect(pageCount).toBe(2);
		const template=await env.DB.prepare("SELECT id FROM whatsapp_message_templates WHERE tenant_id=1 AND template_name='approved_standup'").first<{id:number}>();
		expect(template).toBeTruthy();
		const pm=await env.DB.prepare(`INSERT INTO management_users (tenant_id,external_subject,display_name,email,tenant_role) VALUES (1,'template-workspace-pm','Template PM','template-pm@example.com','project_manager')`).run();
		const userId=Number(pm.meta.last_row_id);await env.DB.prepare('INSERT INTO project_memberships (project_id,management_user_id) VALUES (1,?)').bind(userId).run();
		const map=new FormData();map.set('action','map');map.set('template_id',String(template!.id));map.set('workflow','initial');map.set('project_id','1');
		const mapped=await whatsappTemplateManagementResponse(request('project_manager','POST',map,userId),testEnv);
		expect(mapped.status).toBe(200);
		expect(await env.DB.prepare('SELECT template_id FROM project_whatsapp_template_mappings WHERE tenant_id=1 AND project_id=1 AND workflow=\'initial\'').first()).toEqual({template_id:template!.id});
	});

	it('uses the approved mapped template and its locale on outbound stand-up sends',async()=>{
		await addConnectedWaba();
		const insert=await env.DB.prepare(`INSERT INTO whatsapp_message_templates (tenant_id,project_id,template_name,language_code,category,body_text,workflow,meta_status) VALUES (1,1,'mapped_standup','hi_IN','UTILITY','Hello {{1}}, update.','initial','APPROVED')`).run();
		await env.DB.prepare(`INSERT INTO project_whatsapp_template_mappings (tenant_id,project_id,workflow,template_id) VALUES (1,1,'initial',?)`).bind(Number(insert.meta.last_row_id)).run();
		const member={id:1,name:'Supreeth',phone:'919100000000',department:'Management',tenantId:1,projectId:1};
		const sent=await sendInitialRequest(testEnv,member,async(_input,init)=>{const body=JSON.parse(String(init?.body));expect(body.template.name).toBe('mapped_standup');expect(body.template.language.code).toBe('hi_IN');return Response.json({messages:[{id:'wamid-mapped'}]});});
		expect(sent.success).toBe(true);
	});
});
