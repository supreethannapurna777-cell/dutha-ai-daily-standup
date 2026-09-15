import {
        recordMemberAvailability,
} from "./availability";


interface MemberRow {
        id: number;
}


interface OptionRow {
        id: number;
}


export interface AvailabilityReplyResult {
        handled: boolean;
        success: boolean;
        matched: boolean;
        error?: string;
}


interface ParsedReply {
        caseId: number;
        optionNumbers: number[];
}


function parseAvailabilityReply(
        text: string,
): ParsedReply | null {
        const trimmed = text.trim();
        const match = /^CASE\s*#?\s*(\d+)\s*:\s*(.*)$/i
                .exec(trimmed);

        if (!match) {
                return /^CASE(?:\s|#|:)/i.test(trimmed)
                        ? {
                                caseId: 0,
                                optionNumbers: [],
                        }
                        : null;
        }

        const caseId = Number(match[1]);
        const rawOptions = match[2]
                .split(",")
                .map((value) => value.trim());

        if (
                !Number.isInteger(caseId)
                || caseId <= 0
                || rawOptions.length === 0
                || rawOptions.some(
                        (value) => !/^\d+$/.test(value),
                )
        ) {
                return {
                        caseId,
                        optionNumbers: [],
                };
        }

        return {
                caseId,
                optionNumbers: [
                        ...new Set(
                                rawOptions.map(Number),
                        ),
                ],
        };
}


export async function processAvailabilityReply(
        db: D1Database,
        senderPhone: string,
        text: string,
): Promise<AvailabilityReplyResult> {
        const parsed = parseAvailabilityReply(text);

        if (!parsed) {
                return {
                        handled: false,
                        success: false,
                        matched: false,
                };
        }

        if (parsed.optionNumbers.length === 0) {
                return {
                        handled: true,
                        success: false,
                        matched: false,
                        error:
                                "Use the format CASE <number>: 1,3",
                };
        }

        const member = await db
                .prepare(
                        `
                        SELECT member.id
                        FROM team_members AS member
                        INNER JOIN coordination_cases
                                AS coordination
                                ON coordination.id = ?
                                AND (
                                        coordination.requester_member_id
                                                = member.id
                                        OR coordination.responsible_member_id
                                                = member.id
                                )
                        WHERE member.phone = ?
                                AND member.active = 1
                                AND coordination.status
                                        = 'availability_requested'
                        `,
                )
                .bind(
                        parsed.caseId,
                        senderPhone.replace(/\D/g, ""),
                )
                .first<MemberRow>();

        if (!member) {
                return {
                        handled: true,
                        success: false,
                        matched: false,
                        error:
                                "No matching availability request was found for this member.",
                };
        }

        const options = await db
                .prepare(
                        `
                        SELECT id
                        FROM case_time_options
                        WHERE case_id = ?
                                AND status = 'proposed'
                        ORDER BY starts_at
                        `,
                )
                .bind(parsed.caseId)
                .all<OptionRow>();

        if (
                options.results.length === 0
                || parsed.optionNumbers.some(
                        (number) =>
                                number < 1
                                || number
                                        > options.results.length,
                )
        ) {
                return {
                        handled: true,
                        success: false,
                        matched: false,
                        error:
                                "One or more selected option numbers are invalid.",
                };
        }

        const optionIds = parsed.optionNumbers.map(
                (number) =>
                        options.results[number - 1].id,
        );

        const result = await recordMemberAvailability(
                db,
                parsed.caseId,
                member.id,
                optionIds,
        );

        return {
                handled: true,
                success: result.success,
                matched: result.matched,
                error: result.error,
        };
}
