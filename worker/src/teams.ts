import { createRemoteJWKSet, jwtVerify } from "jose";
import type { WorkerEnv } from "./env";
import { processChannelEnrolment, resolveChannelIdentity } from "./enrolment";
import { processResolutionReply } from "./resolution-reply";
import { processInboundTextMessage } from "./workflow";
import type { Fetcher } from "./whatsapp";

const botFrameworkKeys = createRemoteJWKSet(
        new URL("https://login.botframework.com/v1/.well-known/keys"),
);

interface TeamsActivity {
        type?: string;
        id?: string;
        timestamp?: string;
        serviceUrl?: string;
        channelId?: string;
        text?: string;
        from?: { id?: string; name?: string; aadObjectId?: string };
        recipient?: { id?: string; name?: string };
        conversation?: { id?: string; tenantId?: string };
        channelData?: { tenant?: { id?: string } };
}

export type TeamsTokenVerifier = (
        token: string,
        appId: string,
        serviceUrl: string,
) => Promise<boolean>;

export async function verifyTeamsToken(
        token: string,
        appId: string,
        serviceUrl: string,
): Promise<boolean> {
        try {
                const result = await jwtVerify(token, botFrameworkKeys, {
                        issuer: "https://api.botframework.com",
                        audience: appId,
                        algorithms: ["RS256"],
                });
                const claimedService = typeof result.payload.serviceurl === "string"
                        ? result.payload.serviceurl.replace(/\/+$/, "")
                        : "";
                return !claimedService || claimedService === serviceUrl.replace(/\/+$/, "");
        } catch {
                return false;
        }
}

function bearerToken(request: Request): string {
        return request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
}

function cleanText(text: string): string {
        return text.replace(/<at>.*?<\/at>/gi, "").replace(/&nbsp;/gi, " ").trim();
}

async function botAccessToken(env: WorkerEnv, fetcher: Fetcher): Promise<string> {
        if (!env.MICROSOFT_APP_ID || !env.MICROSOFT_APP_PASSWORD) throw new Error("Teams bot credentials are missing");
        const tenant = env.MICROSOFT_TENANT_ID?.trim() || "botframework.com";
        const body = new URLSearchParams({
                grant_type: "client_credentials",
                client_id: env.MICROSOFT_APP_ID,
                client_secret: env.MICROSOFT_APP_PASSWORD,
                scope: "https://api.botframework.com/.default",
        });
        const response = await fetcher(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body,
        });
        if (!response.ok) throw new Error(`Teams token request failed: ${response.status}`);
        const value = await response.json<{ access_token?: string }>();
        if (!value.access_token) throw new Error("Teams token response was incomplete");
        return value.access_token;
}

async function sendTeamsActivity(
        env: WorkerEnv,
        reference: { serviceUrl: string; conversationId: string; botId: string; userId: string },
        text: string,
        fetcher: Fetcher,
): Promise<void> {
        const token = await botAccessToken(env, fetcher);
        const response = await fetcher(
                `${reference.serviceUrl.replace(/\/+$/, "")}/v3/conversations/${encodeURIComponent(reference.conversationId)}/activities`,
                {
                        method: "POST",
                        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                        body: JSON.stringify({
                                type: "message", text,
                                from: { id: reference.botId },
                                recipient: { id: reference.userId },
                                conversation: { id: reference.conversationId },
                        }),
                },
        );
        if (!response.ok) throw new Error(`Teams message failed: ${response.status}`);
}

async function saveConversation(db: D1Database, identity: {
        tenantId: number; teamMemberId: number;
}, activity: TeamsActivity): Promise<void> {
        await db.prepare(`
                INSERT INTO teams_conversation_references (
                        tenant_id, team_member_id, service_url, conversation_id,
                        bot_id, user_id, tenant_external_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(team_member_id) DO UPDATE SET
                        service_url = excluded.service_url,
                        conversation_id = excluded.conversation_id,
                        bot_id = excluded.bot_id, user_id = excluded.user_id,
                        tenant_external_id = excluded.tenant_external_id,
                        updated_at = CURRENT_TIMESTAMP
        `).bind(
                identity.tenantId, identity.teamMemberId, activity.serviceUrl,
                activity.conversation?.id, activity.recipient?.id, activity.from?.id,
                activity.channelData?.tenant?.id ?? activity.conversation?.tenantId ?? null,
        ).run();
}

export async function teamsWebhookResponse(
        request: Request,
        env: WorkerEnv,
        fetcher: Fetcher = fetch,
        verifier: TeamsTokenVerifier = verifyTeamsToken,
): Promise<Response> {
        if (!env.MICROSOFT_APP_ID) return Response.json({ error: "Teams is not configured" }, { status: 503 });
        let activity: TeamsActivity;
        try { activity = await request.json<TeamsActivity>(); }
        catch { return Response.json({ error: "Invalid JSON payload" }, { status: 400 }); }
        const serviceUrl = activity.serviceUrl?.trim() ?? "";
        const token = bearerToken(request);
        if (!token || !serviceUrl || !(await verifier(token, env.MICROSOFT_APP_ID, serviceUrl))) {
                return Response.json({ error: "Invalid Teams activity token" }, { status: 401 });
        }
        if (activity.type !== "message") return new Response(null, { status: 202 });
        const externalMessageId = activity.id?.trim() ?? "";
        const senderId = activity.from?.id?.trim() ?? "";
        const conversationId = activity.conversation?.id?.trim() ?? "";
        const botId = activity.recipient?.id?.trim() ?? "";
        const text = cleanText(activity.text ?? "");
        if (!externalMessageId || !senderId || !conversationId || !botId || !text) {
                return Response.json({ error: "Incomplete Teams activity" }, { status: 400 });
        }
        const directReference = { serviceUrl, conversationId, botId, userId: senderId };
        const enrolment = await processChannelEnrolment(
                env.DB, "teams", senderId, activity.from?.name ?? "Teams user",
                externalMessageId, text,
        );
        if (enrolment.handled) {
                if (!enrolment.duplicate && enrolment.message) await sendTeamsActivity(env, directReference, enrolment.message, fetcher);
                if (enrolment.success) {
                        const joined = await resolveChannelIdentity(env.DB, "teams", senderId);
                        if (joined) await saveConversation(env.DB, joined, activity);
                }
                return new Response(null, { status: 202 });
        }
        const identity = await resolveChannelIdentity(env.DB, "teams", senderId);
        if (!identity) {
                await sendTeamsActivity(env, directReference, "This Teams account is not connected to Dutha. Send JOIN <code> <work-email>.", fetcher);
                return new Response(null, { status: 202 });
        }
        await saveConversation(env.DB, identity, activity);
        const workflow = await processInboundTextMessage(env.DB, {
                channel: "teams", externalMessageId, senderExternalId: senderId,
                receivedAt: activity.timestamp ?? new Date().toISOString(), text, identity,
        }, async (message) => {
                const resolution = await processResolutionReply(env.DB, message);
                if (resolution.handled && resolution.response) await sendTeamsActivity(env, directReference, resolution.response, fetcher);
                return resolution;
        });
        return Response.json({ status: workflow.status }, { status: 202 });
}

export async function deliverPendingTeamsNotifications(env: WorkerEnv, fetcher: Fetcher = fetch): Promise<number> {
        const pending = await env.DB.prepare(`
                SELECT outbox.id, outbox.message, reference.service_url,
                        reference.conversation_id, reference.bot_id, reference.user_id
                FROM channel_notification_outbox AS outbox
                INNER JOIN teams_conversation_references AS reference
                        ON reference.team_member_id = outbox.team_member_id
                        AND reference.tenant_id = outbox.tenant_id
                WHERE outbox.channel = 'teams' AND outbox.delivery_status IN ('pending', 'failed')
                        AND outbox.attempt_count < 5 ORDER BY outbox.created_at LIMIT 20
        `).all<{ id: number; message: string; service_url: string; conversation_id: string; bot_id: string; user_id: string }>();
        let sent = 0;
        for (const item of pending.results) {
                await env.DB.prepare(`UPDATE channel_notification_outbox SET delivery_status = 'sending', attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(item.id).run();
                try {
                        await sendTeamsActivity(env, { serviceUrl: item.service_url, conversationId: item.conversation_id, botId: item.bot_id, userId: item.user_id }, item.message, fetcher);
                        await env.DB.prepare(`UPDATE channel_notification_outbox SET delivery_status = 'sent', last_error = NULL, sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(item.id).run();
                        sent += 1;
                } catch (error) {
                        await env.DB.prepare(`UPDATE channel_notification_outbox SET delivery_status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(error instanceof Error ? error.message.slice(0, 500) : "Teams delivery failed", item.id).run();
                }
        }
        return sent;
}
