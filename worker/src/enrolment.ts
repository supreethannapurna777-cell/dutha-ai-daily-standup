export interface ChannelIdentity {
        tenantId: number;
        projectId: number;
        teamMemberId: number;
        memberName: string;
}

export interface EnrolmentResult {
        handled: boolean;
        duplicate: boolean;
        success: boolean;
        message?: string;
}

function normaliseEmail(value: string): string {
        return value.trim().toLowerCase();
}

function validEmail(value: string): boolean {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function sha256(value: string): Promise<string> {
        const digest = await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(value),
        );
        return [...new Uint8Array(digest)]
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("");
}

export async function hashEnrolmentCode(code: string): Promise<string> {
        return sha256(code.trim().toUpperCase());
}

export function generateEnrolmentCode(): string {
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const bytes = crypto.getRandomValues(new Uint8Array(10));
        return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

export async function resolveChannelIdentity(
        db: D1Database,
        channel: "whatsapp" | "teams",
        externalId: string,
): Promise<ChannelIdentity | null> {
        const row = await db.prepare(`
                SELECT identity.tenant_id, identity.team_member_id,
                        member.primary_project_id, member.name
                FROM channel_identities AS identity
                INNER JOIN team_members AS member
                        ON member.id = identity.team_member_id
                        AND member.tenant_id = identity.tenant_id
                WHERE identity.channel = ? AND identity.external_id = ?
                        AND member.active = 1
                LIMIT 1
        `).bind(channel, externalId).first<{
                tenant_id: number;
                team_member_id: number;
                primary_project_id: number;
                name: string;
        }>();
        return row ? {
                tenantId: row.tenant_id,
                projectId: row.primary_project_id,
                teamMemberId: row.team_member_id,
                memberName: row.name,
        } : null;
}

export async function resolveWhatsappIdentity(
        db: D1Database,
        senderPhone: string,
): Promise<ChannelIdentity | null> {
        const identity = await resolveChannelIdentity(
                db,
                "whatsapp",
                senderPhone,
        );
        if (identity) return identity;

        const legacy = await db.prepare(`
                SELECT id, tenant_id, primary_project_id, name
                FROM team_members
                WHERE phone = ? AND active = 1 AND enrolment_status = 'enrolled' LIMIT 1
        `).bind(senderPhone).first<{
                id: number;
                tenant_id: number;
                primary_project_id: number;
                name: string;
        }>();
        if (!legacy) return null;

        await db.prepare(`
                INSERT OR IGNORE INTO channel_identities (
                        tenant_id, team_member_id, channel, external_id, display_name
                ) VALUES (?, ?, 'whatsapp', ?, ?)
        `).bind(
                legacy.tenant_id,
                legacy.id,
                senderPhone,
                legacy.name,
        ).run();
        return {
                tenantId: legacy.tenant_id,
                projectId: legacy.primary_project_id,
                teamMemberId: legacy.id,
                memberName: legacy.name,
        };
}

async function eventExists(db: D1Database, messageId: string): Promise<boolean> {
        return Boolean(await db.prepare(`
                SELECT 1 AS found FROM channel_identity_events
                WHERE external_message_id = ? LIMIT 1
        `).bind(messageId).first());
}

export async function processChannelEnrolment(
        db: D1Database,
        channel: "whatsapp" | "teams",
        senderExternalId: string,
        senderName: string,
        messageId: string,
        text: string,
        now = new Date(),
): Promise<EnrolmentResult> {
	const directConfirmation = text.trim().match(/^(yes|confirm|accept)$/i);
	if (channel === "whatsapp" && directConfirmation) {
		if (await eventExists(db, messageId)) {
			return { handled: true, duplicate: true, success: false };
		}
		const pending = await db.prepare(`
			SELECT id, tenant_id, primary_project_id, name
			FROM team_members AS member
			WHERE member.phone = ? AND member.active = 1
				AND member.enrolment_status = 'invited'
				AND EXISTS (
					SELECT 1 FROM direct_whatsapp_invites AS invite
					WHERE invite.team_member_id = member.id
						AND invite.tenant_id = member.tenant_id
						AND invite.expires_at > ?
				)
			LIMIT 1
		`).bind(senderExternalId, now.toISOString()).first<{
			id: number;
			tenant_id: number;
			primary_project_id: number;
			name: string;
		}>();
		if (pending) {
			const owner = await db.prepare(`
				SELECT team_member_id FROM channel_identities
				WHERE channel = 'whatsapp' AND external_id = ? LIMIT 1
			`).bind(senderExternalId).first<{ team_member_id: number }>();
			if (owner && owner.team_member_id !== pending.id) {
				return {
					handled: true,
					duplicate: false,
					success: false,
					message: "This WhatsApp number is already connected. Ask your administrator for help.",
				};
			}
			await db.batch([
				db.prepare(`
					INSERT INTO channel_identities (
						tenant_id, team_member_id, channel, external_id, display_name
					) VALUES (?, ?, 'whatsapp', ?, ?)
					ON CONFLICT(team_member_id, channel) DO UPDATE SET
						external_id = excluded.external_id,
						display_name = excluded.display_name,
						verified_at = CURRENT_TIMESTAMP,
						updated_at = CURRENT_TIMESTAMP
				`).bind(pending.tenant_id, pending.id, senderExternalId, senderName),
				db.prepare(`
					UPDATE team_members
					SET enrolment_status = 'enrolled', scheduling_enabled = 1
					WHERE id = ? AND tenant_id = ?
				`).bind(pending.id, pending.tenant_id),
				db.prepare(`
					INSERT INTO channel_identity_events (
						tenant_id, team_member_id, channel, event_type,
						external_message_id, details
					) VALUES (?, ?, 'whatsapp', 'identity_connected', ?, ?)
				`).bind(pending.tenant_id, pending.id, messageId, `Project ${pending.primary_project_id}; direct invitation`),
				db.prepare(`DELETE FROM direct_whatsapp_invites WHERE team_member_id = ?`).bind(pending.id),
			]);
			return {
				handled: true,
				duplicate: false,
				success: true,
				message: `Welcome ${pending.name}. Your WhatsApp account is now connected to Dutha.`,
			};
		}
	}

        const match = text.trim().match(/^join\s+([A-Z0-9]{8,16})\s+([^\s]+)$/i);
        if (!match) return { handled: false, duplicate: false, success: false };
        if (await eventExists(db, messageId)) {
                return { handled: true, duplicate: true, success: false };
        }

        const email = normaliseEmail(match[2]);
        if (!validEmail(email)) {
                return {
                        handled: true,
                        duplicate: false,
                        success: false,
                        message: "That work email is not valid. Reply: JOIN <code> <work-email>",
                };
        }

        const codeHash = await hashEnrolmentCode(match[1]);
        const invite = await db.prepare(`
                SELECT id, tenant_id, project_id, max_uses, use_count
                FROM enrolment_invites
                WHERE code_hash = ? AND revoked_at IS NULL
                        AND expires_at > ? AND use_count < max_uses
                LIMIT 1
        `).bind(codeHash, now.toISOString()).first<{
                id: number;
                tenant_id: number;
                project_id: number;
                max_uses: number;
                use_count: number;
        }>();

        if (!invite) {
                await db.prepare(`
                        INSERT INTO channel_identity_events (
                                channel, event_type, external_message_id, details
                        ) VALUES (?, 'identity_rejected', ?, ?)
                `).bind(channel, messageId, "Invalid, expired or exhausted invite").run();
                return {
                        handled: true,
                        duplicate: false,
                        success: false,
                        message: "That invitation is invalid or expired. Ask your manager for a new invitation.",
                };
        }

        const member = await db.prepare(`
                SELECT member.id, member.name
                FROM team_members AS member
                WHERE member.tenant_id = ? AND lower(member.email) = ?
                        AND member.active = 1
                        AND (
                                member.primary_project_id = ?
                                OR EXISTS (
                                        SELECT 1 FROM team_member_projects AS membership
                                        WHERE membership.team_member_id = member.id
                                                AND membership.project_id = ?
                                )
                        )
                LIMIT 1
        `).bind(
                invite.tenant_id,
                email,
                invite.project_id,
                invite.project_id,
        ).first<{ id: number; name: string }>();

        if (!member) {
                await db.prepare(`
                        INSERT INTO channel_identity_events (
                                tenant_id, channel, event_type,
                                external_message_id, details
                        ) VALUES (?, ?, 'identity_rejected', ?, ?)
                `).bind(invite.tenant_id, channel, messageId, "Email is not assigned to this project").run();
                return {
                        handled: true,
                        duplicate: false,
                        success: false,
                        message: "Your email is not assigned to this project. Ask your manager to add it first.",
                };
        }

        const identityOwner = await db.prepare(`
                SELECT team_member_id FROM channel_identities
                WHERE channel = ? AND external_id = ? LIMIT 1
        `).bind(channel, senderExternalId).first<{ team_member_id: number }>();
        if (identityOwner && identityOwner.team_member_id !== member.id) {
                await db.prepare(`
                        INSERT INTO channel_identity_events (
                                tenant_id, team_member_id, channel, event_type,
                                external_message_id, details
                        ) VALUES (?, ?, ?, 'identity_rejected', ?, ?)
                `).bind(invite.tenant_id, member.id, channel, messageId, "Channel identity belongs to another member").run();
                return {
                        handled: true,
                        duplicate: false,
                        success: false,
                    message: `This ${channel} account is already linked. Ask your administrator for help.`,
                };
        }

        try {
                await db.batch([
                        db.prepare(`
                                INSERT INTO channel_identities (
                                        tenant_id, team_member_id, channel,
                                        external_id, display_name
                                ) VALUES (?, ?, ?, ?, ?)
                                ON CONFLICT(team_member_id, channel) DO UPDATE SET
                                        external_id = excluded.external_id,
                                        display_name = excluded.display_name,
                                        verified_at = CURRENT_TIMESTAMP,
                                        updated_at = CURRENT_TIMESTAMP
                        `).bind(invite.tenant_id, member.id, channel, senderExternalId, senderName),
                        db.prepare(`
                                UPDATE team_members
                                SET phone = CASE WHEN ? = 'whatsapp' THEN ? ELSE phone END,
                                        enrolment_status = 'enrolled'
                                WHERE id = ? AND tenant_id = ?
                        `).bind(channel, senderExternalId, member.id, invite.tenant_id),
                        db.prepare(`
                                UPDATE enrolment_invites
                                SET use_count = use_count + 1
                                WHERE id = ? AND use_count < max_uses
                        `).bind(invite.id),
                        db.prepare(`
                                INSERT INTO channel_identity_events (
                                        tenant_id, team_member_id, channel, event_type,
                                        external_message_id, details
                                ) VALUES (?, ?, ?, 'identity_connected', ?, ?)
                        `).bind(invite.tenant_id, member.id, channel, messageId, `Project ${invite.project_id}`),
                ]);
        } catch {
                return {
                        handled: true,
                        duplicate: false,
                        success: false,
                    message: `Dutha could not connect this ${channel} account. Ask your administrator to check the member record.`,
                };
        }

        return {
                handled: true,
                duplicate: false,
                success: true,
                message: `Welcome ${member.name}. Your ${channel} account is now connected to Dutha.`,
        };
}

export async function processWhatsappEnrolment(
        db: D1Database,
        senderPhone: string,
        senderName: string,
        messageId: string,
        text: string,
        now = new Date(),
): Promise<EnrolmentResult> {
        return processChannelEnrolment(db, "whatsapp", senderPhone, senderName, messageId, text, now);
}
