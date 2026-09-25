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


interface ScheduledTeamMember extends TeamMember {
        timezone: string;
        working_days: string;
        initial_time: string;
        reminder_1_time: string;
        reminder_2_time: string;
}


export interface LocalScheduleDetails {
        date: string;
        time: string;
        weekday: string;
}


export interface ScheduleResult {
        status: "completed" | "disabled" | "ignored";
        selected: number;
        sent: number;
        failed: number;
}

export interface ManualStandupResult {
        selected: number;
        sent: number;
        skipped: number;
        failed: number;
}


const SCHEDULER_CRON = "*/15 * * * *";


export function getIstDate(
        timestamp: number,
): string {
        return getLocalScheduleDetails(
                timestamp,
                "Asia/Kolkata",
        ).date;
}


export function isIstWeekday(
        timestamp: number,
): boolean {
        const weekday = getLocalScheduleDetails(
                timestamp,
                "Asia/Kolkata",
        ).weekday;

        return weekday !== "SAT" && weekday !== "SUN";
}


export function getLocalScheduleDetails(
        timestamp: number,
        timezone: string,
): LocalScheduleDetails {
        const formatter = new Intl.DateTimeFormat(
                "en-CA",
                {
                        timeZone: timezone,
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                        weekday: "short",
                        hourCycle: "h23",
                },
        );

        const parts = formatter.formatToParts(
                new Date(timestamp),
        );

        const values = Object.fromEntries(
                parts.map((part) => [
                        part.type,
                        part.value,
                ]),
        );

        return {
                date:
                        `${values.year}-${values.month}-${values.day}`,
                time:
                        `${values.hour}:${values.minute}`,
                weekday: values.weekday.toUpperCase(),
        };
}


function actionForLocalTime(
        member: ScheduledTeamMember,
        localTime: string,
): ScheduledAction | null {
        if (localTime === member.initial_time) {
                return "initial";
        }

        if (localTime === member.reminder_1_time) {
                return "reminder-1";
        }

        if (localTime === member.reminder_2_time) {
                return "reminder-2";
        }

        return null;
}


function isWorkingDay(
        member: ScheduledTeamMember,
        weekday: string,
): boolean {
        const workingDays = member.working_days
                .split(",")
                .map((day) => day.trim().toUpperCase())
                .filter(Boolean);

        return workingDays.includes(weekday);
}


async function getScheduledMembers(
        db: D1Database,
): Promise<ScheduledTeamMember[]> {
        const result = await db
                .prepare(
                        `
                        SELECT
                                id,
                                name,
                                phone,
                                department,
                                timezone,
                                working_days,
                                initial_time,
                                reminder_1_time,
                                reminder_2_time
                        FROM team_members
                        WHERE active = 1
                                AND scheduling_enabled = 1
                        ORDER BY name
                        `,
                )
                .all<ScheduledTeamMember>();

        return result.results;
}


async function hasRepliedOnLocalDate(
        db: D1Database,
        member: ScheduledTeamMember,
        localDate: string,
): Promise<boolean> {
        const result = await db
                .prepare(
                        `
                        SELECT received_at
                        FROM incoming_messages
                        WHERE sender_phone = ?
                        ORDER BY received_at DESC
                        LIMIT 20
                        `,
                )
                .bind(member.phone)
                .all<{ received_at: string }>();

        return result.results.some((message) => {
                const timestamp = Date.parse(
                        message.received_at,
                );

                if (Number.isNaN(timestamp)) {
                        return false;
                }

                return getLocalScheduleDetails(
                        timestamp,
                        member.timezone,
                ).date === localDate;
        });
}


async function wasAlreadySent(
        db: D1Database,
        memberId: number,
        action: ScheduledAction,
        localDate: string,
): Promise<boolean> {
        const existing = await db
                .prepare(
                        `
                        SELECT id
                        FROM sent_messages
                        WHERE team_member_id = ?
                                AND message_type = ?
                                AND scheduled_for = ?
                                AND status IN (
                                        'submitted',
                                        'sent',
                                        'delivered',
                                        'read'
                                )
                        LIMIT 1
                        `,
                )
                .bind(
                        memberId,
                        action,
                        localDate,
                )
                .first<{ id: number }>();

        return existing !== null;
}


async function recordSendAttempt(
        env: WorkerEnv,
        member: ScheduledTeamMember,
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
        if (cron !== SCHEDULER_CRON) {
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
                        selected: 0,
                        sent: 0,
                        failed: 0,
                };
        }

        const members = await getScheduledMembers(
                env.DB,
        );

        const sentAt = new Date(
                scheduledTime,
        ).toISOString();

        let selected = 0;
        let sent = 0;
        let failed = 0;

        for (const member of members) {
                let localSchedule: LocalScheduleDetails;

                try {
                        localSchedule =
                                getLocalScheduleDetails(
                                        scheduledTime,
                                        member.timezone,
                                );
                } catch {
                        failed += 1;
                        continue;
                }

                if (
                        !isWorkingDay(
                                member,
                                localSchedule.weekday,
                        )
                ) {
                        continue;
                }

                const action = actionForLocalTime(
                        member,
                        localSchedule.time,
                );

                if (!action) {
                        continue;
                }

                if (
                        action !== "initial"
                        && await hasRepliedOnLocalDate(
                                env.DB,
                                member,
                                localSchedule.date,
                        )
                ) {
                        continue;
                }

                if (
                        await wasAlreadySent(
                                env.DB,
                                member.id,
                                action,
                                localSchedule.date,
                        )
                ) {
                        continue;
                }

                selected += 1;

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
                        localSchedule.date,
                        sentAt,
                        sendResult.success,
                        sendResult.messageId,
                        sendResult.error,
                );
        }

        return {
                status: "completed",
                selected,
                sent,
                failed,
        };
}

export async function runProjectInitialNow(
        env: WorkerEnv,
        tenantId: number,
        projectId: number,
        scheduledTime = Date.now(),
        fetcher: Fetcher = fetch,
): Promise<ManualStandupResult> {
        const result = await env.DB.prepare(`
                SELECT member.id, member.name, member.phone, member.department,
                        member.timezone, member.working_days, member.initial_time,
                        member.reminder_1_time, member.reminder_2_time
                FROM team_members AS member
                WHERE member.tenant_id = ?
                        AND member.active = 1
                        AND member.scheduling_enabled = 1
                        AND member.phone NOT LIKE 'pending-%'
                        AND (
                                member.primary_project_id = ?
                                OR EXISTS (
                                        SELECT 1 FROM team_member_projects AS membership
                                        WHERE membership.team_member_id = member.id
                                                AND membership.project_id = ?
                                )
                        )
                ORDER BY member.name
        `).bind(tenantId, projectId, projectId).all<ScheduledTeamMember>();

        const members = result.results;
        let sent = 0;
        let skipped = 0;
        let failed = 0;
        const sentAt = new Date(scheduledTime).toISOString();

        for (const member of members) {
                let localDate: string;
                try {
                        localDate = getLocalScheduleDetails(scheduledTime, member.timezone).date;
                } catch {
                        failed += 1;
                        continue;
                }

                if (await wasAlreadySent(env.DB, member.id, "initial", localDate)) {
                        skipped += 1;
                        continue;
                }

                const sendResult = await sendInitialRequest(env, member, fetcher);
                sendResult.success ? sent += 1 : failed += 1;
                await recordSendAttempt(
                        env, member, "initial", localDate, sentAt,
                        sendResult.success, sendResult.messageId, sendResult.error,
                );
        }

        return { selected: members.length, sent, skipped, failed };
}
