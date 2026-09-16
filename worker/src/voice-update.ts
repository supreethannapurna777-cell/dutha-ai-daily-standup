import type { WorkerEnv } from "./env";
import {
        extractUpdate,
        type ExtractedUpdate,
} from "./extract-update";
import {
        sendTextMessage,
        type Fetcher,
} from "./whatsapp";


export interface IncomingVoiceMessage {
        whatsappMessageId: string;
        senderName: string;
        senderPhone: string;
        receivedAt: string;
        mediaId: string;
        mimeType?: string;
}


interface VoiceUpdateRow extends ExtractedUpdate {
        id: number;
        whatsapp_message_id: string;
        sender_name: string;
        sender_phone: string;
        received_at: string;
        media_id: string;
        mime_type: string | null;
        original_transcript: string | null;
        reporting_transcript: string | null;
}


export interface VoiceTranscription {
        text: string;
        language?: string;
}


export type VoiceTranscriber = (
        mediaId: string,
        mimeType?: string,
) => Promise<VoiceTranscription>;


export type VoiceStructuredExtractor = (
        transcript: string,
) => Promise<ExtractedUpdate>;


export type VoiceConfirmationSender = (
        recipient: string,
        text: string,
) => Promise<{
        success: boolean;
        messageId?: string;
        error?: string;
}>;


function clean(value: string | null | undefined): string {
        const trimmed = String(value ?? "").trim();
        return trimmed || "Not specified";
}


function confirmationText(
        extracted: ExtractedUpdate,
): string {
        return [
                "Dutha understood your voice update as:",
                "",
                `Task: ${clean(extracted.tasks)}`,
                `Connect with: ${clean(extracted.people_to_connect)}`,
                `Blocker: ${clean(extracted.blockers)}`,
                `Dependency: ${clean(extracted.dependencies)}`,
                `Expected completion: ${clean(extracted.expected_completion)}`,
                "",
                "Reply YES if this is correct.",
                "Otherwise, reply CORRECT: followed by the corrected update.",
        ].join("\n");
}


async function markFailed(
        db: D1Database,
        id: number,
        error: unknown,
): Promise<void> {
        await db.prepare(`
                UPDATE voice_updates
                SET status = 'failed', error_message = ?,
                        updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
        `).bind(
                error instanceof Error
                        ? error.message
                        : "Unknown voice processing error",
                id,
        ).run();
}


export async function acceptVoiceUpdate(
        db: D1Database,
        message: IncomingVoiceMessage,
): Promise<number | null> {
        const inserted = await db.prepare(`
                INSERT OR IGNORE INTO voice_updates (
                        whatsapp_message_id, sender_name, sender_phone,
                        received_at, media_id, mime_type, status
                ) VALUES (?, ?, ?, ?, ?, ?, 'received')
                RETURNING id
        `).bind(
                message.whatsappMessageId,
                message.senderName,
                message.senderPhone,
                message.receivedAt,
                message.mediaId,
                message.mimeType ?? null,
        ).first<{ id: number }>();

        if (!inserted) {
                return null;
        }

        await db.prepare(`
                INSERT INTO voice_update_events (
                        whatsapp_message_id, voice_update_id, event_type
                ) VALUES (?, ?, 'audio_received')
        `).bind(
                message.whatsappMessageId,
                inserted.id,
        ).run();

        return inserted.id;
}


export async function processVoiceUpdate(
        db: D1Database,
        voiceUpdateId: number,
        transcriber: VoiceTranscriber,
        sender: VoiceConfirmationSender,
        extractor: VoiceStructuredExtractor = async (text) =>
                extractUpdate(text),
): Promise<void> {
        const voice = await db.prepare(`
                SELECT id, media_id, mime_type, sender_phone
                FROM voice_updates
                WHERE id = ? AND status IN ('received', 'failed')
        `).bind(voiceUpdateId).first<{
                id: number;
                media_id: string;
                mime_type: string | null;
                sender_phone: string;
        }>();

        if (!voice) {
                return;
        }

        await db.prepare(`
                UPDATE voice_updates
                SET status = 'processing', attempt_count = attempt_count + 1,
                        error_message = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
        `).bind(voice.id).run();

        try {
                const transcription = await transcriber(
                        voice.media_id,
                        voice.mime_type ?? undefined,
                );
                const transcript = transcription.text.trim();

                if (!transcript) {
                        throw new Error("The voice note did not contain recognisable speech.");
                }

                const extracted = await extractor(transcript);
                const sent = await sender(
                        voice.sender_phone,
                        confirmationText(extracted),
                );

                if (!sent.success) {
                        throw new Error(
                                sent.error
                                ?? "WhatsApp confirmation could not be sent.",
                        );
                }

                await db.prepare(`
                        UPDATE voice_updates
                        SET status = 'awaiting_confirmation',
                                detected_language = ?,
                                original_transcript = ?,
                                reporting_transcript = ?,
                                tasks = ?, people_to_connect = ?, blockers = ?,
                                dependencies = ?, expected_completion = ?,
                                confirmation_sent_at = CURRENT_TIMESTAMP,
                                updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                `).bind(
                        transcription.language ?? "unknown",
                        transcript,
                        transcript,
                        extracted.tasks,
                        extracted.people_to_connect,
                        extracted.blockers,
                        extracted.dependencies,
                        extracted.expected_completion,
                        voice.id,
                ).run();
        } catch (error) {
                await markFailed(db, voice.id, error);
                console.error(JSON.stringify({
                        event: "voice_update_processing_failed",
                        voiceUpdateId: voice.id,
                        error: error instanceof Error
                                ? error.message
                                : "Unknown error",
                }));
        }
}


async function eventAlreadyHandled(
        db: D1Database,
        whatsappMessageId: string,
): Promise<boolean> {
        const event = await db.prepare(`
                SELECT whatsapp_message_id
                FROM voice_update_events
                WHERE whatsapp_message_id = ?
        `).bind(whatsappMessageId).first();
        return Boolean(event);
}


async function latestPendingVoiceUpdate(
        db: D1Database,
        senderPhone: string,
): Promise<VoiceUpdateRow | null> {
        return db.prepare(`
                SELECT *
                FROM voice_updates
                WHERE sender_phone = ?
                        AND status = 'awaiting_confirmation'
                ORDER BY received_at DESC, id DESC
                LIMIT 1
        `).bind(senderPhone).first<VoiceUpdateRow>();
}


async function confirmVoiceUpdate(
        db: D1Database,
        voice: VoiceUpdateRow,
        replyMessageId: string,
): Promise<number> {
        await db.prepare(`
                INSERT OR IGNORE INTO incoming_messages (
                        whatsapp_message_id, received_at, sender_name,
                        sender_phone, original_reply, processing_status
                ) VALUES (?, ?, ?, ?, ?, 'received')
        `).bind(
                voice.whatsapp_message_id,
                voice.received_at,
                voice.sender_name,
                voice.sender_phone,
                voice.reporting_transcript
                        ?? voice.original_transcript
                        ?? "",
        ).run();

        const storedIncoming = await db.prepare(`
                SELECT id FROM incoming_messages
                WHERE whatsapp_message_id = ?
        `).bind(voice.whatsapp_message_id).first<{ id: number }>();

        if (!storedIncoming) {
                throw new Error("Confirmed voice update could not be stored.");
        }

        await db.batch([
                db.prepare(`
                        INSERT OR IGNORE INTO processed_updates (
                                message_id, sender_name, tasks,
                                people_to_connect, blockers, dependencies,
                                expected_completion, original_reply,
                                processing_status
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processed')
                `).bind(
                        storedIncoming.id,
                        voice.sender_name,
                        voice.tasks,
                        voice.people_to_connect,
                        voice.blockers,
                        voice.dependencies,
                        voice.expected_completion,
                        voice.reporting_transcript
                                ?? voice.original_transcript
                                ?? "",
                ),
                db.prepare(`
                        UPDATE incoming_messages
                        SET processing_status = 'processed'
                        WHERE id = ?
                `).bind(storedIncoming.id),
                db.prepare(`
                        UPDATE voice_updates
                        SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP,
                                updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                `).bind(voice.id),
                db.prepare(`
                        INSERT OR IGNORE INTO voice_update_events (
                                whatsapp_message_id, voice_update_id, event_type
                        ) VALUES (?, ?, 'confirmation_received')
                `).bind(replyMessageId, voice.id),
        ]);

        const processed = await db.prepare(`
                SELECT id FROM processed_updates WHERE message_id = ?
        `).bind(storedIncoming.id).first<{ id: number }>();

        if (!processed) {
                throw new Error("Confirmed voice update was not processed.");
        }

        return processed.id;
}


export interface VoiceReplyResult {
        handled: boolean;
        duplicate: boolean;
        confirmed: boolean;
        processedUpdateId?: number;
}


export async function processVoiceReply(
        db: D1Database,
        senderPhone: string,
        replyMessageId: string,
        text: string,
        sender?: VoiceConfirmationSender,
        extractor: VoiceStructuredExtractor = async (value) =>
                extractUpdate(value),
): Promise<VoiceReplyResult> {
        if (await eventAlreadyHandled(db, replyMessageId)) {
                return {
                        handled: true,
                        duplicate: true,
                        confirmed: false,
                };
        }

        const voice = await latestPendingVoiceUpdate(
                db,
                senderPhone,
        );

        if (!voice) {
                return {
                        handled: false,
                        duplicate: false,
                        confirmed: false,
                };
        }

        if (/^(yes|y|confirm|confirmed|correct)$/i.test(text.trim())) {
                const processedUpdateId = await confirmVoiceUpdate(
                        db,
                        voice,
                        replyMessageId,
                );
                if (sender) {
                        await sender(
                                senderPhone,
                                "Confirmed. Your voice update is now visible on the Dutha dashboard.",
                        );
                }
                return {
                        handled: true,
                        duplicate: false,
                        confirmed: true,
                        processedUpdateId,
                };
        }

        const correctionMatch = text.trim().match(/^correct\s*:\s*(.+)$/is);
        if (!correctionMatch) {
                return {
                        handled: false,
                        duplicate: false,
                        confirmed: false,
                };
        }

        const correction = correctionMatch[1].trim();
        const extracted = await extractor(correction);
        await db.batch([
                db.prepare(`
                        INSERT INTO voice_update_events (
                                whatsapp_message_id, voice_update_id, event_type
                        ) VALUES (?, ?, 'correction_received')
                `).bind(replyMessageId, voice.id),
                db.prepare(`
                        UPDATE voice_updates
                        SET reporting_transcript = ?, tasks = ?,
                                people_to_connect = ?, blockers = ?, dependencies = ?,
                                expected_completion = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                `).bind(
                        correction,
                        extracted.tasks,
                        extracted.people_to_connect,
                        extracted.blockers,
                        extracted.dependencies,
                        extracted.expected_completion,
                        voice.id,
                ),
        ]);

        if (sender) {
                await sender(
                        senderPhone,
                        confirmationText(extracted),
                );
        }

        return {
                handled: true,
                duplicate: false,
                confirmed: false,
        };
}


function arrayBufferToBase64(buffer: ArrayBuffer): string {
        const bytes = new Uint8Array(buffer);
        const chunks: string[] = [];
        const chunkSize = 32_768;

        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
                chunks.push(
                        String.fromCharCode(
                                ...bytes.subarray(
                                        offset,
                                        offset + chunkSize,
                                ),
                        ),
                );
        }

        return btoa(chunks.join(""));
}


export function createCloudflareVoiceTranscriber(
        env: WorkerEnv,
        fetcher: Fetcher = fetch,
): VoiceTranscriber {
        return async (mediaId, declaredMimeType) => {
                if (
                        !env.WHATSAPP_ACCESS_TOKEN
                        || !env.AI
                ) {
                        throw new Error("Voice transcription is not configured.");
                }

                const metadataResponse = await fetcher(
                        `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${mediaId}`,
                        {
                                headers: {
                                        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
                                },
                        },
                );
                const metadata = await metadataResponse.json() as Record<string, unknown>;
                if (!metadataResponse.ok || typeof metadata.url !== "string") {
                        throw new Error("WhatsApp voice media URL could not be retrieved.");
                }

                const mediaResponse = await fetcher(metadata.url, {
                        headers: {
                                Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
                        },
                });
                if (!mediaResponse.ok) {
                        throw new Error("WhatsApp voice media could not be downloaded.");
                }

                const contentLength = Number(
                        mediaResponse.headers.get("Content-Length") ?? "0",
                );
                if (contentLength > 10 * 1024 * 1024) {
                        throw new Error("Voice note exceeds the 10 MB prototype limit.");
                }

                const audio = await mediaResponse.arrayBuffer();
                if (audio.byteLength > 10 * 1024 * 1024) {
                        throw new Error("Voice note exceeds the 10 MB prototype limit.");
                }

                const responseBody = await env.AI.run(
                        "@cf/openai/whisper-large-v3-turbo",
                        {
                                audio: arrayBufferToBase64(audio),
                                task: "transcribe",
                                vad_filter: true,
                                initial_prompt:
                                        "A concise employee project status update containing tasks, blockers, dependencies, people, and expected completion.",
                        },
                );

                return {
                        text: responseBody.text,
                        language:
                                responseBody.transcription_info?.language,
                };
        };
}


export function defaultVoiceSender(
        env: WorkerEnv,
): VoiceConfirmationSender {
        return (recipient, text) =>
                sendTextMessage(env, recipient, text);
}


function parsedStructuredUpdate(
        transcript: string,
        response: string,
): ExtractedUpdate {
        const match = response.match(/\{[\s\S]*\}/);
        if (!match) {
                throw new Error("Structured extraction returned no JSON object.");
        }

        const parsed = JSON.parse(match[0]) as Record<string, unknown>;
        const field = (
                name: string,
                fallback = "Not specified",
        ): string => {
                const value = parsed[name];
                return typeof value === "string" && value.trim()
                        ? value.trim()
                        : fallback;
        };

        return {
                tasks: field("tasks"),
                people_to_connect: field("people_to_connect"),
                blockers: field("blockers", "None mentioned"),
                dependencies: field("dependencies", "None mentioned"),
                expected_completion: field("expected_completion"),
                original_reply: transcript,
        };
}


export function createCloudflareVoiceExtractor(
        env: WorkerEnv,
): VoiceStructuredExtractor {
        return async (transcript) => {
                if (!env.AI) {
                        return extractUpdate(transcript);
                }

                try {
                        const result = await env.AI.run(
                                "@cf/ibm-granite/granite-4.0-h-micro",
                                {
                                        messages: [
                                                {
                                                        role: "system",
                                                        content: [
                                                                "Extract a spoken employee status update into JSON.",
                                                                "Return only these string fields: tasks, people_to_connect, blockers, dependencies, expected_completion.",
                                                                "tasks: work being done or planned, without blocker or timing text.",
                                                                "people_to_connect: person names only, or Not specified.",
                                                                "blockers: the obstacle only; use None mentioned when explicitly unblocked.",
                                                                "dependencies: prerequisites needed to continue, without repeating coordination wording.",
                                                                "expected_completion: stated date or time only.",
                                                                "Do not invent facts. Use Not specified for missing fields.",
                                                        ].join(" "),
                                                },
                                                {
                                                        role: "user",
                                                        content: transcript,
                                                },
                                        ],
                                        response_format: {
                                                type: "json_object",
                                                json_schema: {
                                                        type: "object",
                                                        properties: {
                                                                tasks: { type: "string" },
                                                                people_to_connect: { type: "string" },
                                                                blockers: { type: "string" },
                                                                dependencies: { type: "string" },
                                                                expected_completion: { type: "string" },
                                                        },
                                                        required: [
                                                                "tasks",
                                                                "people_to_connect",
                                                                "blockers",
                                                                "dependencies",
                                                                "expected_completion",
                                                        ],
                                                        additionalProperties: false,
                                                },
                                        },
                                        temperature: 0,
                                        max_tokens: 220,
                                },
                        );

                        if (!result.response) {
                                throw new Error("Structured extraction returned no response.");
                        }

                        return parsedStructuredUpdate(
                                transcript,
                                result.response,
                        );
                } catch (error) {
                        console.error(JSON.stringify({
                                event: "voice_ai_extraction_failed",
                                error: error instanceof Error
                                        ? error.message
                                        : "Unknown extraction error",
                        }));
                        return extractUpdate(transcript);
                }
        };
}


export async function retryFailedVoiceUpdates(
        env: WorkerEnv,
        limit = 5,
): Promise<number> {
        if (!env.AI) {
                return 0;
        }

        const failed = await env.DB.prepare(`
                SELECT id
                FROM voice_updates
                WHERE status = 'failed'
                        AND attempt_count < 3
                ORDER BY updated_at ASC
                LIMIT ?
        `).bind(limit).all<{ id: number }>();

        for (const voice of failed.results) {
                await processVoiceUpdate(
                        env.DB,
                        voice.id,
                        createCloudflareVoiceTranscriber(env),
                        defaultVoiceSender(env),
                );
        }

        return failed.results.length;
}
