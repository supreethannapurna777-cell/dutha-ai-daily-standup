import type { WorkerEnv } from './env';
import { managementPrincipalFromRequest, requireProjectAccess, type ManagementPrincipal } from './access-control';

const esc = (value: unknown) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
const styles = `<style>:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#17243a;background:#f3f6fb}*{box-sizing:border-box}body{margin:0;padding:28px;background:radial-gradient(circle at 95% 0,#e2eaff,transparent 30%),#f3f6fb}main{max-width:1180px;margin:auto}.top{display:flex;justify-content:space-between;align-items:center;gap:15px}.eyebrow{color:#3567c7;font-size:12px;font-weight:900;letter-spacing:.12em;text-transform:uppercase}h1,h2{color:#183d72;margin:.4em 0}p{line-height:1.5}.muted{color:#63738c}.card{background:#fff;border:1px solid #e3eaf4;border-radius:18px;padding:24px;margin:16px 0;box-shadow:0 12px 36px #142f5510}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.snapshot{background:#f5f8fc;border:1px solid #e3eaf4;padding:14px;border-radius:12px;overflow-wrap:anywhere}label{display:grid;gap:7px;margin:12px 0;font-weight:700}input,textarea{font:inherit;padding:11px;border:1px solid #cad5e4;border-radius:9px;width:100%}textarea{resize:vertical}button,.button{border:0;border-radius:9px;padding:11px 15px;background:#2468b4;color:white;text-decoration:none;font-weight:800;cursor:pointer}.reject{background:#59677c}.banner{padding:12px;border-radius:10px;background:#dbeafe;color:#1e40af}.error{background:#fee2e2;color:#991b1b}.success{background:#dcfce7;color:#166534}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}@media(max-width:700px){body{padding:14px}.grid{grid-template-columns:1fr}.card{padding:17px}.top{align-items:flex-start;flex-direction:column}}</style>`;

type Correction = {
	id:number; team_member_id:number; member_name:string; department:string; correction_text:string; created_at:string;
	original_tasks:string|null; original_people_to_connect:string|null; original_blockers:string|null; original_dependencies:string|null; original_expected_completion:string|null; original_reply:string|null;
};

function page(content:string): Response {
	return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Update corrections · Dutha</title>${styles}</head><body><main>${content}</main></body></html>`, { headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"} });
}

function auth(env:WorkerEnv, request:Request): boolean {
	if (!env.DASHBOARD_USERNAME || !env.DASHBOARD_PASSWORD) return false;
	return request.headers.get('Authorization') === `Basic ${btoa(`${env.DASHBOARD_USERNAME}:${env.DASHBOARD_PASSWORD}`)}`;
}

function originOk(request:Request):boolean {
	const origin=request.headers.get('Origin');
	return origin && origin !== 'null' ? origin===new URL(request.url).origin : request.headers.get('Sec-Fetch-Site')==='same-origin';
}

function loginRequired():Response { return new Response('Authentication required.',{status:401,headers:{'WWW-Authenticate':'Basic realm="Dutha WorkOps"'}}); }

async function render(env:WorkerEnv, principal:ManagementPrincipal, projectId:number, notice=''):Promise<Response> {
	const rows=await env.DB.prepare(`SELECT correction.id, correction.team_member_id, member.name AS member_name, member.department, correction.correction_text, correction.created_at, correction.original_tasks, correction.original_people_to_connect, correction.original_blockers, correction.original_dependencies, correction.original_expected_completion, correction.original_reply FROM employee_update_corrections AS correction INNER JOIN team_members AS member ON member.id=correction.team_member_id WHERE correction.tenant_id=? AND correction.project_id=? AND correction.status='pending_review' ORDER BY correction.created_at ASC, correction.id ASC`).bind(principal.tenantId,projectId).all<Correction>();
	const noticeHtml=notice==='approved'?'<p class="banner success">Correction approved. The reviewed values are now published; the original snapshot remains in the audit record.</p>':notice==='rejected'?'<p class="banner">Correction declined. The employee’s original update remains unchanged.</p>':notice==='stale'?'<p class="banner error">That correction has already been reviewed or is no longer available.</p>':notice==='invalid'?'<p class="banner error">Please complete required fields and keep each response under 1,000 characters.</p>':'';
	const cards=rows.results.map((r)=>`<section class="card"><div class="top"><div><div class="eyebrow">Correction #${r.id} · ${esc(r.department)}</div><h2>${esc(r.member_name)}</h2></div><span class="muted">Submitted ${esc(r.created_at)}</span></div><p><strong>Employee request</strong><br>${esc(r.correction_text)}</p><div class="grid"><div class="snapshot"><strong>Original extracted update</strong><p><strong>Task:</strong> ${esc(r.original_tasks||'Not specified')}</p><p><strong>People to connect:</strong> ${esc(r.original_people_to_connect||'None specified')}</p><p><strong>Blocker:</strong> ${esc(r.original_blockers||'None specified')}</p><p><strong>Dependency:</strong> ${esc(r.original_dependencies||'None specified')}</p><p><strong>Expected:</strong> ${esc(r.original_expected_completion||'Not specified')}</p></div><div class="snapshot"><strong>Original employee message</strong><p>${esc(r.original_reply||'Unavailable')}</p></div></div><form method="post" action="/dashboard/corrections?project=${projectId}"><input type="hidden" name="correction_id" value="${r.id}"><label>Reviewed task<input name="tasks" maxlength="1000" value="${esc(r.original_tasks)}"></label><div class="grid"><label>People to connect<input name="people_to_connect" maxlength="1000" value="${esc(r.original_people_to_connect)}"></label><label>Blockers<input name="blockers" maxlength="1000" value="${esc(r.original_blockers)}"></label><label>Dependencies<input name="dependencies" maxlength="1000" value="${esc(r.original_dependencies)}"></label><label>Expected completion<input name="expected_completion" maxlength="1000" value="${esc(r.original_expected_completion)}"></label></div><label>Manager review notes<input name="manager_notes" maxlength="1000" placeholder="Optional context for the audit trail"></label><p class="muted">Approval applies the values above. Rejecting leaves every published field unchanged.</p><div class="actions"><button name="decision" value="approve">Approve and apply reviewed update</button><button class="reject" name="decision" value="reject">Reject correction</button></div></form></section>`).join('');
	return page(`<div class="top"><div><div class="eyebrow">Manager workspace</div><h1>Employee correction review</h1><p class="muted">Project ${projectId} · ${rows.results.length} awaiting review</p></div><a class="button" href="/dashboard">Return to dashboard</a></div>${noticeHtml}${cards||'<section class="card"><h2>All caught up</h2><p class="muted">No employee corrections are awaiting review.</p></section>'}`);
}

export async function correctionManagementResponse(request:Request, env:WorkerEnv):Promise<Response> {
	if (!auth(env,request)) return loginRequired();
	const principal=managementPrincipalFromRequest(request)??{userId:1,tenantId:1,role:'admin' as const};
	if (principal.role==='team_lead') return new Response('Only authorised managers can review employee corrections.',{status:403});
	const url=new URL(request.url); const projectId=Number(url.searchParams.get('project')??1);
	if (!Number.isSafeInteger(projectId)||projectId<=0) return new Response('Invalid project.',{status:400});
	try { await requireProjectAccess(env.DB,principal,projectId); } catch { return new Response('Project access denied.',{status:403}); }
	if (request.method==='GET') return render(env,principal,projectId,url.searchParams.get('updated')??'');
	if (request.method!=='POST') return new Response('Method not allowed.',{status:405,headers:{Allow:'GET, POST'}});
	if (!originOk(request)) return new Response('Invalid request origin.',{status:403});
	const form=await request.formData(); const correctionId=Number(form.get('correction_id')); const decision=String(form.get('decision')??'');
	if (!Number.isSafeInteger(correctionId)||correctionId<=0||!['approve','reject'].includes(decision)) return render(env,principal,projectId,'invalid');
	const correction=await env.DB.prepare(`SELECT correction.id, correction.processed_update_id FROM employee_update_corrections AS correction WHERE correction.id=? AND correction.tenant_id=? AND correction.project_id=? AND correction.status='pending_review' LIMIT 1`).bind(correctionId,principal.tenantId,projectId).first<{id:number;processed_update_id:number}>();
	if (!correction) return render(env,principal,projectId,'stale');
	const managerNotes=String(form.get('manager_notes')??'').trim();
	if (managerNotes.length>1000) return render(env,principal,projectId,'invalid');
	const now=new Date().toISOString();
	if (decision==='reject') {
		const result=await env.DB.prepare(`UPDATE employee_update_corrections SET status='rejected', manager_notes=?, reviewed_by_management_user_id=?, reviewed_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=? AND project_id=? AND status='pending_review'`).bind(managerNotes||null,principal.userId,now,correctionId,principal.tenantId,projectId).run();
		return render(env,principal,projectId,result.meta.changes===1?'rejected':'stale');
	}
	const fields=['tasks','people_to_connect','blockers','dependencies','expected_completion'] as const;
	const values=fields.map((field)=>String(form.get(field)??'').trim());
	if (values.some((value)=>value.length>1000)) return render(env,principal,projectId,'invalid');
	const updateCorrection=env.DB.prepare(`UPDATE employee_update_corrections SET status='approved', manager_notes=?, reviewed_by_management_user_id=?, reviewed_at=?, final_tasks=?, final_people_to_connect=?, final_blockers=?, final_dependencies=?, final_expected_completion=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=? AND project_id=? AND status='pending_review'`).bind(managerNotes||null,principal.userId,now,...values,correctionId,principal.tenantId,projectId);
	const applyUpdate=env.DB.prepare(`UPDATE processed_updates SET tasks=?, people_to_connect=?, blockers=?, dependencies=?, expected_completion=? WHERE id=? AND tenant_id=? AND project_id=? AND EXISTS (SELECT 1 FROM employee_update_corrections WHERE id=? AND status='approved' AND reviewed_by_management_user_id=? AND reviewed_at=?)`).bind(...values,correction.processed_update_id,principal.tenantId,projectId,correctionId,principal.userId,now);
	const [decisionResult]=await env.DB.batch([updateCorrection,applyUpdate]);
	return render(env,principal,projectId,decisionResult.meta.changes===1?'approved':'stale');
}
