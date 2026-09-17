import type { InboundTextMessage, WorkflowInterception } from "./workflow";

export interface ResolutionReplyResult extends WorkflowInterception { response?: string }

function parseReply(text: string): { action: "verify" | "reopen"; caseId: number; note: string } | null {
        const match = text.trim().match(/^(VERIFY|REOPEN)\s+#?(\d+)(?:\s+(.+))?$/i);
        if (!match) return null;
        return { action: match[1].toLowerCase() as "verify" | "reopen", caseId: Number(match[2]), note: match[3]?.trim() ?? "" };
}

export async function processResolutionReply(db: D1Database, message: InboundTextMessage): Promise<ResolutionReplyResult> {
        const reply = parseReply(message.text);
        if (!reply) return { handled: false };
        const item = await db.prepare(`
                SELECT id, tenant_id, project_id, requester_member_id, resolution_state
                FROM coordination_cases WHERE id = ? AND tenant_id = ? AND project_id = ?
        `).bind(reply.caseId, message.identity.tenantId, message.identity.projectId).first<{
                id: number; tenant_id: number; project_id: number; requester_member_id: number; resolution_state: string;
        }>();
        if (!item || item.requester_member_id !== message.identity.teamMemberId) {
                return { handled: true, processingStatus: "resolution_reply_rejected", response: "That case was not found or you are not its requester." };
        }
        if (item.resolution_state !== "awaiting_verification") {
                return { handled: true, processingStatus: "resolution_reply_rejected", response: `Case #${item.id} is not awaiting verification.` };
        }
        if (reply.action === "verify") {
                const note = reply.note || "Requester confirmed the blocker is resolved.";
                await db.batch([
                        db.prepare(`UPDATE coordination_cases SET status = 'resolved', resolution_state = 'resolved', resolution_verified_at = CURRENT_TIMESTAMP, verified_by_type = 'requester', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND resolution_state = 'awaiting_verification'`).bind(item.id),
                        db.prepare(`INSERT INTO blocker_resolution_evidence (tenant_id, project_id, case_id, evidence_type, summary, created_by_type, created_by_member_id) VALUES (?, ?, ?, 'requester_confirmation', ?, 'member', ?)`).bind(item.tenant_id, item.project_id, item.id, note, message.identity.teamMemberId),
                        db.prepare(`INSERT INTO case_events (case_id, event_type, actor_type, actor_member_id, details) VALUES (?, 'resolution_verified', 'member', ?, ?)`).bind(item.id, message.identity.teamMemberId, note),
                ]);
                return { handled: true, processingStatus: "resolution_verified", response: `Thank you. Case #${item.id} is now closed as resolved.` };
        }
        if (!reply.note) {
                return { handled: true, processingStatus: "resolution_reply_rejected", response: `Please include the reason: REOPEN ${item.id} <what is still blocked>` };
        }
        await db.batch([
                db.prepare(`UPDATE coordination_cases SET status = 'in_progress', resolution_state = 'escalated', resolution_summary = NULL, resolution_proposed_at = NULL, resolution_verified_at = NULL, verified_by_type = NULL, manager_notes = ?, priority = 'critical', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND resolution_state = 'awaiting_verification'`).bind(reply.note, item.id),
                db.prepare(`INSERT INTO blocker_resolution_evidence (tenant_id, project_id, case_id, evidence_type, summary, created_by_type, created_by_member_id) VALUES (?, ?, ?, 'requester_confirmation', ?, 'member', ?)`).bind(item.tenant_id, item.project_id, item.id, `Reopened: ${reply.note}`, message.identity.teamMemberId),
                db.prepare(`INSERT INTO case_events (case_id, event_type, actor_type, actor_member_id, details) VALUES (?, 'case_escalated', 'member', ?, ?)`).bind(item.id, message.identity.teamMemberId, `Requester reopened: ${reply.note}`),
        ]);
        return { handled: true, processingStatus: "resolution_reopened", response: `Case #${item.id} has been reopened and escalated.` };
}
