import { accessibleProjects, canAccessProject, managementPrincipalFromRequest, type ManagementPrincipal } from './access-control';
import type { WorkerEnv } from './env';
import { whatsappCredentialsForTenant } from './whatsapp-connection';

type Template = { id:number; project_id:number|null; project_name:string|null; template_name:string; language_code:string; category:string; body_text:string; workflow:string|null; meta_status:string; meta_template_id:string|null };
type Connection = { waba_id:string|null; connection_status:string };
type Workflow = 'initial'|'reminder'|'availability'|'meeting';
type Fetcher=(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>;
const workflowNames:Record<Workflow,string>={initial:'Stand-up request',reminder:'Stand-up reminder',availability:'Availability request',meeting:'Meeting scheduled'};
const parameterCount:Record<Workflow,number>={initial:1,reminder:2,availability:4,meeting:5};
const parameterHelp:Record<Workflow,string>={initial:'{{1}} employee name',reminder:'{{1}} employee name · {{2}} reminder time',availability:'{{1}} employee name · {{2}} case number · {{3}} available times · {{4}} case number for reply',meeting:'{{1}} employee name · {{2}} case number · {{3}} meeting time · {{4}} duration · {{5}} meeting link'};
const starterNames:Record<Workflow,string>={initial:'dutha_daily_standup_request',reminder:'dutha_standup_reminder',availability:'dutha_coordination_availability',meeting:'dutha_meeting_scheduled'};
const starterBodies:Record<Workflow,string>={initial:'Hello {{1}}, it is time for your daily stand-up. Please reply with your update.',reminder:'Hi {{1}}, this is a reminder to send your stand-up update by {{2}}.',availability:'Hi {{1}}, choose a time for coordination case #{{2}}: {{3}}. Reply with case and option, for example {{4}} 1.',meeting:'Hi {{1}}, coordination case #{{2}} is scheduled for {{3}} for {{4}} minutes. Join here: {{5}}'};
const esc=(v:unknown)=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
const isWorkflow=(v:string):v is Workflow=>['initial','reminder','availability','meeting'].includes(v);
function html(body:string,status=200):Response{return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp templates · Dutha</title><style>:root{font-family:Inter,Arial,sans-serif;color:#dbeafe;background:#070b18}*{box-sizing:border-box}body{margin:0;padding:26px;min-height:100vh;background:radial-gradient(circle at 10% 0,#172554 0,transparent 36%),radial-gradient(circle at 90% 5%,#312e81 0,transparent 30%),#070b18}main{max-width:1100px;margin:auto}.head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}h1,h2,h3{color:#f8fafc;margin:0 0 8px}.eyebrow{font-size:11px;font-weight:900;letter-spacing:.12em;color:#60a5fa}.muted{color:#94a3b8;line-height:1.55}.card{background:#111827e8;border:1px solid #334155;border-radius:16px;padding:20px;margin:16px 0;box-shadow:0 16px 42px #0004}.button,button{border:0;border-radius:9px;padding:10px 14px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;text-decoration:none;font-weight:800;cursor:pointer}.secondary{background:#334155}.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:14px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.wide{grid-column:1/-1}label{display:grid;gap:7px;margin:12px 0;font-weight:700}input,select,textarea{font:inherit;padding:10px;border:1px solid #475569;border-radius:9px;background:#0b1220;color:#f8fafc;width:100%}textarea{min-height:130px;resize:vertical}.notice,.error{padding:12px;border-radius:10px;margin:14px 0}.notice{background:#172554;color:#bfdbfe}.error{background:#450a0a;color:#fecaca}.pill{display:inline-block;padding:5px 9px;border-radius:99px;background:#263244;color:#cbd5e1;font-size:12px;font-weight:800}.approved{background:#123b34;color:#86efac}.pending{background:#3d3216;color:#fde68a}.row{border-top:1px solid #263244;padding:14px 0;display:grid;grid-template-columns:1.2fr 1fr 1fr auto;gap:12px;align-items:center}.row:first-of-type{margin-top:10px}.row p{margin:5px 0}.small{font-size:12px}.inline{display:flex;gap:8px;align-items:end}.inline label{flex:1}@media(max-width:760px){body{padding:14px}.head{flex-direction:column}.grid{grid-template-columns:1fr}.wide{grid-column:auto}.row{grid-template-columns:1fr}.inline{align-items:stretch;flex-direction:column}}</style></head><body><main>${body}</main></body></html>`,{status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}})}
function authorised(request:Request,env:WorkerEnv):boolean{return Boolean(env.DASHBOARD_USERNAME&&env.DASHBOARD_PASSWORD&&request.headers.get('Authorization')===`Basic ${btoa(`${env.DASHBOARD_USERNAME}:${env.DASHBOARD_PASSWORD}`)}`)}
function sameOrigin(request:Request):boolean{const o=request.headers.get('Origin');return o&&o!=='null'?o===new URL(request.url).origin:request.headers.get('Sec-Fetch-Site')==='same-origin'}
function placeholders(body:string):number[]{return [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m)=>Number(m[1]))}
function validPlaceholders(body:string,workflow:Workflow):boolean{const got=placeholders(body);const want=parameterCount[workflow];return got.length===want&&got.every((n,i)=>n===i+1)}
function examples(workflow:Workflow):string[]{return workflow==='initial'?['Supreeth']:workflow==='reminder'?['Supreeth','3 PM']:workflow==='availability'?['Supreeth','15','25 Sep 2026 5:00 pm | 5:30 pm','15']:['Supreeth','15','25 Sep 2026 5:30 pm','15','https://meet.example.com/case-15']}

async function syncTemplates(env:WorkerEnv,tenantId:number,url:string,accessToken:string,fetcher:Fetcher):Promise<{count:number;error?:string}>{
	let after:string|undefined,count=0;
	for(let page=0;page<50;page++){
		const pageUrl=new URL(url);pageUrl.searchParams.set('fields','id,name,status,category,language,components');pageUrl.searchParams.set('limit','100');if(after)pageUrl.searchParams.set('after',after);
		const response=await fetcher(pageUrl,{headers:{Authorization:`Bearer ${accessToken}`,Accept:'application/json'}});
		const payload=await response.json() as {data?:Array<{id?:string;name?:string;status?:string;category?:string;language?:string;components?:Array<{type?:string;text?:string}>}>;paging?:{cursors?:{after?:string}};error?:{message?:string}};
		if(!response.ok)return {count,error:`Meta template sync failed (HTTP ${response.status}). ${payload.error?.message??'Check the WABA ID and WhatsApp Business Management permission.'}`};
		for(const template of payload.data??[]){
			if(!template.name||!template.language)continue;
			const body=template.components?.find((component)=>component.type?.toLowerCase()==='body')?.text??'';
			await env.DB.prepare(`INSERT INTO whatsapp_message_templates (tenant_id,template_name,language_code,category,body_text,meta_status,meta_template_id,synced_at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(tenant_id,template_name,language_code) DO UPDATE SET category=excluded.category,body_text=CASE WHEN excluded.body_text='' THEN whatsapp_message_templates.body_text ELSE excluded.body_text END,meta_status=excluded.meta_status,meta_template_id=excluded.meta_template_id,synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`).bind(tenantId,template.name,template.language,template.category??'UTILITY',body,String(template.status??'UNKNOWN').toUpperCase(),template.id??null).run();
		}
		count+=payload.data?.length??0;after=payload.paging?.cursors?.after;
		if(!after||!payload.data?.length)break;
	}
	return {count};
}

async function render(request:Request,env:WorkerEnv,actor:ManagementPrincipal,message='',error=''):Promise<Response>{
	const [connection,projects,rows]=await Promise.all([
		env.DB.prepare('SELECT waba_id,connection_status FROM organisation_whatsapp_connections WHERE tenant_id=?').bind(actor.tenantId).first<Connection>(),
		accessibleProjects(env.DB,actor),
		env.DB.prepare('SELECT template.id,template.project_id,project.name AS project_name,template.template_name,template.language_code,template.category,template.body_text,template.workflow,template.meta_status,template.meta_template_id FROM whatsapp_message_templates AS template LEFT JOIN projects AS project ON project.id=template.project_id AND project.tenant_id=template.tenant_id WHERE template.tenant_id=? ORDER BY template.updated_at DESC,template.id DESC LIMIT 100').bind(actor.tenantId).all<Template>(),
	]);
	const manager=['admin','ceo'].includes(actor.role);
	const visibleRows=manager?(rows.results??[]):(rows.results??[]).filter((t)=>!t.project_id||projects.some((p)=>p.id===t.project_id));
	const requestedProject=Number(new URL(request.url).searchParams.get('project'));
	const selectedProject=projects.some((p)=>p.id===requestedProject)?requestedProject:projects[0]?.id;
	const notice=message?`<div class="notice">${esc(message)}</div>`:'';const alert=error?`<div class="error">${esc(error)}</div>`:'';
	const projectOptions=projects.map((p)=>`<option value="${p.id}" ${p.id===selectedProject?'selected':''}>${esc(p.project_key)} · ${esc(p.name)}</option>`).join('');
	const rowsHtml=visibleRows.map((t)=>{
		const status=t.meta_status.toUpperCase();const workflow=isWorkflow(t.workflow??'')?workflowNames[t.workflow as Workflow]:'Not mapped';
		const badge=`<span class="pill ${status==='APPROVED'?'approved':status==='PENDING'?'pending':''}">${esc(status)}</span>`;
		const submit=manager&&['DRAFT','REJECTED'].includes(status)?`<form method="post"><input type="hidden" name="action" value="submit"><input type="hidden" name="template_id" value="${t.id}"><button>Submit to Meta</button></form>`:'';
		const map=status==='APPROVED'?`<form method="post" class="inline"><input type="hidden" name="action" value="map"><input type="hidden" name="template_id" value="${t.id}"><label>Use for<select name="workflow" required>${Object.entries(workflowNames).map(([key,label])=>`<option value="${key}" ${t.workflow===key?'selected':''}>${label}</option>`).join('')}</select></label><label>Project<select name="project_id" required>${projects.filter((p)=>!t.project_id||p.id===t.project_id).map((p)=>`<option value="${p.id}" ${t.project_id===p.id?'selected':''}>${esc(p.project_key)}</option>`).join('')}</select></label><button>Map</button></form>`:'';
		return `<div class="row"><div><strong>${esc(t.template_name)}</strong><p class="muted small">${esc(t.project_name||'Company library')} · ${esc(t.language_code)} · ${esc(t.category)}</p></div><div>${badge}<p class="muted small">${esc(workflow)}</p></div><div class="muted small">${esc(t.body_text)}</div><div class="actions">${submit}${map}</div></div>`;
	}).join('');
	const projectField=projectOptions?`<label>Project<select name="project_id" required>${projectOptions}</select></label>`:'<p class="error">Create a project before adding templates.</p>';
	const draftForm=projects.length?`<section class="card"><div class="eyebrow">PROJECT MANAGER WORKSPACE</div><h2>Create a template draft</h2><p class="muted">Drafts are scoped to one of your projects. Use a Dutha starter and customize it, or write your own. A CEO or administrator submits drafts to Meta. Keep numbered placeholders intact; Dutha fills them with live employee and case data.</p><form method="post"><input type="hidden" name="action" value="draft"><div class="grid">${projectField}<label>Message purpose<select name="workflow" required>${Object.entries(workflowNames).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><label>Template name<input id="template-name" name="template_name" pattern="[a-z0-9_]{3,64}" maxlength="64" placeholder="aurowise_daily_standup" required></label><label>Language code<input name="language_code" value="en_US" pattern="[a-z]{2}_[A-Z]{2}" maxlength="10" required></label><label>Category<select name="category"><option value="UTILITY">Utility</option><option value="MARKETING">Marketing</option></select></label><label class="wide">Body text<textarea id="template-body" name="body_text" maxlength="1024" required placeholder="Hi {{1}}, please send your stand-up update."></textarea><span class="muted small" id="placeholder-help">${parameterHelp.initial}</span></label></div><div class="actions"><button type="button" class="secondary" id="load-starter">Load Dutha starter</button><button type="submit">Save draft</button></div></form></section>`:'';
	const adminControls=manager?`<section class="card"><div class="eyebrow">COMPANY WHATSAPP ACCOUNT</div><h2>Sync approved templates and review requests</h2><p class="muted">WABA ID: ${esc(connection?.waba_id||'Not set')} · Sender: ${esc(connection?.connection_status||'not connected')}. Add the WABA ID in WhatsApp connection settings. The access token must have WhatsApp Business Management permission to sync and submit templates.</p><form method="post"><input type="hidden" name="action" value="sync"><button class="secondary">Sync templates from Meta</button></form></section>`:'';
	const js=`<script>const form=document.querySelector('form input[name="action"][value="draft"]')?.form;const purpose=form?.querySelector('[name="workflow"]');const help=document.getElementById('placeholder-help');const starterButton=document.getElementById('load-starter');const names=${JSON.stringify(starterNames)};const bodies=${JSON.stringify(starterBodies)};if(purpose&&help){const m=${JSON.stringify(parameterHelp)};purpose.addEventListener('change',()=>help.textContent=m[purpose.value])}starterButton?.addEventListener('click',()=>{const workflow=purpose?.value;if(workflow&&form){form.querySelector('[name="template_name"]').value=names[workflow];form.querySelector('[name="body_text"]').value=bodies[workflow]}})</script>`;
	const body=`<header class="head"><div><div class="eyebrow">WHATSAPP TEMPLATE WORKSPACE</div><h1>Company message templates</h1><p class="muted">Draft project wording, sync WABA templates, and map approved messages to Dutha workflows.</p></div><a class="button secondary" href="/dashboard/whatsapp">WhatsApp connection</a></header>${notice}${alert}${adminControls}${draftForm}<section class="card"><div class="eyebrow">TEMPLATE LIBRARY</div><h2>Templates and review status</h2>${rowsHtml||'<p class="muted">No templates yet. Sync the company WABA or create a project draft.</p>'}</section>${js}`;
	return html(body,error?400:200);
}

export async function whatsappTemplateManagementResponse(request:Request,env:WorkerEnv,fetcher:Fetcher=fetch):Promise<Response>{
	if(!authorised(request,env))return new Response('Authentication required.',{status:401});
	const actor=managementPrincipalFromRequest(request);if(!actor)return new Response('Authentication required.',{status:401});
	if(!['admin','ceo','project_manager'].includes(actor.role))return new Response('Project manager or company administrator access required.',{status:403});
	if(request.method==='GET')return render(request,env,actor);
	if(request.method!=='POST')return new Response('Method not allowed.',{status:405});
	if(!sameOrigin(request))return new Response('Invalid request origin.',{status:403});
	const form=await request.formData(),action=String(form.get('action')??'');
	const manager=['admin','ceo'].includes(actor.role);
	const credentials=await whatsappCredentialsForTenant(env,actor.tenantId);
	const connection=await env.DB.prepare('SELECT waba_id FROM organisation_whatsapp_connections WHERE tenant_id=? AND connection_status=\'connected\'').bind(actor.tenantId).first<{waba_id:string|null}>();
	if(action==='draft'){
		const projectId=Number(form.get('project_id')),workflow=String(form.get('workflow')??''),name=String(form.get('template_name')??'').trim(),language=String(form.get('language_code')??'en_US').trim(),category=String(form.get('category')??'UTILITY'),body=String(form.get('body_text')??'').trim();
		if(!isWorkflow(workflow)||!/^\d+$/.test(String(form.get('project_id')??''))||!await canAccessProject(env.DB,actor,projectId))return render(request,env,actor,'','Choose a project you are assigned to.');
		if(!/^[a-z0-9_]{3,64}$/.test(name)||! /^[a-z]{2}_[A-Z]{2}$/.test(language)||!['UTILITY','MARKETING'].includes(category)||body.length<10||body.length>1024||!validPlaceholders(body,workflow))return render(request,env,actor,'','Check the template name, language, category, body, and required numbered placeholders.');
		try{await env.DB.prepare(`INSERT INTO whatsapp_message_templates (tenant_id,project_id,template_name,language_code,category,body_text,workflow,meta_status,created_by_management_user_id) VALUES (?,?,?,?,?,?,?,'DRAFT',?)`).bind(actor.tenantId,projectId,name,language,category,body,workflow,actor.userId).run();return render(request,env,actor,'Draft saved for company review.');}catch{return render(request,env,actor,'','That template name and language already exist in your company WABA. Choose a unique name.');}
	}
	if(action==='sync'||action==='submit'){
		if(!manager)return new Response('CEO or Administrator access required.',{status:403});
		if(!connection?.waba_id||!credentials)return render(request,env,actor,'','Connect a WhatsApp sender and save its WABA ID first.');
		if(!env.WHATSAPP_API_VERSION)return render(request,env,actor,'','WhatsApp API version is not configured.');
		const url=`https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${encodeURIComponent(connection.waba_id)}/message_templates`;
		if(action==='sync'){
			try{const result=await syncTemplates(env,actor.tenantId,url,credentials.accessToken,fetcher);if(result.error)return render(request,env,actor,'',result.error);return render(request,env,actor,`Synced ${result.count} templates from the company WABA.`);}catch{return render(request,env,actor,'','Could not reach Meta. Retry the sync and check the company token.');}
		}
		const id=Number(form.get('template_id'));const template=await env.DB.prepare('SELECT id,template_name,language_code,category,body_text,workflow,meta_status FROM whatsapp_message_templates WHERE id=? AND tenant_id=?').bind(id,actor.tenantId).first<Template>();
		if(!template||!template.workflow||!isWorkflow(template.workflow)||!['DRAFT','REJECTED'].includes(template.meta_status.toUpperCase()))return render(request,env,actor,'','Only a saved Dutha draft that is not already under review can be submitted.');
		const payload={name:template.template_name,language:template.language_code,category:template.category,components:[{type:'BODY',text:template.body_text,example:{body_text:[examples(template.workflow as Workflow)]}}]};
		try{const response=await fetcher(url,{method:'POST',headers:{Authorization:`Bearer ${credentials.accessToken}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(payload)});const result=await response.json() as {id?:string;status?:string;error?:{message?:string}};if(!response.ok)return render(request,env,actor,'',`Meta rejected the submission request (HTTP ${response.status}). ${result.error?.message??'Review the draft and WABA permissions.'}`);await env.DB.prepare('UPDATE whatsapp_message_templates SET meta_template_id=?,meta_status=?,submitted_by_management_user_id=?,synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=?').bind(result.id??null,(result.status??'PENDING').toUpperCase(),actor.userId,id,actor.tenantId).run();return render(request,env,actor,'Template submitted to Meta for review. Dutha will use it only after it is approved and mapped.');}catch{return render(request,env,actor,'','Could not submit this template to Meta. Check the connection and retry.');}
	}
	if(action==='map'){
		const projectId=Number(form.get('project_id')),templateId=Number(form.get('template_id')),workflow=String(form.get('workflow')??'');
		if(!isWorkflow(workflow)||!Number.isSafeInteger(projectId)||!Number.isSafeInteger(templateId)||!await canAccessProject(env.DB,actor,projectId))return render(request,env,actor,'','Choose an accessible project and workflow.');
		const t=await env.DB.prepare('SELECT id,project_id,body_text,meta_status FROM whatsapp_message_templates WHERE id=? AND tenant_id=?').bind(templateId,actor.tenantId).first<Pick<Template,'id'|'project_id'|'body_text'|'meta_status'>>();
		if(!t||t.meta_status.toUpperCase()!=='APPROVED'||(t.project_id&&t.project_id!==projectId)||!validPlaceholders(t.body_text,workflow))return render(request,env,actor,'','Choose an approved template for this project with the required placeholders.');
		await env.DB.prepare(`INSERT INTO project_whatsapp_template_mappings (tenant_id,project_id,workflow,template_id,updated_by_management_user_id) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id,project_id,workflow) DO UPDATE SET template_id=excluded.template_id,updated_by_management_user_id=excluded.updated_by_management_user_id,updated_at=CURRENT_TIMESTAMP`).bind(actor.tenantId,projectId,workflow,templateId,actor.userId).run();
		return render(request,env,actor,'Approved template mapped to the project workflow.');
	}
	return render(request,env,actor,'','Invalid template action.');
}

export async function projectWhatsAppTemplate(db:D1Database,tenantId:number,projectId:number|undefined,workflow:Workflow):Promise<{template_name:string;language_code:string}|null>{
	if(!projectId)return null;
	return db.prepare(`SELECT template.template_name,template.language_code FROM project_whatsapp_template_mappings AS mapping JOIN whatsapp_message_templates AS template ON template.id=mapping.template_id AND template.tenant_id=mapping.tenant_id WHERE mapping.tenant_id=? AND mapping.project_id=? AND mapping.workflow=? AND template.meta_status='APPROVED' LIMIT 1`).bind(tenantId,projectId,workflow).first<{template_name:string;language_code:string}>();
}
