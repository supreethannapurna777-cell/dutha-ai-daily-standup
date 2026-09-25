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

interface BareSelection {
        optionNumbers: number[];
}


interface ActiveAvailabilityCaseRow {
        id: number;
}


function parseOptionNumbers(
        rawOptions: string,
): number[] | null {
        const values = rawOptions
                .split(",")
                .map((value) => value.trim());

        if (
                values.length === 0
                || values.some((value) => !/^\d+$/.test(value))
        ) {
                return null;
        }

        return [...new Set(values.map(Number))];
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
        const optionNumbers = parseOptionNumbers(match[2]);

        if (
                !Number.isInteger(caseId)
                || caseId <= 0
                || !optionNumbers
        ) {
                return {
                        caseId,
                        optionNumbers: [],
                };
        }

        return {
                caseId,
                optionNumbers,
        };
}


function parseBareSelection(text: string): BareSelection | null {
        const trimmed = text.trim();
        if (!/^\d+(?:\s*,\s*\d+)*$/.test(trimmed)) {
                return null;
        }

        const optionNumbers = parseOptionNumbers(trimmed);
        return optionNumbers ? { optionNumbers } : null;
}


export async function processAvailabilityReply(
        db: D1Database,
        senderPhone: string,
        text: string,
): Promise<AvailabilityReplyResult> {
        let parsed = parseAvailabilityReply(text);

        if (!parsed) {
                const bareSelection = parseBareSelection(text);
                if (!bareSelection) {
                        return {
                                handled: false,
                                success: false,
                                matched: false,
                        };
                }

                const activeCases = await db
                        .prepare(
                                `
                                SELECT coordination.id
                                FROM coordination_cases AS coordination
                                INNER JOIN team_members AS member
                                        ON member.phone = ?
                                        AND member.active = 1
                                        AND (
                                                coordination.requester_member_id = member.id
                                                OR coordination.responsible_member_id = member.id
                                        )
                                WHERE coordination.status = 'availability_requested'
                                        AND EXISTS (
                                                SELECT 1
                                                FROM case_time_options AS option
                                                WHERE option.case_id = coordination.id
                                                        AND option.status = 'proposed'
                                        )
                                ORDER BY coordination.id DESC
                                `,
                        )
                        .bind(senderPhone.replace(/\D/g, ""))
                        .all<ActiveAvailabilityCaseRow>();

                if (activeCases.results.length === 0) {
                        return {
                                handled: false,
                                success: false,
                                matched: false,
                        };
                }

                if (activeCases.results.length > 1) {
                        return {
                                handled: true,
                                success: false,
                                matched: false,
                                error:
                                        "More than one availability request is waiting. Reply using CASE <number>: 1,3",
                        };
                }

                parsed = {
                        caseId: activeCases.results[0].id,
                        optionNumbers: bareSelection.optionNumbers,
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
