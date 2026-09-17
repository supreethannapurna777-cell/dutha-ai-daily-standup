import type { WorkerEnv } from "./env";
import { sendTextMessage, type Fetcher } from "./whatsapp";

interface JiraPayload {
        webhookEvent?: string;
        timestamp?: number;
        issue?: { id?: string; key?: string; fields?: {
                status?: { id?: string; name?: string; statusCategory?: { key?: string } };
                assignee?: { accountId?: string; displayName?: string } | null;
                resolution?: { name?: string } | null;
        } };
        comment?: { id?: string; body?: unknown };
}

export interface JiraWebhookResult {
        status: "processed" | "duplicate" | "ignored";
        caseId?: number;
        action?: "awaiting_verification" | "in_progress" | "metadata_updated";
}

function safeEqual(first: string, second: string): boolean {
        if (first.length !== second.length) return false;
        let difference = 0;
        for (let index = 0; index < first.length; index += 1) difference |= first.charCodeAt(index) ^ second.charCodeAt(index);
        return difference === 0;
}

export function jiraWebhookAuthorised(request: Request, env: WorkerEnv): boolean {
        const expected = env.JIRA_WEBHOOK_SECRET?.trim();
        if (!expected) return false;
        const bearer = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        const explicit = request.headers.get("X-Dutha-Jira-Secret") ?? "";
        return safeEqual(bearer || explicit, expected);
}

function eventKey(payload: JiraPayload, request: Request): string {
        const supplied = request.headers.get("X-Atlassian-Webhook-Identifier")?.trim();
        if (supplied) return `jira:${supplied}`;
        return ["jira", payload.webhookEvent ?? "issue_updated", payload.timestamp ?? 0, payload.issue?.id ?? "", payload.issue?.fields?.status?.id ?? "", payload.comment?.id ?? ""].join(":");
}

function isDone(payload: JiraPayload): boolean {
        const fields = payload.issue?.fields;
        return fields?.status?.statusCategory?.key?.toLowerCase() === "done" || Boolean(fields?.resolution?.name);
}

function adfText(value: unknown): string {
        if (typeof value === "string") return value.trim();
        if (!value || typeof value !== "object") return "";
        const item = value as { text?: unknown; content?: unknown };
        const own = typeof item.text === "string" ? item.text : "";
        const children = Array.isArray(item.content) ? item.content.map(adfText).filter(Boolean).join(" ") : "";
        return `${own} ${children}`.trim();
}

async function queueRequester(db: D1Database, item: {
        case_id: number; tenant_id: number; project_id: number; requester_member_id: number;
}, event: string, message: string): Promise<void> {
        const identities = await db.prepare(`SELECT channel FROM channel_identities WHERE tenant_id = ? AND team_member_id = ?`)
                .bind(item.tenant_id, item.requester_member_id).all<{ channel: "whatsapp" | "teams" }>();
        for (const identity of identities.results) {
                await db.prepare(`INSERT OR IGNORE INTO channel_notification_outbox (tenant_id, project_id, case_id, team_member_id, channel, notification_type, deduplication_key, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                        .bind(item.tenant_id, item.project_id, item.case_id, item.requester_member_id, identity.channel, event, `${event}:${item.case_id}:${identity.channel}`, message).run();
        }
}

export async function processJiraWebhook(db: D1Database, payload: JiraPayload, request: Request): Promise<JiraWebhookResult> {
        const issueId = payload.issue?.id?.trim();
        const issueKey = payload.issue?.key?.trim();
        if (!issueId && !issueKey) return { status: "ignored" };
        const key = eventKey(payload, request);
        const inserted = await db.prepare(`INSERT OR IGNORE INTO jira_webhook_events (event_key, event_type, external_issue_id, external_issue_key, processing_status) VALUES (?, ?, ?, ?, 'processed') RETURNING id`)
                .bind(key, payload.webhookEvent ?? "unknown", issueId ?? null, issueKey ?? null).first<{ id: number }>();
        if (!inserted) return { status: "duplicate" };
        const item = await db.prepare(`
                SELECT link.case_id, link.tenant_id, link.project_id, coordination.requester_member_id, coordination.resolution_state
                FROM jira_case_links AS link INNER JOIN coordination_cases AS coordination ON coordination.id = link.case_id
                WHERE (? IS NOT NULL AND link.external_issue_id = ?) OR (? IS NOT NULL AND link.external_issue_key = ?) LIMIT 1
        `).bind(issueId ?? null, issueId ?? null, issueKey ?? null, issueKey ?? null).first<{
                case_id: number; tenant_id: number; project_id: number; requester_member_id: number; resolution_state: string;
        }>();
        if (!item) {
                await db.prepare(`UPDATE jira_webhook_events SET processing_status = 'ignored', details = 'No Dutha case link' WHERE id = ?`).bind(inserted.id).run();
                return { status: "ignored" };
        }
        const statusName = payload.issue?.fields?.status?.name?.trim() ?? "Updated";
        const assignee = payload.issue?.fields?.assignee;
        await db.batch([
                db.prepare(`UPDATE jira_case_links SET external_status = ?, external_assignee_id = ?, external_assignee_name = ?, last_webhook_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE case_id = ?`).bind(statusName, assignee?.accountId ?? null, assignee?.displayName ?? null, item.case_id),
                db.prepare(`UPDATE jira_webhook_events SET case_id = ?, details = ? WHERE id = ?`).bind(item.case_id, `Jira status: ${statusName}`, inserted.id),
        ]);
        if (isDone(payload) && item.resolution_state !== "resolved") {
                const summary = adfText(payload.comment?.body) || `${issueKey ?? "Jira issue"} moved to ${statusName}.`;
                await db.batch([
                        db.prepare(`UPDATE coordination_cases SET status = 'in_progress', resolution_state = 'awaiting_verification', resolution_summary = ?, resolution_proposed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND resolution_state != 'resolved'`).bind(summary, item.case_id),
                        db.prepare(`INSERT INTO blocker_resolution_evidence (tenant_id, project_id, case_id, evidence_type, summary, external_url, created_by_type) SELECT tenant_id, project_id, case_id, 'external_event', ?, external_issue_url, 'system' FROM jira_case_links WHERE case_id = ?`).bind(summary, item.case_id),
                        db.prepare(`INSERT INTO case_events (case_id, event_type, actor_type, details) VALUES (?, 'resolution_proposed', 'system', ?)`).bind(item.case_id, summary),
                ]);
                await queueRequester(db, item, `jira_resolution:${key}`, `Jira reports case #${item.case_id} as resolved. ${summary}\nReply VERIFY ${item.case_id} to close, or REOPEN ${item.case_id} <reason>.`);
                return { status: "processed", caseId: item.case_id, action: "awaiting_verification" };
        }
        if (!isDone(payload) && item.resolution_state === "awaiting_verification") {
                await db.prepare(`UPDATE coordination_cases SET status = 'in_progress', resolution_state = 'in_coordination', resolution_summary = NULL, resolution_proposed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND resolution_state = 'awaiting_verification'`).bind(item.case_id).run();
                await queueRequester(db, item, `jira_reopened:${key}`, `Case #${item.case_id} moved back to ${statusName} in Jira. Dutha reopened coordination.`);
                return { status: "processed", caseId: item.case_id, action: "in_progress" };
        }
        return { status: "processed", caseId: item.case_id, action: "metadata_updated" };
}

export async function deliverPendingWhatsappNotifications(env: WorkerEnv, fetcher: Fetcher = fetch): Promise<number> {
        const pending = await env.DB.prepare(`
                SELECT outbox.id, outbox.message, identity.external_id FROM channel_notification_outbox AS outbox
                INNER JOIN channel_identities AS identity ON identity.team_member_id = outbox.team_member_id AND identity.tenant_id = outbox.tenant_id AND identity.channel = 'whatsapp'
                WHERE outbox.channel = 'whatsapp' AND outbox.delivery_status IN ('pending', 'failed') AND outbox.attempt_count < 5
                ORDER BY outbox.created_at LIMIT 20
        `).all<{ id: number; message: string; external_id: string }>();
        let sent = 0;
        for (const notification of pending.results) {
                await env.DB.prepare(`UPDATE channel_notification_outbox SET delivery_status = 'sending', attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(notification.id).run();
                const result = await sendTextMessage(env, notification.external_id, notification.message, fetcher);
                await env.DB.prepare(`UPDATE channel_notification_outbox SET delivery_status = ?, last_error = ?, sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE sent_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .bind(result.success ? "sent" : "failed", result.error ?? null, result.success ? "sent" : "failed", notification.id).run();
                if (result.success) sent += 1;
        }
        return sent;
}
