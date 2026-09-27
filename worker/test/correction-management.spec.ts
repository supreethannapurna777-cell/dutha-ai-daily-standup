import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env';
import { correctionManagementResponse } from '../src/correction-management';

const managerEnv={...env,DASHBOARD_USERNAME:'admin',DASHBOARD_PASSWORD:'test-password'} as WorkerEnv;
const auth=`Basic ${btoa('admin:test-password')}`;
let correctionId:number;
let processedId:number;

async function fixture() {
	const phone=`91${Math.floor(1000000000+Math.random()*8999999999)}`;
	const member=await env.DB.prepare("INSERT INTO team_members (name,phone,department,tenant_id,primary_project_id,email) VALUES ('Correction Employee',?,'Engineering',1,1,?) RETURNING id").bind(phone,`correction-${crypto.randomUUID()}@example.com`).first<{id:number}>();
	const incoming=await env.DB.prepare("INSERT INTO incoming_messages (whatsapp_message_id,received_at,sender_name,sender_phone,original_reply,processing_status,tenant_id,project_id) VALUES (?,CURRENT_TIMESTAMP,'Correction Employee',?,'Original employee message','processed',1,1) RETURNING id").bind(`wamid.manager-correction-${crypto.randomUUID()}`,phone).first<{id:number}>();
	const processed=await env.DB.prepare("INSERT INTO processed_updates (message_id,sender_name,tasks,people_to_connect,blockers,dependencies,expected_completion,original_reply,processing_status,tenant_id,project_id) VALUES (?,'Correction Employee','Original task','Original contact','No blocker','No dependency','Friday','Original employee message','processed',1,1) RETURNING id").bind(incoming!.id).first<{id:number}>();
	const correction=await env.DB.prepare("INSERT INTO employee_update_corrections (tenant_id,project_id,team_member_id,processed_update_id,correction_text,original_tasks,original_people_to_connect,original_blockers,original_dependencies,original_expected_completion,original_reply) VALUES (1,1,?,?,'Task was actually completed yesterday.','Original task','Original contact','No blocker','No dependency','Friday','Original employee message') RETURNING id").bind(member!.id,processed!.id).first<{id:number}>();
	processedId=processed!.id; correctionId=correction!.id;
}

function request(method='GET', body?:URLSearchParams, headers:Record<string,string>={}) {
	return new Request('https://example.com/dashboard/corrections?project=1',{method,headers:{Authorization:auth,Origin:'https://example.com',...headers,...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})},body});
}

describe('employee correction review',()=>{
	beforeEach(async()=>{
		await env.DB.prepare("DELETE FROM employee_update_corrections WHERE correction_text='Task was actually completed yesterday.'").run();
		await fixture();
	});

	it('shows a project-scoped review queue with original reply and values',async()=>{
		const response=await correctionManagementResponse(request(),managerEnv);
		const html=await response.text();
		expect(response.status).toBe(200);
		expect(html).toContain('Employee correction review');
		expect(html).toContain('Original employee message');
		expect(html).toContain('Original task');
		expect(html).toContain('Approve and apply reviewed update');
	});

	it('approves reviewed values and writes decision metadata while preserving the original snapshot',async()=>{
		const response=await correctionManagementResponse(request('POST',new URLSearchParams({correction_id:String(correctionId),decision:'approve',tasks:'Correct task',people_to_connect:'Correct contact',blockers:'None',dependencies:'None',expected_completion:'Thursday',manager_notes:'Checked against the employee note.'})),managerEnv);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('Correction approved');
		const update=await env.DB.prepare('SELECT tasks,people_to_connect,blockers,dependencies,expected_completion,original_reply FROM processed_updates WHERE id=?').bind(processedId).first<Record<string,string>>();
		expect(update).toEqual({tasks:'Correct task',people_to_connect:'Correct contact',blockers:'None',dependencies:'None',expected_completion:'Thursday',original_reply:'Original employee message'});
		const audit=await env.DB.prepare('SELECT status,original_tasks,original_reply,final_tasks,manager_notes,reviewed_by_management_user_id,reviewed_at FROM employee_update_corrections WHERE id=?').bind(correctionId).first<Record<string,unknown>>();
		expect(audit).toMatchObject({status:'approved',original_tasks:'Original task',original_reply:'Original employee message',final_tasks:'Correct task',manager_notes:'Checked against the employee note.',reviewed_by_management_user_id:1});
		expect(audit?.reviewed_at).toBeTruthy();
	});

	it('rejects a correction without changing the published update',async()=>{
		const response=await correctionManagementResponse(request('POST',new URLSearchParams({correction_id:String(correctionId),decision:'reject',manager_notes:'The original is already correct.'})),managerEnv);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('Correction declined');
		const update=await env.DB.prepare('SELECT tasks,expected_completion FROM processed_updates WHERE id=?').bind(processedId).first<{tasks:string;expected_completion:string}>();
		expect(update).toEqual({tasks:'Original task',expected_completion:'Friday'});
		const audit=await env.DB.prepare('SELECT status,manager_notes,reviewed_by_management_user_id,reviewed_at FROM employee_update_corrections WHERE id=?').bind(correctionId).first<Record<string,unknown>>();
		expect(audit).toMatchObject({status:'rejected',manager_notes:'The original is already correct.',reviewed_by_management_user_id:1});
		expect(audit?.reviewed_at).toBeTruthy();
	});

	it('prevents team leads from reviewing corrections',async()=>{
		const response=await correctionManagementResponse(request('GET',undefined,{'X-Dutha-User-Id':'99','X-Dutha-Tenant-Id':'1','X-Dutha-Tenant-Role':'team_lead'}),managerEnv);
		expect(response.status).toBe(403);
	});
});
