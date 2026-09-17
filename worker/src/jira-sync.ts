import type { WorkerEnv } from "./env";
import type { Fetcher } from "./whatsapp";

export interface JiraConfig {
        baseUrl: string;
        email: string;
        apiToken: string;
        projectKey: string;
        issueType: string;
}

export interface JiraSyncResult {
        status: "synced" | "already_synced" | "not_ready" | "failed";
        issueKey?: string;
        error?: string;
}

interface JiraCase {
        id: number;
        tenant_id: number;
        project_id: number;
        issue_summary: string;
        priority: string;
        sla_due_at: string | null;
        status: string;
        requester_name: string;
        responsible_name: string | null;
}

export function jiraConfigFromEnv(env: WorkerEnv): JiraConfig | null {
        const baseUrl = env.JIRA_BASE_URL?.trim().replace(/\/+$/, "");
        const email = env.JIRA_EMAIL?.trim();
        const apiToken = env.JIRA_API_TOKEN?.trim();
        const projectKey = env.JIRA_PROJECT_KEY?.trim();
        if (!baseUrl || !email || !apiToken || !projectKey) return null;
        return {
                baseUrl,
                email,
                apiToken,
                projectKey,
                issueType: env.JIRA_ISSUE_TYPE?.trim() || "Task",
        };
}

function jiraDescription(item: JiraCase): object {
        const lines = [
                `Requester: ${item.requester_name}`,
                `Responsible: ${item.responsible_name ?? "Not assigned"}`,
                `Priority: ${item.priority}`,
                `SLA due: ${item.sla_due_at ?? "Not set"}`,
                `Dutha case: ${item.id}`,
        ];
        return {
                type: "doc",
                version: 1,
                content: lines.map((text) => ({
                        type: "paragraph",
                        content: [{ type: "text", text }],
                })),
        };
}

async function markFailed(
        db: D1Database,
        caseId: number,
        error: string,
): Promise<JiraSyncResult> {
        await db.prepare(`
                UPDATE jira_case_links
                SET sync_status = 'failed', last_error = ?,
                        updated_at = CURRENT_TIMESTAMP
                WHERE case_id = ?
        `).bind(error.slice(0, 1000), caseId).run();
        return { status: "failed", error };
}

export async function syncApprovedCaseToJira(
        db: D1Database,
        caseId: number,
        config: JiraConfig,
        fetcher: Fetcher = fetch,
): Promise<JiraSyncResult> {
        const item = await db.prepare(`
                SELECT coordination.id, coordination.tenant_id,
                        coordination.project_id, coordination.issue_summary,
                        coordination.priority, coordination.sla_due_at,
                        coordination.status, requester.name AS requester_name,
                        responsible.name AS responsible_name
                FROM coordination_cases AS coordination
                INNER JOIN team_members AS requester
                        ON requester.id = coordination.requester_member_id
                LEFT JOIN team_members AS responsible
                        ON responsible.id = coordination.responsible_member_id
                WHERE coordination.id = ?
        `).bind(caseId).first<JiraCase>();
        if (!item || item.status !== "approved") return { status: "not_ready" };

        await db.prepare(`
                INSERT OR IGNORE INTO jira_case_links (
                        tenant_id, project_id, case_id
                ) VALUES (?, ?, ?)
        `).bind(item.tenant_id, item.project_id, item.id).run();
        const link = await db.prepare(`
                SELECT sync_status, external_issue_key FROM jira_case_links
                WHERE case_id = ?
        `).bind(caseId).first<{
                sync_status: string;
                external_issue_key: string | null;
        }>();
        if (link?.sync_status === "synced") {
                return {
                        status: "already_synced",
                        issueKey: link.external_issue_key ?? undefined,
                };
        }
        if (link?.sync_status === "syncing") return { status: "not_ready" };

        await db.prepare(`
                UPDATE jira_case_links
                SET sync_status = 'syncing', attempt_count = attempt_count + 1,
                        last_error = NULL, last_attempted_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                WHERE case_id = ?
        `).bind(caseId).run();

        let response: Response;
        try {
                response = await fetcher(`${config.baseUrl}/rest/api/3/issue`, {
                        method: "POST",
                        headers: {
                                Authorization: `Basic ${btoa(`${config.email}:${config.apiToken}`)}`,
                                Accept: "application/json",
                                "Content-Type": "application/json",
                        },
                        body: JSON.stringify({
                                fields: {
                                        project: { key: config.projectKey },
                                        issuetype: { name: config.issueType },
                                        summary: `[Dutha] ${item.issue_summary}`.slice(0, 255),
                                        description: jiraDescription(item),
                                },
                        }),
                });
        } catch (error) {
                return markFailed(
                        db,
                        caseId,
                        error instanceof Error ? error.message : "Jira request failed",
                );
        }
        if (!response.ok) {
                const details = (await response.text()).slice(0, 500);
                return markFailed(db, caseId, `Jira ${response.status}: ${details || response.statusText}`);
        }
        const created = await response.json<{
                id?: string;
                key?: string;
        }>();
        if (!created.id || !created.key) {
                return markFailed(db, caseId, "Jira response did not include an issue ID and key");
        }
        const issueUrl = `${config.baseUrl}/browse/${encodeURIComponent(created.key)}`;
        await db.prepare(`
                UPDATE jira_case_links
                SET sync_status = 'synced', external_issue_id = ?,
                        external_issue_key = ?, external_issue_url = ?,
                        last_error = NULL, synced_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                WHERE case_id = ?
        `).bind(created.id, created.key, issueUrl, caseId).run();
        return { status: "synced", issueKey: created.key };
}
