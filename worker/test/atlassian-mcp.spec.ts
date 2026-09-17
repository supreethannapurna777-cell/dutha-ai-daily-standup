import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAtlassianContext, searchAtlassianContext, type AtlassianMcpConfig } from "../src/atlassian-mcp";
import { syncApprovedCaseToJira, type JiraConfig } from "../src/jira-sync";

const mcp: AtlassianMcpConfig = { url: "https://mcp.atlassian.test/v2/mcp", authorization: "Bearer secret-mcp-token" };
const jira: JiraConfig = { baseUrl: "https://example.atlassian.net", email: "jira@example.com", apiToken: "jira-secret", projectKey: "DUTHA", issueType: "Task" };

function rpcResponses(context = "A related Confluence runbook exists") {
 return vi.fn()
  .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 1, result: {} }, { headers: { "Mcp-Session-Id": "session-1" } }))
  .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search", inputSchema: { properties: { query: { type: "string" } } } }] } }))
  .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: context }] } }));
}

describe("Atlassian MCP read-only intelligence", () => {
 let caseId: number;
 beforeEach(async () => {
  await env.DB.batch([
   env.DB.prepare("DELETE FROM atlassian_mcp_context"), env.DB.prepare("DELETE FROM jira_case_links"), env.DB.prepare("DELETE FROM case_events"),
   env.DB.prepare("DELETE FROM coordination_cases"), env.DB.prepare("DELETE FROM processed_updates"), env.DB.prepare("DELETE FROM incoming_messages"), env.DB.prepare("DELETE FROM team_members"),
  ]);
  const member = await env.DB.prepare(`INSERT INTO team_members (name, phone, department, tenant_id, primary_project_id) VALUES ('Sreeja','919100000020','Ops',1,1) RETURNING id`).first<{ id: number }>();
  const incoming = await env.DB.prepare(`INSERT INTO incoming_messages (whatsapp_message_id, received_at, sender_name, sender_phone, original_reply, processing_status, tenant_id, project_id, channel, external_message_id, sender_external_id, team_member_id) VALUES ('mcp-msg','2026-09-17T12:00:00Z','Sreeja','919100000020','Need access','processed',1,1,'whatsapp','mcp-msg','919100000020',?) RETURNING id`).bind(member!.id).first<{ id: number }>();
  const processed = await env.DB.prepare(`INSERT INTO processed_updates (message_id, sender_name, blockers, original_reply, processing_status, tenant_id, project_id) VALUES (?,'Sreeja','Need access','Need access','processed',1,1) RETURNING id`).bind(incoming!.id).first<{ id: number }>();
  caseId = (await env.DB.prepare(`INSERT INTO coordination_cases (source_update_id, requester_member_id, case_type, issue_summary, status, priority, tenant_id, project_id, resolution_state) VALUES (?,?,'blocker','Need production access','approved','high',1,1,'triaged') RETURNING id`).bind(processed!.id, member!.id).first<{ id: number }>())!.id;
 });

 it("discovers and calls only the known read-only search tool", async () => {
  const fetcher = rpcResponses();
  const result = await searchAtlassianContext(mcp, "Need production access", fetcher);
  expect(result).toMatchObject({ status: "available", toolName: "search", summary: "A related Confluence runbook exists" });
  const call = JSON.parse(String(fetcher.mock.calls[2][1]?.body));
  expect(call).toMatchObject({ method: "tools/call", params: { name: "search", arguments: { query: "Need production access" } } });
  expect(JSON.stringify(call)).not.toContain("secret-mcp-token");
 });

 it("refuses write tools", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ result: {} })).mockResolvedValueOnce(Response.json({ result: { tools: [{ name: "createJiraIssue", inputSchema: { properties: { query: {} } } }] } }));
  expect(await searchAtlassianContext(mcp, "query", fetcher)).toMatchObject({ status: "unavailable" });
  expect(fetcher).toHaveBeenCalledTimes(2);
 });

 it("stores context without credentials", async () => {
  const fetcher = rpcResponses();
  expect(await loadAtlassianContext(env.DB, caseId, mcp, fetcher)).toContain("runbook");
  const row = await env.DB.prepare(`SELECT status, tool_name, context_summary, last_error FROM atlassian_mcp_context WHERE case_id = ?`).bind(caseId).first();
  expect(row).toEqual({ status: "available", tool_name: "search", context_summary: "A related Confluence runbook exists", last_error: null });
  expect(JSON.stringify(row)).not.toContain("secret-mcp-token");
 });

 it("continues Jira creation when MCP is unavailable", async () => {
  const fetcher = vi.fn()
   .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
   .mockResolvedValueOnce(Response.json({ id: "100", key: "DUTHA-100" }, { status: 201 }));
  expect(await syncApprovedCaseToJira(env.DB, caseId, jira, fetcher, mcp)).toEqual({ status: "synced", issueKey: "DUTHA-100" });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect((await env.DB.prepare(`SELECT status FROM atlassian_mcp_context WHERE case_id = ?`).bind(caseId).first<{ status: string }>())?.status).toBe("unavailable");
 });
});
