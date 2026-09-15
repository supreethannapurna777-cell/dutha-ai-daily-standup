import type { WorkerEnv } from "./env";
import {
        sendAvailabilityRequest,
        type Fetcher,
        type TeamMember,
} from "./whatsapp";


interface AvailabilityRecipient extends TeamMember {
        timezone: string;
}


interface AvailabilityOption {
        id: number;
        starts_at: string;
}


export interface AvailabilityNotificationResult {
        attempted: number;
        sent: number;
        failed: number;
        skipped: number;
        error?: string;
}


function optionsForTimezone(
        options: AvailabilityOption[],
        timezone: string,
): string {
        return options.map(
                (option, index) => {
                        const localTime = new Date(
                                option.starts_at,
                        ).toLocaleString(
                                "en-IN",
                                {
                                        timeZone: timezone,
                                        dateStyle: "medium",
                                        timeStyle: "short",
                                },
                        );

                        return `${index + 1}. ${localTime}`;
                },
        ).join("\n");
}


async function alreadySent(
        db: D1Database,
        memberId: number,
        notificationKey: string,
): Promise<boolean> {
        const existing = await db
                .prepare(
                        `
                        SELECT 1 AS found
                        FROM sent_messages
                        WHERE team_member_id = ?
                                AND message_type
                                        = 'availability_request'
                                AND scheduled_for = ?
                                AND status = 'sent'
                        LIMIT 1
                        `,
                )
                .bind(
                        memberId,
                        notificationKey,
                )
                .first<{ found: number }>();

        return Boolean(existing);
}


async function recordSend(
        db: D1Database,
        memberId: number,
        notificationKey: string,
        messageId: string | undefined,
        success: boolean,
        error: string | undefined,
        now: Date,
): Promise<void> {
        await db
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
                        memberId,
                        messageId ?? null,
                        "availability_request",
                        notificationKey,
                        now.toISOString(),
                        success ? "sent" : "failed",
                        error ?? null,
                )
                .run();
}


export async function sendCaseAvailabilityRequests(
        env: WorkerEnv,
        caseId: number,
        fetcher: Fetcher = fetch,
        now = new Date(),
): Promise<AvailabilityNotificationResult> {
        const recipients = await env.DB
                .prepare(
                        `
                        SELECT
                                member.id,
                                member.name,
                                member.phone,
                                member.department,
                                member.timezone
                        FROM coordination_cases
                                AS coordination
                        INNER JOIN team_members AS member
                                ON member.id IN (
                                        coordination.requester_member_id,
                                        coordination.responsible_member_id
                                )
                        WHERE coordination.id = ?
                                AND coordination.status
                                        = 'availability_requested'
                                AND member.active = 1
                        ORDER BY
                                CASE
                                        WHEN member.id
                                                = coordination.requester_member_id
                                                THEN 0
                                        ELSE 1
                                END
                        `,
                )
                .bind(caseId)
                .all<AvailabilityRecipient>();

        const options = await env.DB
                .prepare(
                        `
                        SELECT id, starts_at
                        FROM case_time_options
                        WHERE case_id = ?
                                AND status = 'proposed'
                        ORDER BY starts_at
                        `,
                )
                .bind(caseId)
                .all<AvailabilityOption>();

        const result: AvailabilityNotificationResult = {
                attempted: 0,
                sent: 0,
                failed: 0,
                skipped: 0,
        };

        if (
                recipients.results.length !== 2
                || options.results.length < 2
        ) {
                return {
                        ...result,
                        error:
                                "The case does not have two active participants and at least two proposed times.",
                };
        }

        if (!env.WHATSAPP_AVAILABILITY_TEMPLATE_NAME) {
                return {
                        ...result,
                        skipped: recipients.results.length,
                        error:
                                "The WhatsApp availability template is not configured.",
                };
        }

        const notificationKey =
                `case:${caseId}:options:`
                + options.results
                        .map((option) => option.id)
                        .join("-");

        for (const recipient of recipients.results) {
                if (
                        await alreadySent(
                                env.DB,
                                recipient.id,
                                notificationKey,
                        )
                ) {
                        result.skipped += 1;
                        continue;
                }

                result.attempted += 1;

                try {
                        const sent = await sendAvailabilityRequest(
                                env,
                                recipient,
                                caseId,
                                optionsForTimezone(
                                        options.results,
                                        recipient.timezone,
                                ),
                                fetcher,
                        );

                        await recordSend(
                                env.DB,
                                recipient.id,
                                notificationKey,
                                sent.messageId,
                                sent.success,
                                sent.error,
                                now,
                        );

                        if (sent.success) {
                                result.sent += 1;
                        } else {
                                result.failed += 1;
                        }
                } catch (error) {
                        const message =
                                error instanceof Error
                                        ? error.message
                                        : "Unknown WhatsApp error";

                        await recordSend(
                                env.DB,
                                recipient.id,
                                notificationKey,
                                undefined,
                                false,
                                message,
                                now,
                        );

                        result.failed += 1;
                }
        }

        await env.DB
                .prepare(
                        `
                        INSERT INTO case_events (
                                case_id,
                                event_type,
                                actor_type,
                                details
                        )
                        VALUES (?, ?, 'system', ?)
                        `,
                )
                .bind(
                        caseId,
                        "availability_requests_sent",
                        `${result.sent} sent, ${result.failed} failed, ${result.skipped} skipped`,
                )
                .run();

        return result;
}
