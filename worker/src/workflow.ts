import { createCoordinationCase } from "./coordination";
import { extractUpdate, type ExtractedUpdate } from "./extract-update";

export type DuthaChannel = "whatsapp" | "teams";

export interface WorkflowIdentity {
        tenantId: number;
        projectId: number;
        teamMemberId: number;
        memberName: string;
}

export interface InboundTextMessage {
        channel: DuthaChannel;
        externalMessageId: string;
        senderExternalId: string;
        receivedAt: string;
        text: string;
        identity: WorkflowIdentity;
}

export interface WorkflowInterception {
        handled: boolean;
        processingStatus?: string;
}

export type WorkflowInterceptor = (
        message: InboundTextMessage,
        storedMessageId: number,
) => Promise<WorkflowInterception>;

export interface WorkflowResult {
        status: "processed" | "duplicate" | "intercepted" | "rejected";
        storedMessageId?: number;
        processedUpdateId?: number;
}

async function identityCanUseProject(
        db: D1Database,
        identity: WorkflowIdentity,
): Promise<boolean> {
        const member = await db.prepare(`
                SELECT 1 AS allowed FROM team_members
                WHERE id = ? AND tenant_id = ? AND active = 1
                        AND (
                                primary_project_id = ?
                                OR EXISTS (
                                        SELECT 1 FROM team_member_projects
                                        WHERE team_member_id = team_members.id
                                                AND project_id = ?
                                )
                        )
                LIMIT 1
        `).bind(
                identity.teamMemberId,
                identity.tenantId,
                identity.projectId,
                identity.projectId,
        ).first();
        return Boolean(member);
}

interface StoredMessage extends InboundTextMessage {
        id: number;
        extracted: ExtractedUpdate;
}

function legacyMessageKey(message: InboundTextMessage): string {
        return message.channel === "whatsapp"
                ? message.externalMessageId
                : `${message.channel}:${message.externalMessageId}`;
}

async function storeMessage(
        db: D1Database,
        message: InboundTextMessage,
): Promise<StoredMessage | null> {
        const inserted = await db.prepare(`
                INSERT OR IGNORE INTO incoming_messages (
                        whatsapp_message_id, received_at, sender_name,
                        sender_phone, original_reply, processing_status,
                        tenant_id, project_id, channel, external_message_id,
                        sender_external_id, team_member_id
                ) VALUES (?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?)
                RETURNING id
        `).bind(
                legacyMessageKey(message),
                message.receivedAt,
                message.identity.memberName,
                message.senderExternalId,
                message.text,
                message.identity.tenantId,
                message.identity.projectId,
                message.channel,
                message.externalMessageId,
                message.senderExternalId,
                message.identity.teamMemberId,
        ).first<{ id: number }>();
        if (!inserted) return null;
        return {
                ...message,
                id: inserted.id,
                extracted: extractUpdate(message.text),
        };
}

async function saveProcessedUpdate(
        db: D1Database,
        message: StoredMessage,
): Promise<number> {
        const update = message.extracted;
        await db.batch([
                db.prepare(`
                        INSERT INTO processed_updates (
                                message_id, sender_name, tasks,
                                people_to_connect, blockers, dependencies,
                                expected_completion, original_reply,
                                processing_status, tenant_id, project_id
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processed', ?, ?)
                `).bind(
                        message.id,
                        message.identity.memberName,
                        update.tasks,
                        update.people_to_connect,
                        update.blockers,
                        update.dependencies,
                        update.expected_completion,
                        update.original_reply,
                        message.identity.tenantId,
                        message.identity.projectId,
                ),
                db.prepare(`
                        UPDATE incoming_messages
                        SET processing_status = 'processed' WHERE id = ?
                `).bind(message.id),
        ]);
        const processed = await db.prepare(`
                SELECT id FROM processed_updates WHERE message_id = ?
        `).bind(message.id).first<{ id: number }>();
        if (!processed) throw new Error("Processed update was not stored.");
        return processed.id;
}

export async function createCaseForProcessedUpdate(
        db: D1Database,
        processedUpdateId: number,
): Promise<void> {
        try {
                const result = await createCoordinationCase(db, processedUpdateId);
                if (result.created) {
                        console.log(JSON.stringify({
                                event: "coordination_case_created",
                                caseId: result.caseId,
                                status: result.status,
                        }));
                }
        } catch (error) {
                console.error(JSON.stringify({
                        event: "coordination_case_creation_failed",
                        processedUpdateId,
                        error: error instanceof Error ? error.message : "Unknown error",
                }));
        }
}

export async function processInboundTextMessage(
        db: D1Database,
        message: InboundTextMessage,
        interceptor?: WorkflowInterceptor,
): Promise<WorkflowResult> {
        if (!(await identityCanUseProject(db, message.identity))) {
                return { status: "rejected" };
        }
        const stored = await storeMessage(db, message);
        if (!stored) return { status: "duplicate" };

        if (interceptor) {
                const interception = await interceptor(message, stored.id);
                if (interception.handled) {
                        await db.prepare(`
                                UPDATE incoming_messages SET processing_status = ?
                                WHERE id = ?
                        `).bind(interception.processingStatus ?? "intercepted", stored.id).run();
                        return { status: "intercepted", storedMessageId: stored.id };
                }
        }

        const processedUpdateId = await saveProcessedUpdate(db, stored);
        await createCaseForProcessedUpdate(db, processedUpdateId);
        return {
                status: "processed",
                storedMessageId: stored.id,
                processedUpdateId,
        };
}
