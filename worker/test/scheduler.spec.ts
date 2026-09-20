import { env } from "cloudflare:test";
import {
        beforeEach,
        describe,
        expect,
        it,
        vi,
} from "vitest";

import type { WorkerEnv } from "../src/env";
import {
        getIstDate,
        getLocalScheduleDetails,
        isIstWeekday,
        runProjectInitialNow,
        runScheduledAction,
} from "../src/scheduler";


const schedulerCron = "*/15 * * * *";

const indiaInitialTime = Date.parse(
        "2026-09-14T06:30:00.000Z",
);


function schedulerEnv(
        enabled: "true" | "false",
): WorkerEnv {
        return {
                ...env,
                WHATSAPP_API_VERSION: "v26.0",
                WHATSAPP_TEMPLATE_LANGUAGE: "en_US",
                WHATSAPP_INITIAL_TEMPLATE_NAME:
                        "daily_standup_request",
                WHATSAPP_REMINDER_TEMPLATE_NAME:
                        "daily_standup_reminder",
                WHATSAPP_ACCESS_TOKEN: "test-token",
                WHATSAPP_PHONE_NUMBER_ID: "123456789",
                WHATSAPP_WEBHOOK_VERIFY_TOKEN:
                        "verify-token",
                WHATSAPP_APP_SECRET: "app-secret",
                AUTOMATION_ENABLED: enabled,
                DASHBOARD_USERNAME: "admin",
                DASHBOARD_PASSWORD: "password",
        };
}


interface MemberOptions {
        timezone?: string;
        workingDays?: string;
        initialTime?: string;
        reminder1Time?: string;
        reminder2Time?: string;
        schedulingEnabled?: number;
}


async function insertMember(
        name: string,
        phone: string,
        options: MemberOptions = {},
): Promise<void> {
        await env.DB
                .prepare(
                        `
                        INSERT INTO team_members (
                                name,
                                phone,
                                department,
                                timezone,
                                working_days,
                                initial_time,
                                reminder_1_time,
                                reminder_2_time,
                                scheduling_enabled
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `,
                )
                .bind(
                        name,
                        phone,
                        "Development",
                        options.timezone
                                ?? "Asia/Kolkata",
                        options.workingDays
                                ?? "MON,TUE,WED,THU,FRI",
                        options.initialTime
                                ?? "12:00",
                        options.reminder1Time
                                ?? "15:00",
                        options.reminder2Time
                                ?? "18:00",
                        options.schedulingEnabled
                                ?? 1,
                )
                .run();
}


function successfulFetcher() {
        return vi.fn(
                async (
                        _input:
                                | string
                                | URL
                                | Request,
                        _init?: RequestInit,
                ): Promise<Response> =>
                        Response.json({
                                messages: [
                                        {
                                                id: "wamid.sent",
                                        },
                                ],
                        }),
        );
}


describe("timezone-aware scheduled automation", () => {
        beforeEach(async () => {
                await env.DB.batch([
                        env.DB.prepare(
                                "DELETE FROM sent_messages",
                        ),
                        env.DB.prepare(
                                "DELETE FROM processed_updates",
                        ),
                        env.DB.prepare(
                                "DELETE FROM incoming_messages",
                        ),
                        env.DB.prepare(
                                "DELETE FROM team_members",
                        ),
                ]);
        });

        it("converts UTC into India local date and time", () => {
                const details =
                        getLocalScheduleDetails(
                                indiaInitialTime,
                                "Asia/Kolkata",
                        );

                expect(details).toEqual({
                        date: "2026-09-14",
                        time: "12:00",
                        weekday: "MON",
                });

                expect(
                        getIstDate(indiaInitialTime),
                ).toBe("2026-09-14");

                expect(
                        isIstWeekday(indiaInitialTime),
                ).toBe(true);
        });

        it("handles UK daylight saving automatically", () => {
                const winter =
                        getLocalScheduleDetails(
                                Date.parse(
                                        "2026-01-15T12:00:00.000Z",
                                ),
                                "Europe/London",
                        );

                const summer =
                        getLocalScheduleDetails(
                                Date.parse(
                                        "2026-07-15T11:00:00.000Z",
                                ),
                                "Europe/London",
                        );

                expect(winter.time).toBe("12:00");
                expect(summer.time).toBe("12:00");
        });

        it("ignores unsupported scheduler events", async () => {
                await insertMember(
                        "Supreeth",
                        "919100000000",
                );

                const fetcher = successfulFetcher();

                const result = await runScheduledAction(
                        "30 6 * * MON-FRI",
                        indiaInitialTime,
                        schedulerEnv("true"),
                        fetcher,
                );

                expect(result.status).toBe("ignored");
                expect(fetcher).not.toHaveBeenCalled();
        });

        it("sends nothing while automation is disabled", async () => {
                await insertMember(
                        "Supreeth",
                        "919100000000",
                );

                const fetcher = successfulFetcher();

                const result = await runScheduledAction(
                        schedulerCron,
                        indiaInitialTime,
                        schedulerEnv("false"),
                        fetcher,
                );

                expect(result.status).toBe("disabled");
                expect(fetcher).not.toHaveBeenCalled();
        });

        it("sends at each member's configured local time", async () => {
                await insertMember(
                        "Supreeth",
                        "919100000000",
                );

                await insertMember(
                        "London Member",
                        "447700900000",
                        {
                                timezone:
                                        "Europe/London",
                                initialTime:
                                        "07:30",
                        },
                );

                const fetcher = successfulFetcher();

                const result = await runScheduledAction(
                        schedulerCron,
                        indiaInitialTime,
                        schedulerEnv("true"),
                        fetcher,
                );

                expect(result).toEqual({
                        status: "completed",
                        selected: 2,
                        sent: 2,
                        failed: 0,
                });

                expect(fetcher).toHaveBeenCalledTimes(2);
        });

        it("does not send on a member's local non-working day", async () => {
                await insertMember(
                        "Supreeth",
                        "919100000000",
                );

                const fetcher = successfulFetcher();

                const result = await runScheduledAction(
                        schedulerCron,
                        Date.parse(
                                "2026-09-13T06:30:00.000Z",
                        ),
                        schedulerEnv("true"),
                        fetcher,
                );

                expect(result.selected).toBe(0);
                expect(fetcher).not.toHaveBeenCalled();
        });

        it("does not schedule messages for a paused member", async () => {
                await insertMember(
                        "Paused Member",
                        "919200000000",
                        {
                                schedulingEnabled: 0,
                        },
                );

                const fetcher = successfulFetcher();

                const result = await runScheduledAction(
                        schedulerCron,
                        indiaInitialTime,
                        schedulerEnv("true"),
                        fetcher,
                );

                expect(result.selected).toBe(0);
                expect(fetcher).not.toHaveBeenCalled();
        });

        it("manually sends once per member local date", async () => {
                await insertMember("Supreeth", "919100000000");
                await insertMember("Paused Member", "919200000000", { schedulingEnabled: 0 });
                const fetcher = successfulFetcher();

                const first = await runProjectInitialNow(
                        schedulerEnv("true"), 1, 1, indiaInitialTime, fetcher,
                );
                const second = await runProjectInitialNow(
                        schedulerEnv("true"), 1, 1, indiaInitialTime, fetcher,
                );

                expect(first).toEqual({ selected: 1, sent: 1, skipped: 0, failed: 0 });
                expect(second).toEqual({ selected: 1, sent: 0, skipped: 1, failed: 0 });
                expect(fetcher).toHaveBeenCalledTimes(1);
        });

        it("reminds only members who have not replied locally today", async () => {
                await insertMember(
                        "Supreeth",
                        "919100000000",
                );

                await insertMember(
                        "Kiran",
                        "919200000000",
                );

                await env.DB
                        .prepare(
                                `
                                INSERT INTO incoming_messages (
                                        whatsapp_message_id,
                                        received_at,
                                        sender_name,
                                        sender_phone,
                                        original_reply,
                                        processing_status
                                )
                                VALUES (?, ?, ?, ?, ?, ?)
                                `,
                        )
                        .bind(
                                "wamid.reply",
                                "2026-09-14T07:00:00.000Z",
                                "Supreeth",
                                "919100000000",
                                "Test reply",
                                "processed",
                        )
                        .run();

                const fetcher = successfulFetcher();

                const result = await runScheduledAction(
                        schedulerCron,
                        Date.parse(
                                "2026-09-14T09:30:00.000Z",
                        ),
                        schedulerEnv("true"),
                        fetcher,
                );

                expect(result.selected).toBe(1);
                expect(result.sent).toBe(1);
                expect(fetcher).toHaveBeenCalledTimes(1);

                const firstCall =
                        fetcher.mock.calls[0];

                expect(firstCall).toBeDefined();

                const requestOptions =
                        firstCall?.[1];

                const requestBody = JSON.parse(
                        String(
                                requestOptions?.body,
                        ),
                );

                expect(requestBody.to).toBe(
                        "919200000000",
                );
        });

        it("prevents a duplicate successful scheduled send", async () => {
                await insertMember(
                        "Supreeth",
                        "919100000000",
                );

                const fetcher = successfulFetcher();
                const workerEnv = schedulerEnv("true");

                const first = await runScheduledAction(
                        schedulerCron,
                        indiaInitialTime,
                        workerEnv,
                        fetcher,
                );

                const second = await runScheduledAction(
                        schedulerCron,
                        indiaInitialTime,
                        workerEnv,
                        fetcher,
                );

                expect(first.sent).toBe(1);
                expect(second.sent).toBe(0);
                expect(second.selected).toBe(0);
                expect(fetcher).toHaveBeenCalledTimes(1);

                const count = await env.DB
                        .prepare(
                                `
                                SELECT COUNT(*) AS count
                                FROM sent_messages
                                WHERE status = 'sent'
                                `,
                        )
                        .first<{ count: number }>();

                expect(count?.count).toBe(1);
        });
});
