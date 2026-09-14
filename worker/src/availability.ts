interface CoordinationCase {
        id: number;
        requester_member_id: number;
        responsible_member_id: number | null;
        meeting_duration_minutes: number;
        status: string;
}


interface TimeOption {
        id: number;
        starts_at: string;
}


interface CaseMember {
        id: number;
        timezone: string;
}


export interface ProposalResult {
        success: boolean;
        created: number;
        error?: string;
}


export interface AvailabilityResult {
        success: boolean;
        matched: boolean;
        matchedTime?: string;
        error?: string;
}


const allowedDurations = new Set([
        15,
        20,
        30,
        45,
        60,
]);


async function getCase(
        db: D1Database,
        caseId: number,
): Promise<CoordinationCase | null> {
        return db
                .prepare(
                        `
                        SELECT
                                id,
                                requester_member_id,
                                responsible_member_id,
                                meeting_duration_minutes,
                                status
                        FROM coordination_cases
                        WHERE id = ?
                        `,
                )
                .bind(caseId)
                .first<CoordinationCase>();
}


async function getMember(
        db: D1Database,
        memberId: number,
): Promise<CaseMember | null> {
        return db
                .prepare(
                        `
                        SELECT id, timezone
                        FROM team_members
                        WHERE id = ?
                                AND active = 1
                        `,
                )
                .bind(memberId)
                .first<CaseMember>();
}


function normaliseTimes(
        startsAt: string[],
        now: Date,
): string[] | null {
        const normalised = [
                ...new Set(
                        startsAt.map(
                                (value) =>
                                        value.trim(),
                        ),
                ),
        ];

        if (
                normalised.length < 2
                || normalised.length > 6
        ) {
                return null;
        }

        const valid = normalised.every(
                (value) => {
                        const timestamp =
                                Date.parse(value);

                        if (
                                Number.isNaN(timestamp)
                                || timestamp
                                        <= now.getTime()
                        ) {
                                return false;
                        }

                        const date =
                                new Date(timestamp);

                        return date.getUTCSeconds() === 0
                                && date.getUTCMilliseconds()
                                        === 0
                                && date.getUTCMinutes()
                                        % 15 === 0;
                },
        );

        if (!valid) {
                return null;
        }

        return normalised
                .map(
                        (value) =>
                                new Date(
                                        Date.parse(value),
                                ).toISOString(),
                )
                .sort();
}


async function recordEvent(
        db: D1Database,
        caseId: number,
        eventType: string,
        actorType:
                | "system"
                | "manager"
                | "member",
        actorMemberId: number | null,
        details: string,
): Promise<void> {
        await db
                .prepare(
                        `
                        INSERT INTO case_events (
                                case_id,
                                event_type,
                                actor_type,
                                actor_member_id,
                                details
                        )
                        VALUES (?, ?, ?, ?, ?)
                        `,
                )
                .bind(
                        caseId,
                        eventType,
                        actorType,
                        actorMemberId,
                        details,
                )
                .run();
}


export async function proposeCaseTimes(
        db: D1Database,
        caseId: number,
        startsAt: string[],
        createdBy:
                | "system"
                | "manager" = "manager",
        now = new Date(),
): Promise<ProposalResult> {
        const coordinationCase =
                await getCase(db, caseId);

        if (!coordinationCase) {
                return {
                        success: false,
                        created: 0,
                        error:
                                "Coordination case was not found.",
                };
        }

        if (
                !coordinationCase.responsible_member_id
        ) {
                return {
                        success: false,
                        created: 0,
                        error:
                                "Assign a responsible person first.",
                };
        }

        if (
                ![
                        "approved",
                        "availability_requested",
                ].includes(
                        coordinationCase.status,
                )
        ) {
                return {
                        success: false,
                        created: 0,
                        error:
                                "The case must be approved before proposing times.",
                };
        }

        if (
                !allowedDurations.has(
                        coordinationCase
                                .meeting_duration_minutes,
                )
        ) {
                return {
                        success: false,
                        created: 0,
                        error:
                                "The case has an invalid duration.",
                };
        }

        const times = normaliseTimes(
                startsAt,
                now,
        );

        if (!times) {
                return {
                        success: false,
                        created: 0,
                        error:
                                "Provide between two and six future 15-minute time options.",
                };
        }

        let created = 0;

        for (const startsAtValue of times) {
                const result = await db
                        .prepare(
                                `
                                INSERT OR IGNORE INTO case_time_options (
                                        case_id,
                                        starts_at,
                                        duration_minutes,
                                        status,
                                        created_by
                                )
                                VALUES (?, ?, ?, 'proposed', ?)
                                `,
                        )
                        .bind(
                                caseId,
                                startsAtValue,
                                coordinationCase
                                        .meeting_duration_minutes,
                                createdBy,
                        )
                        .run();

                created += result.meta.changes;
        }

        await db
                .prepare(
                        `
                        UPDATE coordination_cases
                        SET
                                status = 'availability_requested',
                                updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                        `,
                )
                .bind(caseId)
                .run();

        await recordEvent(
                db,
                caseId,
                "availability_requested",
                createdBy,
                null,
                `${times.length} discussion times proposed`,
        );

        return {
                success: true,
                created,
        };
}


async function getOptions(
        db: D1Database,
        caseId: number,
        optionIds: number[],
): Promise<TimeOption[]> {
        if (optionIds.length === 0) {
                return [];
        }

        const placeholders =
                optionIds.map(() => "?").join(",");

        const result = await db
                .prepare(
                        `
                        SELECT id, starts_at
                        FROM case_time_options
                        WHERE case_id = ?
                                AND status IN (
                                        'proposed',
                                        'matched',
                                        'selected'
                                )
                                AND id IN (
                                        ${placeholders}
                                )
                        ORDER BY starts_at
                        `,
                )
                .bind(
                        caseId,
                        ...optionIds,
                )
                .all<TimeOption>();

        return result.results;
}


async function findCommonTime(
        db: D1Database,
        coordinationCase: CoordinationCase,
): Promise<string | null> {
        if (
                !coordinationCase
                        .responsible_member_id
        ) {
                return null;
        }

        const match = await db
                .prepare(
                        `
                        SELECT
                                availability.available_at,
                                COUNT(
                                        DISTINCT availability.member_id
                                ) AS member_count
                        FROM case_availability
                                AS availability
                        WHERE availability.case_id = ?
                                AND availability.member_id
                                        IN (?, ?)
                        GROUP BY
                                availability.available_at
                        HAVING member_count = 2
                        ORDER BY
                                availability.available_at
                        LIMIT 1
                        `,
                )
                .bind(
                        coordinationCase.id,
                        coordinationCase
                                .requester_member_id,
                        coordinationCase
                                .responsible_member_id,
                )
                .first<{
                        available_at: string;
                        member_count: number;
                }>();

        return match?.available_at ?? null;
}


export async function recordMemberAvailability(
        db: D1Database,
        caseId: number,
        memberId: number,
        optionIds: number[],
): Promise<AvailabilityResult> {
        const coordinationCase =
                await getCase(db, caseId);

        if (!coordinationCase) {
                return {
                        success: false,
                        matched: false,
                        error:
                                "Coordination case was not found.",
                };
        }

        if (
                coordinationCase.status
                        !== "availability_requested"
                && coordinationCase.status
                        !== "time_agreed"
        ) {
                return {
                        success: false,
                        matched: false,
                        error:
                                "Availability is not currently being collected.",
                };
        }

        if (
                memberId
                        !== coordinationCase
                                .requester_member_id
                && memberId
                        !== coordinationCase
                                .responsible_member_id
        ) {
                return {
                        success: false,
                        matched: false,
                        error:
                                "This member is not part of the case.",
                };
        }

        const member =
                await getMember(db, memberId);

        if (!member) {
                return {
                        success: false,
                        matched: false,
                        error:
                                "The member was not found.",
                };
        }

        const uniqueOptionIds = [
                ...new Set(optionIds),
        ].filter(
                (value) =>
                        Number.isInteger(value)
                        && value > 0,
        );

        const options = await getOptions(
                db,
                caseId,
                uniqueOptionIds,
        );

        if (
                options.length === 0
                || options.length
                        !== uniqueOptionIds.length
        ) {
                return {
                        success: false,
                        matched: false,
                        error:
                                "Select one or more valid time options.",
                };
        }

        const statements: D1PreparedStatement[] = [
                db
                        .prepare(
                                `
                                DELETE FROM case_availability
                                WHERE case_id = ?
                                        AND member_id = ?
                                `,
                        )
                        .bind(
                                caseId,
                                memberId,
                        ),
        ];

        for (const option of options) {
                statements.push(
                        db
                                .prepare(
                                        `
                                        INSERT INTO case_availability (
                                                case_id,
                                                member_id,
                                                available_at,
                                                timezone,
                                                selected
                                        )
                                        VALUES (?, ?, ?, ?, 0)
                                        `,
                                )
                                .bind(
                                        caseId,
                                        memberId,
                                        option.starts_at,
                                        member.timezone,
                                ),
                );
        }

        await db.batch(statements);

        await recordEvent(
                db,
                caseId,
                "availability_submitted",
                "member",
                memberId,
                `${options.length} time options selected`,
        );

        const matchedTime =
                await findCommonTime(
                        db,
                        coordinationCase,
                );

        if (!matchedTime) {
                return {
                        success: true,
                        matched: false,
                };
        }

        await db.batch([
                db
                        .prepare(
                                `
                                UPDATE case_time_options
                                SET status =
                                        CASE
                                                WHEN starts_at = ?
                                                        THEN 'selected'
                                                ELSE 'cancelled'
                                        END
                                WHERE case_id = ?
                                        AND status IN (
                                                'proposed',
                                                'matched',
                                                'selected'
                                        )
                                `,
                        )
                        .bind(
                                matchedTime,
                                caseId,
                        ),
                db
                        .prepare(
                                `
                                UPDATE case_availability
                                SET selected =
                                        CASE
                                                WHEN available_at = ?
                                                        THEN 1
                                                ELSE 0
                                        END
                                WHERE case_id = ?
                                `,
                        )
                        .bind(
                                matchedTime,
                                caseId,
                        ),
                db
                        .prepare(
                                `
                                UPDATE coordination_cases
                                SET
                                        proposed_time = ?,
                                        status = 'time_agreed',
                                        updated_at =
                                                CURRENT_TIMESTAMP
                                WHERE id = ?
                                `,
                        )
                        .bind(
                                matchedTime,
                                caseId,
                        ),
        ]);

        await recordEvent(
                db,
                caseId,
                "common_time_matched",
                "system",
                null,
                `Common time matched: ${matchedTime}`,
        );

        return {
                success: true,
                matched: true,
                matchedTime,
        };
}