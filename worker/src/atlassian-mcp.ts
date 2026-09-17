import type { WorkerEnv } from "./env";
import type { Fetcher } from "./whatsapp";

export interface AtlassianMcpConfig { url: string; authorization: string; }
export interface AtlassianContextResult { status: "available" | "unavailable"; summary?: string; toolName?: string; error?: string; }
interface RpcResponse { result?: Record<string, unknown>; error?: { message?: string }; }
interface McpTool { name: string; inputSchema?: { properties?: Record<string, unknown> }; }
const SAFE_SEARCH_NAMES = ["search", "searchatlassian", "search_atlassian", "rovo_search"];

export function atlassianMcpConfigFromEnv(env: WorkerEnv): AtlassianMcpConfig | null {
 const url = env.ATLASSIAN_MCP_URL?.trim() || "https://mcp.atlassian.com/v2/mcp?tools=all";
 const serviceToken = env.ATLASSIAN_MCP_SERVICE_TOKEN?.trim();
 if (serviceToken) return { url, authorization: `Bearer ${serviceToken}` };
 const email = env.ATLASSIAN_MCP_EMAIL?.trim();
 const apiToken = env.ATLASSIAN_MCP_API_TOKEN?.trim();
 return email && apiToken ? { url, authorization: `Basic ${btoa(`${email}:${apiToken}`)}` } : null;
}

async function rpc(fetcher: Fetcher, config: AtlassianMcpConfig, body: object, sessionId?: string): Promise<{ response: RpcResponse; sessionId?: string }> {
 const headers: Record<string, string> = { Authorization: config.authorization, Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
 if (sessionId) headers["Mcp-Session-Id"] = sessionId;
 const raw = await fetcher(config.url, { method: "POST", headers, body: JSON.stringify(body) });
 if (!raw.ok) throw new Error(`Atlassian MCP ${raw.status}`);
 const text = await raw.text();
 const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
 const response = JSON.parse(dataLine ? dataLine.slice(5).trim() : text) as RpcResponse;
 if (response.error) throw new Error(response.error.message || "Atlassian MCP request failed");
 return { response, sessionId: raw.headers.get("Mcp-Session-Id") || sessionId };
}

function argsFor(tool: McpTool, query: string): Record<string, string> | null {
 const properties = tool.inputSchema?.properties ?? {};
 for (const key of ["query", "searchString", "text", "q"]) if (key in properties) return { [key]: query };
 return null;
}

function resultText(result?: Record<string, unknown>): string {
 const content = Array.isArray(result?.content) ? result.content : [];
 return content.map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")
  .filter(Boolean).join(" ").replaceAll(/\s+/g, " ").trim().slice(0, 3000);
}

export async function searchAtlassianContext(config: AtlassianMcpConfig, query: string, fetcher: Fetcher = fetch): Promise<AtlassianContextResult> {
 try {
  const initialized = await rpc(fetcher, config, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dutha-workops", version: "1.0.0" } } });
  const listed = await rpc(fetcher, config, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, initialized.sessionId);
  const tools = (listed.response.result?.tools ?? []) as McpTool[];
  const tool = tools.find((candidate) => SAFE_SEARCH_NAMES.includes(candidate.name.toLowerCase()));
  const args = tool ? argsFor(tool, query) : null;
  if (!tool || !args) return { status: "unavailable", error: "No compatible read-only Atlassian search tool" };
  const called = await rpc(fetcher, config, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool.name, arguments: args } }, initialized.sessionId);
  const summary = resultText(called.response.result);
  return summary ? { status: "available", summary, toolName: tool.name } : { status: "unavailable", toolName: tool.name, error: "Atlassian search returned no context" };
 } catch (error) { return { status: "unavailable", error: error instanceof Error ? error.message : "Atlassian MCP request failed" }; }
}

export async function loadAtlassianContext(db: D1Database, caseId: number, config: AtlassianMcpConfig | null, fetcher: Fetcher = fetch): Promise<string | undefined> {
 if (!config) return undefined;
 const item = await db.prepare(`SELECT tenant_id, project_id, issue_summary FROM coordination_cases WHERE id = ?`).bind(caseId).first<{ tenant_id: number; project_id: number; issue_summary: string }>();
 if (!item) return undefined;
 const cached = await db.prepare(`SELECT status, context_summary FROM atlassian_mcp_context WHERE case_id = ?`).bind(caseId).first<{ status: string; context_summary: string | null }>();
 if (cached?.status === "available" && cached.context_summary) return cached.context_summary;
 const result = await searchAtlassianContext(config, item.issue_summary, fetcher);
 await db.prepare(`INSERT INTO atlassian_mcp_context (tenant_id, project_id, case_id, status, tool_name, context_summary, last_error) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(case_id) DO UPDATE SET status=excluded.status, tool_name=excluded.tool_name, context_summary=excluded.context_summary, last_error=excluded.last_error, attempted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP`)
  .bind(item.tenant_id, item.project_id, caseId, result.status, result.toolName ?? null, result.summary ?? null, result.error?.slice(0, 500) ?? null).run();
 return result.summary;
}
