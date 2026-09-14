import type { WorkerEnv } from "./env";
import {
        sendInitialRequest,
        sendReminder,
        type Fetcher,
        type TeamMember,
} from "./whatsapp";


export type ScheduledAction =
        | "initial"
        | "reminder-1"
        | "reminder-2";


export interface ScheduleResult {
        status: "completed" | "disabled" | "ignored";
        action?: ScheduledAction;
        selected: number;
        sent: number;
        failed: number;
}


export function actionForCron(
        cron: string,
): ScheduledAction | null {
        const actions: Record<string, ScheduledAction> = {
                "30 6 * * MON-FRI": "initial",
                "30 9 * * MON-FRI": "reminder-1",
                "30 12 * * MON-FRI": "reminder-2",
        };

        return actions[cron] ?? null;
}


export function getIstDate(
        timestamp: number,
): string {
        const istOffsetMilliseconds =
                5.5 * 60 * 60 * 1000;

        return new Date(
                timestamp + istOffsetMilliseconds,
        )
                .toISOString()
                .slice(0, 10);
}


export function isIstWeekday(
        timestamp: number,
): boolean {
        const weekday = new Intl.DateTimeFormat(
                "en-US",
                {
                        timeZone: "Asia/Kolkata",
                        weekday: "short",
                },
        ).format(new Date(timestamp));

        return weekday !== "Sat" && weekday !== "Sun";
}


async function getActiveMembers(
        db: D1Database,
): Promise<TeamMember[]> {
        const result = await db
                .prepare(
                        `
                        SELECT id, name, phone, department
                        FROM team_members
                        WHERE active = 1
                        ORDER BY name
                        `,
                )
                .all<TeamMember>();

        return result.results;
}


async function getPendingMembers(
        db: D1Database,
        istDate: string,
): Promise<TeamMember[]> {
        const result = await db
                .prepare(
                        `
                        SELECT
                                member.id,
                                member.name,
                                member.phone,
                                member.department
                        FROM team_members AS member
                        WHERE member.active = 1
                                AND NOT EXISTS (
                                        SELECT 1
                                        FROM incoming_messages AS incoming
                                        WHERE incoming.sender_phone = member.phone
                                                AND date(
                                                        incoming.received_at,
                                                        '+5 hours',
                                                        '+30 minutes'
                                                ) = ?
                                )
                        ORDER BY member.name
                        `,
                )
                .bind(istDate)
                .all<TeamMember>();

        return result.results;
}


async function recordSendAttempt(
        env: WorkerEnv,
        member: TeamMember,
        action: ScheduledAction,
        scheduledFor: string,
        sentAt: string,
        success: boolean,
        messageId?: string,
        error?: string,
): Promise<void> {
        await env.DB
                .prepare(
                        `
                        INSERT INTO sent_messages (
                                team_member_id,
                                whatsapp_message_id,
                                message_type,
                                scheduled_for,
                                sent_at,
                                status,
                                error_message
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        `,
                )
                .bind(
                        member.id,
                        messageId ?? null,
                        action,
                        scheduledFor,
                        sentAt,
                        success ? "sent" : "failed",
                        error ?? null,
                )
                .run();
}


export async function runScheduledAction(
        cron: string,
        scheduledTime: number,
        env: WorkerEnv,
        fetcher: Fetcher = fetch,
): Promise<ScheduleResult> {
        const action = actionForCron(cron);

        if (!action || !isIstWeekday(scheduledTime)) {
                return {
                        status: "ignored",
                        selected: 0,
                        sent: 0,
                        failed: 0,
                };
        }

        if (env.AUTOMATION_ENABLED !== "true") {
                return {
                        status: "disabled",
                        action,
                        selected: 0,
                        sent: 0,
                        failed: 0,
                };
        }

        const istDate = getIstDate(scheduledTime);
        const sentAt = new Date(
                scheduledTime,
        ).toISOString();

        const members =
                action === "initial"
                        ? await getActiveMembers(env.DB)
                        : await getPendingMembers(
                                env.DB,
                                istDate,
                        );

        let sent = 0;
        let failed = 0;

        for (const member of members) {
                const sendResult =
                        action === "initial"
                                ? await sendInitialRequest(
                                                env,
                                                member,
                                                fetcher,
                                        )
                                : await sendReminder(
                                                env,
                                                member,
                                                action === "reminder-1"
                                                        ? 1
                                                        : 2,
                                                fetcher,
                                        );

                if (sendResult.success) {
                        sent += 1;
                } else {
                        failed += 1;
                }

                await recordSendAttempt(
                        env,
                        member,
                        action,
                        istDate,
                        sentAt,
                        sendResult.success,
                        sendResult.messageId,
                        sendResult.error,
                );
        }

        return {
                status: "completed",
                action,
                selected: members.length,
                sent,
                failed,
        };
}