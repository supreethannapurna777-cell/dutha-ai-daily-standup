interface SourceUpdate {
        id: number;
        sender_phone: string;
        blockers: string | null;
        dependencies: string | null;
        people_to_connect: string | null;
}


interface CaseMember {
        id: number;
        name: string;
}


export interface CoordinationCaseResult {
        created: boolean;
        caseId?: number;
        status?:
                | "pending_assignment"
                | "pending_approval";
}


const emptyValues = new Set([
        "",
        "none",
        "none mentioned",
        "not specified",
        "no",
        "nil",
        "n/a",
        "na",
]);


function normalise(value: string | null): string {
        return String(value ?? "")
                .trim()
                .toLowerCase();
}


function hasMeaningfulValue(
        value: string | null,
): boolean {
        return !emptyValues.has(
                normalise(value),
        );
}


function determinePriority(
        summary: string,
): "normal" | "high" | "critical" {
        const value = summary.toLowerCase();

        if (
                value.includes("production down")
                || value.includes("outage")
                || value.includes("security incident")
                || value.includes("data loss")
                || value.includes("critical")
        ) {
                return "critical";
        }

        if (
                value.includes("blocked")
                || value.includes("urgent")
                || value.includes("deadline")
                || value.includes("cannot proceed")
                || value.includes("can't proceed")
        ) {
                return "high";
        }

        return "normal";
}


function matchResponsibleMember(
        peopleToConnect: string | null,
        requesterId: number,
        members: CaseMember[],
): CaseMember | null {
        const requestedPeople =
                normalise(peopleToConnect);

        if (!hasMeaningfulValue(peopleToConnect)) {
                return null;
        }

        const matches = members
                .filter(
                        (member) =>
                                member.id !== requesterId,
                )
                .filter(
                        (member) =>
                                requestedPeople.includes(
                                        member.name
                                                .trim()
                                                .toLowerCase(),
                                ),
                )
                .sort(
                        (first, second) =>
                                second.name.length
                                - first.name.length,
                );

        return matches[0] ?? null;
}


async function getSourceUpdate(
        db: D1Database,
        processedUpdateId: number,
): Promise<SourceUpdate | null> {
        return db
                .prepare(
                        `
                        SELECT
                                processed.id,
                                incoming.sender_phone,
                                processed.blockers,
                                processed.dependencies,
                                processed.people_to_connect
                        FROM processed_updates AS processed
                        INNER JOIN incoming_messages AS incoming
                                ON incoming.id
                                        = processed.message_id
                        WHERE processed.id = ?
                        `,
                )
                .bind(processedUpdateId)
                .first<SourceUpdate>();
}


async function getRequester(
        db: D1Database,
        senderPhone: string,
): Promise<CaseMember | null> {
        return db
                .prepare(
                        `
                        SELECT id, name
                        FROM team_members
                        WHERE phone = ?
                                AND active = 1
                        LIMIT 1
                        `,
                )
                .bind(senderPhone)
                .first<CaseMember>();
}


async function getActiveMembers(
        db: D1Database,
): Promise<CaseMember[]> {
        const result = await db
                .prepare(
                        `
                        SELECT id, name
                        FROM team_members
                        WHERE active = 1
                        ORDER BY name
                        `,
                )
                .all<CaseMember>();

        return result.results;
}


export async function createCoordinationCase(
        db: D1Database,
        processedUpdateId: number,
): Promise<CoordinationCaseResult> {
        const source = await getSourceUpdate(
                db,
                processedUpdateId,
        );

        if (!source) {
                return { created: false };
        }

        const requester = await getRequester(
                db,
                source.sender_phone,
        );

        if (!requester) {
                return { created: false };
        }

        const hasBlocker =
                hasMeaningfulValue(source.blockers);

        const hasDependency =
                hasMeaningfulValue(
                        source.dependencies,
                );

        const hasCoordination =
                hasMeaningfulValue(
                        source.people_to_connect,
                );

        if (
                !hasBlocker
                && !hasDependency
                && !hasCoordination
        ) {
                return { created: false };
        }

        const caseType =
                hasBlocker
                        ? "blocker"
                        : hasDependency
                                ? "dependency"
                                : "coordination";

        const summary =
                hasBlocker
                        ? String(source.blockers)
                        : hasDependency
                                ? String(
                                        source.dependencies,
                                )
                                : String(
                                        source.people_to_connect,
                                );

        const members = await getActiveMembers(db);

        const responsible =
                matchResponsibleMember(
                        source.people_to_connect,
                        requester.id,
                        members,
                );

        const status =
                responsible
                        ? "pending_approval"
                        : "pending_assignment";

        const inserted = await db
                .prepare(
                        `
                        INSERT OR IGNORE INTO coordination_cases (
                                source_update_id,
                                requester_member_id,
                                responsible_member_id,
                                case_type,
                                issue_summary,
                                status,
                                priority
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        RETURNING id
                        `,
                )
                .bind(
                        source.id,
                        requester.id,
                        responsible?.id ?? null,
                        caseType,
                        summary,
                        status,
                        determinePriority(summary),
                )
                .first<{ id: number }>();

        if (!inserted) {
                return { created: false };
        }

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
                        inserted.id,
                        "case_created",
                        "system",
                        requester.id,
                        responsible
                                ? `Responsible member matched: ${
                                        responsible.name
                                }`
                                : "Responsible member requires manager assignment",
                )
                .run();

        return {
                created: true,
                caseId: inserted.id,
                status,
        };
}