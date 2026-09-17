import {
        processAvailabilityReply,
} from "./availability-reply";
import {
        processVoiceReply,
        type IncomingVoiceMessage,
        type VoiceStructuredExtractor,
} from "./voice-update";
import {
        processWhatsappEnrolment,
        resolveWhatsappIdentity,
} from "./enrolment";
import {
        createCaseForProcessedUpdate,
        processInboundTextMessage,
} from "./workflow";
import { processResolutionReply } from "./resolution-reply";


export interface WebhookResult {
        received: number;
        duplicates: number;
        ignored: number;
}


export type AvailabilityReplySender = (
        recipient: string,
        text: string,
) => Promise<{
        success: boolean;
        error?: string;
}>;


export type VoiceMessageReceiver = (
        message: IncomingVoiceMessage,
) => Promise<boolean>;


function timestampToIso(
        timestamp: unknown,
        fallback: Date,
): string {
        const seconds = Number(timestamp);

        if (
                Number.isFinite(seconds)
                && seconds > 0
        ) {
                return new Date(
                        seconds * 1000,
                ).toISOString();
        }

        return fallback.toISOString();
}


function availabilityConfirmation(
        success: boolean,
        matched: boolean,
        error: string | undefined,
): string {
        if (!success) {
                return "Availability was not saved. "
                        + (
                                error
                                ?? "Check the case and option numbers."
                        )
                        + " Reply using: CASE <number>: 1,3";
        }

        if (matched) {
                return "Availability saved. A common discussion time "
                        + "has been matched automatically. The manager "
                        + "can now confirm the meeting details.";
        }

        return "Availability saved. Waiting for the other participant "
                + "or a common discussion time.";
}


async function safelySendAvailabilityConfirmation(
        sender: AvailabilityReplySender | undefined,
        recipient: string,
        success: boolean,
        matched: boolean,
        error: string | undefined,
): Promise<void> {
        if (!sender) {
                return;
        }

        try {
                const result = await sender(
                        recipient,
                        availabilityConfirmation(
                                success,
                                matched,
                                error,
                        ),
                );

                if (!result.success) {
                        console.error(
                                JSON.stringify({
                                        event:
                                                "availability_confirmation_failed",
                                        error:
                                                result.error
                                                ?? "Unknown WhatsApp error",
                                }),
                        );
                }
        } catch (sendError) {
                console.error(
                        JSON.stringify({
                                event:
                                        "availability_confirmation_failed",
                                error:
                                        sendError instanceof Error
                                                ? sendError.message
                                                : "Unknown WhatsApp error",
                        }),
                );
        }
}


export async function processWebhookPayload(
        payload: unknown,
        db: D1Database,
        now = new Date(),
        availabilityReplySender?:
                AvailabilityReplySender,
        voiceMessageReceiver?: VoiceMessageReceiver,
        voiceExtractor?: VoiceStructuredExtractor,
): Promise<WebhookResult> {
        const result: WebhookResult = {
                received: 0,
                duplicates: 0,
                ignored: 0,
        };

        if (
                typeof payload !== "object"
                || payload === null
        ) {
                return result;
        }

        const root =
                payload as Record<string, unknown>;

        const entries = Array.isArray(root.entry)
                ? root.entry
                : [];

        for (const entryValue of entries) {
                if (
                        typeof entryValue !== "object"
                        || entryValue === null
                ) {
                        continue;
                }

                const entry =
                        entryValue as Record<
                                string,
                                unknown
                        >;

                const changes =
                        Array.isArray(entry.changes)
                                ? entry.changes
                                : [];

                for (const changeValue of changes) {
                        if (
                                typeof changeValue
                                        !== "object"
                                || changeValue === null
                        ) {
                                continue;
                        }

                        const change =
                                changeValue as Record<
                                        string,
                                        unknown
                                >;

                        const value =
                                typeof change.value
                                        === "object"
                                && change.value !== null
                                        ? change.value as Record<
                                                string,
                                                unknown
                                        >
                                        : {};

                        const contacts =
                                Array.isArray(
                                        value.contacts,
                                )
                                        ? value.contacts
                                        : [];

                        let contactName =
                                "WhatsApp User";

                        const firstContact =
                                contacts[0];

                        if (
                                typeof firstContact
                                        === "object"
                                && firstContact !== null
                        ) {
                                const contact =
                                        firstContact as Record<
                                                string,
                                                unknown
                                        >;

                                const profile =
                                        typeof contact.profile
                                                === "object"
                                        && contact.profile
                                                !== null
                                                ? contact.profile as Record<
                                                        string,
                                                        unknown
                                                >
                                                : {};

                                if (
                                        typeof profile.name
                                                === "string"
                                ) {
                                        contactName =
                                                profile.name;
                                }
                        }

                        const messages =
                                Array.isArray(
                                        value.messages,
                                )
                                        ? value.messages
                                        : [];

                        for (
                                const messageValue
                                of messages
                        ) {
                                if (
                                        typeof messageValue
                                                !== "object"
                                        || messageValue
                                                === null
                                ) {
                                        result.ignored += 1;
                                        continue;
                                }

                                const message =
                                        messageValue as Record<
                                                string,
                                                unknown
                                        >;

                                const messageId =
                                        typeof message.id
                                                === "string"
                                                ? message.id
                                                        .trim()
                                                : "";

                                const receivedAt = timestampToIso(
                                        message.timestamp,
                                        now,
                                );

                                const senderPhone =
                                        typeof message.from
                                                === "string"
                                                ? message.from
                                                        .trim()
                                                : "";

                                if (message.type === "audio") {
                                        const audio =
                                                typeof message.audio === "object"
                                                && message.audio !== null
                                                        ? message.audio as Record<string, unknown>
                                                        : {};
                                        const mediaId = typeof audio.id === "string"
                                                ? audio.id.trim()
                                                : "";
                                        const mimeType = typeof audio.mime_type === "string"
                                                ? audio.mime_type.trim()
                                                : undefined;

                                        if (
                                                !messageId
                                                || !senderPhone
                                                || !mediaId
                                                || !voiceMessageReceiver
                                        ) {
                                                result.ignored += 1;
                                                continue;
                                        }

                                        const identity = await resolveWhatsappIdentity(
                                                db,
                                                senderPhone,
                                        );
                                        if (!identity) {
                                                if (availabilityReplySender) {
                                                        await availabilityReplySender(
                                                                senderPhone,
                                                                "This WhatsApp number is not connected to Dutha. Ask your manager for an invitation.",
                                                        );
                                                }
                                                result.ignored += 1;
                                                continue;
                                        }

                                        const accepted = await voiceMessageReceiver({
                                                whatsappMessageId: messageId,
                                                senderName: identity.memberName,
                                                senderPhone,
                                                receivedAt,
                                                mediaId,
                                                mimeType,
                                                tenantId: identity.tenantId,
                                                projectId: identity.projectId,
                                        });

                                        if (accepted) {
                                                result.received += 1;
                                        } else {
                                                result.duplicates += 1;
                                        }
                                        continue;
                                }

                                if (message.type !== "text") {
                                        result.ignored += 1;
                                        continue;
                                }

                                const textObject =
                                        typeof message.text
                                                === "object"
                                        && message.text
                                                !== null
                                                ? message.text as Record<
                                                        string,
                                                        unknown
                                                >
                                                : {};

                                const text =
                                        typeof textObject.body
                                                === "string"
                                                ? textObject.body
                                                        .trim()
                                                : "";

                                if (
                                        !messageId
                                        || !senderPhone
                                        || !text
                                ) {
                                        result.ignored += 1;
                                        continue;
                                }

                                const enrolment = await processWhatsappEnrolment(
                                        db,
                                        senderPhone,
                                        contactName,
                                        messageId,
                                        text,
                                        now,
                                );
                                if (enrolment.handled) {
                                        if (enrolment.duplicate) {
                                                result.duplicates += 1;
                                                continue;
                                        }
                                        if (availabilityReplySender && enrolment.message) {
                                                await availabilityReplySender(
                                                        senderPhone,
                                                        enrolment.message,
                                                );
                                        }
                                        result.received += 1;
                                        continue;
                                }

                                const identity = await resolveWhatsappIdentity(
                                        db,
                                        senderPhone,
                                );
                                if (!identity) {
                                        if (availabilityReplySender) {
                                                await availabilityReplySender(
                                                        senderPhone,
                                                        "This WhatsApp number is not connected to Dutha. Ask your manager for an invitation.",
                                                );
                                        }
                                        result.ignored += 1;
                                        continue;
                                }

                                const voiceReply = await processVoiceReply(
                                        db,
                                        senderPhone,
                                        messageId,
                                        text,
                                        availabilityReplySender,
                                        voiceExtractor,
                                );

                                if (voiceReply.handled) {
                                        if (voiceReply.duplicate) {
                                                result.duplicates += 1;
                                                continue;
                                        }

                                        if (
                                                voiceReply.confirmed
                                                && voiceReply.processedUpdateId
                                        ) {
                                                await createCaseForProcessedUpdate(
                                                        db,
                                                        voiceReply.processedUpdateId,
                                                );
                                        }

                                        result.received += 1;
                                        continue;
                                }

                                const workflow = await processInboundTextMessage(
                                        db,
                                        {
                                                channel: "whatsapp",
                                                externalMessageId: messageId,
                                                senderExternalId: senderPhone,
                                                receivedAt,
                                                text,
                                                identity,
                                        },
                                        async (workflowMessage) => {
                                                const resolutionReply = await processResolutionReply(db, workflowMessage);
                                                if (resolutionReply.handled) {
                                                        if (resolutionReply.response && availabilityReplySender) {
                                                                await availabilityReplySender(senderPhone, resolutionReply.response);
                                                        }
                                                        return resolutionReply;
                                                }
                                                const availabilityReply =
                                                        await processAvailabilityReply(
                                                                db,
                                                                senderPhone,
                                                                text,
                                                        );
                                                if (!availabilityReply.handled) {
                                                        return { handled: false };
                                                }
                                                await safelySendAvailabilityConfirmation(
                                                        availabilityReplySender,
                                                        senderPhone,
                                                        availabilityReply.success,
                                                        availabilityReply.matched,
                                                        availabilityReply.error,
                                                );
                                                console.log(JSON.stringify({
                                                        event: "availability_reply_processed",
                                                        success: availabilityReply.success,
                                                        matched: availabilityReply.matched,
                                                        error: availabilityReply.error,
                                                }));
                                                return {
                                                        handled: true,
                                                        processingStatus: availabilityReply.success
                                                                ? "availability_processed"
                                                                : "availability_rejected",
                                                };
                                        },
                                );

                                if (workflow.status === "duplicate") {
                                        result.duplicates += 1;
                                        continue;
                                }
                                if (workflow.status === "rejected") {
                                        result.ignored += 1;
                                        continue;
                                }
                                result.received += 1;
                        }
                }
        }

        return result;
}
