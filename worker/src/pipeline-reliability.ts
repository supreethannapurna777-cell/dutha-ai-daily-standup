import type { WorkerEnv } from "./env";
import { jiraConfigFromEnv, retryPendingJiraSyncs, type JiraRetrySummary } from "./jira-sync";
import { atlassianMcpConfigFromEnv } from "./atlassian-mcp";
import { deliverPendingWhatsappNotifications } from "./jira-webhook";
import { deliverPendingTeamsNotifications } from "./teams";
import type { Fetcher } from "./whatsapp";

export interface PipelineRecoverySummary {
        jira: JiraRetrySummary;
        recoveredNotifications: number;
        whatsappSent: number;
        teamsSent: number;
        exhausted: number;
}

export interface IntegrationReadiness {
        whatsapp: { configured: boolean; pending: number; failed: number };
        teams: { configured: boolean; pending: number; failed: number };
        jira: { configured: boolean; webhookConfigured: boolean; pending: number; failed: number };
}

async function notificationCounts(db: D1Database, channel: "whatsapp" | "teams") {
        return db.prepare(`
                SELECT
                        SUM(CASE WHEN delivery_status IN ('pending', 'sending') THEN 1 ELSE 0 END) AS pending,
                        SUM(CASE WHEN delivery_status = 'failed' THEN 1 ELSE 0 END) AS failed
                FROM channel_notification_outbox WHERE channel = ?
        `).bind(channel).first<{ pending: number | null; failed: number | null }>();
}

export async function integrationReadiness(env: WorkerEnv): Promise<IntegrationReadiness> {
        const [whatsapp, teams, jira] = await Promise.all([
                notificationCounts(env.DB, "whatsapp"),
                notificationCounts(env.DB, "teams"),
                env.DB.prepare(`SELECT
                        SUM(CASE WHEN sync_status IN ('pending', 'syncing') THEN 1 ELSE 0 END) AS pending,
                        SUM(CASE WHEN sync_status = 'failed' THEN 1 ELSE 0 END) AS failed
                        FROM jira_case_links`).first<{ pending: number | null; failed: number | null }>(),
        ]);
        return {
                whatsapp: {
                        configured: Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_APP_SECRET),
                        pending: whatsapp?.pending ?? 0, failed: whatsapp?.failed ?? 0,
                },
                teams: {
                        configured: Boolean(env.MICROSOFT_APP_ID && env.MICROSOFT_APP_PASSWORD),
                        pending: teams?.pending ?? 0, failed: teams?.failed ?? 0,
                },
                jira: {
                        configured: Boolean(jiraConfigFromEnv(env)),
                        webhookConfigured: Boolean(env.JIRA_WEBHOOK_SECRET),
                        pending: jira?.pending ?? 0, failed: jira?.failed ?? 0,
                },
        };
}

async function recoverStuckNotifications(db: D1Database): Promise<number> {
        const stuck = await db.prepare(`
                SELECT id, tenant_id, project_id, channel FROM channel_notification_outbox
                WHERE delivery_status = 'sending'
                        AND updated_at < datetime('now', '-15 minutes')
        `).all<{ id: number; tenant_id: number; project_id: number; channel: "whatsapp" | "teams" }>();
        for (const item of stuck.results) {
                await db.batch([
                        db.prepare(`UPDATE channel_notification_outbox SET delivery_status = 'failed', last_error = 'Recovered stale delivery lease', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND delivery_status = 'sending'`).bind(item.id),
                        db.prepare(`INSERT OR IGNORE INTO integration_operation_events (tenant_id, project_id, integration, event_type, event_key, details) VALUES (?, ?, ?, 'recovered', ?, 'Recovered stale notification delivery')`).bind(item.tenant_id, item.project_id, item.channel, `notification-recovered:${item.id}`),
                ]);
        }
        return stuck.results.length;
}

async function recordExhaustedNotifications(db: D1Database): Promise<number> {
        const exhausted = await db.prepare(`
                SELECT id, tenant_id, project_id, channel, last_error
                FROM channel_notification_outbox
                WHERE delivery_status = 'failed' AND attempt_count >= 5
        `).all<{ id: number; tenant_id: number; project_id: number; channel: "whatsapp" | "teams"; last_error: string | null }>();
        let recorded = 0;
        for (const item of exhausted.results) {
                const result = await db.prepare(`
                        INSERT OR IGNORE INTO integration_operation_events (
                                tenant_id, project_id, integration, event_type, event_key, details
                        ) VALUES (?, ?, ?, 'retry_exhausted', ?, ?)
                `).bind(item.tenant_id, item.project_id, item.channel, `notification-exhausted:${item.id}`, (item.last_error ?? "Delivery failed").slice(0, 500)).run();
                if (result.meta.changes) recorded += 1;
        }
        return recorded;
}

export async function recoverIntegrationPipeline(env: WorkerEnv, fetcher: Fetcher = fetch): Promise<PipelineRecoverySummary> {
        const recoveredNotifications = await recoverStuckNotifications(env.DB);
        const jiraConfig = jiraConfigFromEnv(env);
        const jira = jiraConfig
                ? await retryPendingJiraSyncs(env.DB, jiraConfig, fetcher, atlassianMcpConfigFromEnv(env))
                : { selected: 0, synced: 0, failed: 0, exhausted: 0 };
        const whatsappSent = await deliverPendingWhatsappNotifications(env, fetcher);
        const teamsSent = await deliverPendingTeamsNotifications(env, fetcher);
        const exhausted = await recordExhaustedNotifications(env.DB);
        return { jira, recoveredNotifications, whatsappSent, teamsSent, exhausted };
}
