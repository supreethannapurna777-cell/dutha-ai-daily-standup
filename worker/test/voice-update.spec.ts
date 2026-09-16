import { env } from "cloudflare:test";
import {
        beforeEach,
        describe,
        expect,
        it,
        vi,
} from "vitest";

import {
        acceptVoiceUpdate,
        createCloudflareVoiceExtractor,
        createCloudflareVoiceTranscriber,
        processVoiceReply,
        processVoiceUpdate,
} from "../src/voice-update";
import type { WorkerEnv } from "../src/env";


const voiceMessage = {
        whatsappMessageId: "wamid.voice-001",
        senderName: "Voice User",
        senderPhone: "919100000001",
        receivedAt: "2026-09-16T08:00:00.000Z",
        mediaId: "media-001",
        mimeType: "audio/ogg; codecs=opus",
};


describe("WhatsApp voice updates", () => {
        beforeEach(async () => {
                await env.DB.batch([
                        env.DB.prepare("DELETE FROM coordination_cases"),
                        env.DB.prepare("DELETE FROM processed_updates"),
                        env.DB.prepare("DELETE FROM incoming_messages"),
                        env.DB.prepare("DELETE FROM voice_update_events"),
                        env.DB.prepare("DELETE FROM voice_updates"),
                ]);
        });

        it("stores, transcribes, and requests confirmation without publishing", async () => {
                const id = await acceptVoiceUpdate(env.DB, voiceMessage);
                expect(id).toBeTypeOf("number");

                const sender = vi.fn().mockResolvedValue({ success: true });
                await processVoiceUpdate(
                        env.DB,
                        id as number,
                        async () => ({
                                text: [
                                        "Today I am deploying the Worker.",
                                        "No blockers. I will finish by 6 PM.",
                                ].join(" "),
                                language: "en",
                        }),
                        sender,
                );

                const voice = await env.DB.prepare(`
                        SELECT status, detected_language, original_transcript,
                                tasks, blockers, expected_completion
                        FROM voice_updates WHERE id = ?
                `).bind(id).first<Record<string, unknown>>();

                expect(voice?.status).toBe("awaiting_confirmation");
                expect(voice?.detected_language).toBe("en");
                expect(voice?.original_transcript).toContain("deploying the Worker");
                expect(sender).toHaveBeenCalledOnce();
                expect(sender.mock.calls[0][1]).toContain("Reply YES");

                const count = await env.DB.prepare(`
                        SELECT COUNT(*) AS count FROM processed_updates
                `).first<{ count: number }>();
                expect(count?.count).toBe(0);
        });

        it("publishes a confirmed voice update exactly once", async () => {
                const id = await acceptVoiceUpdate(env.DB, voiceMessage);
                const sender = vi.fn().mockResolvedValue({ success: true });
                await processVoiceUpdate(
                        env.DB,
                        id as number,
                        async () => ({
                                text: "Deploy the Worker. No blockers. Complete by 6 PM.",
                        }),
                        sender,
                );

                const first = await processVoiceReply(
                        env.DB,
                        voiceMessage.senderPhone,
                        "wamid.yes-001",
                        "YES",
                        sender,
                );
                const duplicate = await processVoiceReply(
                        env.DB,
                        voiceMessage.senderPhone,
                        "wamid.yes-001",
                        "YES",
                        sender,
                );

                expect(first.handled).toBe(true);
                expect(first.confirmed).toBe(true);
                expect(first.processedUpdateId).toBeTypeOf("number");
                expect(duplicate).toEqual({
                        handled: true,
                        duplicate: true,
                        confirmed: false,
                });

                const stored = await env.DB.prepare(`
                        SELECT incoming.original_reply, processed.tasks,
                                voice.status
                        FROM incoming_messages AS incoming
                        INNER JOIN processed_updates AS processed
                                ON processed.message_id = incoming.id
                        INNER JOIN voice_updates AS voice
                                ON voice.whatsapp_message_id
                                        = incoming.whatsapp_message_id
                `).first<{
                        original_reply: string;
                        tasks: string;
                        status: string;
                }>();
                expect(stored?.original_reply).toContain("Deploy the Worker");
                expect(stored?.status).toBe("confirmed");
        });

        it("treats a non-YES reply as a correction and asks again", async () => {
                const id = await acceptVoiceUpdate(env.DB, voiceMessage);
                const sender = vi.fn().mockResolvedValue({ success: true });
                await processVoiceUpdate(
                        env.DB,
                        id as number,
                        async () => ({ text: "Incorrect first transcript" }),
                        sender,
                );

                const correction = "Deploy API today. Blocked by database access. Finish tomorrow.";
                const result = await processVoiceReply(
                        env.DB,
                        voiceMessage.senderPhone,
                        "wamid.correction-001",
                        `CORRECT: ${correction}`,
                        sender,
                );

                expect(result).toEqual({
                        handled: true,
                        duplicate: false,
                        confirmed: false,
                });
                const voice = await env.DB.prepare(`
                        SELECT reporting_transcript, status
                        FROM voice_updates WHERE id = ?
                `).bind(id).first<{
                        reporting_transcript: string;
                        status: string;
                }>();
                expect(voice).toEqual({
                        reporting_transcript: correction,
                        status: "awaiting_confirmation",
                });
                expect(sender).toHaveBeenCalledTimes(2);
        });

        it("does not consume unrelated replies while confirmation is pending", async () => {
                const id = await acceptVoiceUpdate(env.DB, voiceMessage);
                await processVoiceUpdate(
                        env.DB,
                        id as number,
                        async () => ({ text: "Deploy the Worker today" }),
                        async () => ({ success: true }),
                );

                const result = await processVoiceReply(
                        env.DB,
                        voiceMessage.senderPhone,
                        "wamid.availability-001",
                        "CASE 14: 1,3",
                );
                expect(result).toEqual({
                        handled: false,
                        duplicate: false,
                        confirmed: false,
                });
        });

        it("records a retryable failure without publishing", async () => {
                const id = await acceptVoiceUpdate(env.DB, voiceMessage);
                await processVoiceUpdate(
                        env.DB,
                        id as number,
                        async () => {
                                throw new Error("Temporary transcription outage");
                        },
                        async () => ({ success: true }),
                );

                const voice = await env.DB.prepare(`
                        SELECT status, attempt_count, error_message
                        FROM voice_updates WHERE id = ?
                `).bind(id).first<{
                        status: string;
                        attempt_count: number;
                        error_message: string;
                }>();
                expect(voice).toEqual({
                        status: "failed",
                        attempt_count: 1,
                        error_message: "Temporary transcription outage",
                });
        });

        it("downloads Meta media and sends it to Cloudflare Workers AI", async () => {
                const fetcher = vi.fn()
                        .mockResolvedValueOnce(Response.json({
                                url: "https://media.example/voice",
                        }))
                        .mockResolvedValueOnce(new Response(
                                new Uint8Array([1, 2, 3]),
                                {
                                        headers: {
                                                "Content-Type": "audio/ogg",
                                        },
                                },
                        ));
                const run = vi.fn().mockResolvedValue({
                        text: "Deploy the Worker today",
                        transcription_info: {
                                language: "en",
                        },
                });
                const voiceEnv = {
                        WHATSAPP_API_VERSION: "v26.0",
                        WHATSAPP_ACCESS_TOKEN: "meta-token",
                        AI: { run },
                } as WorkerEnv;

                const transcribe = createCloudflareVoiceTranscriber(
                        voiceEnv,
                        fetcher,
                );
                const result = await transcribe(
                        "media-001",
                        "audio/ogg; codecs=opus",
                );

                expect(result).toEqual({
                        text: "Deploy the Worker today",
                        language: "en",
                });
                expect(fetcher).toHaveBeenCalledTimes(2);
                expect(fetcher.mock.calls[0][0]).toContain("/media-001");
                expect(run).toHaveBeenCalledWith(
                        "@cf/openai/whisper-large-v3-turbo",
                        expect.objectContaining({
                                audio: expect.any(String),
                                task: "transcribe",
                                vad_filter: true,
                        }),
                );
        });

        it("uses structured AI extraction for a natural spoken update", async () => {
                const run = vi.fn().mockResolvedValue({
                        response: JSON.stringify({
                                tasks: "Deploy the application and test the voice workflow",
                                people_to_connect: "Imran",
                                blockers: "Database access credentials are pending",
                                dependencies: "Database access credentials from Imran",
                                expected_completion: "6 PM today",
                        }),
                });
                const extractor = createCloudflareVoiceExtractor({
                        AI: { run },
                } as WorkerEnv);
                const transcript = [
                        "Today I am deploying the application and testing the voice workflow.",
                        "I need to coordinate with Imran.",
                        "I am blocked because database access credentials are pending.",
                        "I expect to finish by 6 PM today.",
                ].join(" ");

                const result = await extractor(transcript);

                expect(result).toEqual({
                        tasks: "Deploy the application and test the voice workflow",
                        people_to_connect: "Imran",
                        blockers: "Database access credentials are pending",
                        dependencies: "Database access credentials from Imran",
                        expected_completion: "6 PM today",
                        original_reply: transcript,
                });
                expect(run).toHaveBeenCalledWith(
                        "@cf/ibm-granite/granite-4.0-h-micro",
                        expect.objectContaining({
                                response_format: expect.objectContaining({
                                        type: "json_object",
                                }),
                                temperature: 0,
                        }),
                );
        });

        it("accepts Cloudflare structured output returned as a direct object", async () => {
                const run = vi.fn().mockResolvedValue({
                        tasks: "Deploy the application and test the voice workflow",
                        people_to_connect: "Imran",
                        blockers: "Database access credentials are pending",
                        dependencies: "Database access credentials from Imran",
                        expected_completion: "8 PM today",
                });
                const extractor = createCloudflareVoiceExtractor({
                        AI: { run },
                } as WorkerEnv);
                const transcript = "I am testing the voice workflow and expect to finish by 8 PM today.";

                await expect(extractor(transcript)).resolves.toEqual({
                        tasks: "Deploy the application and test the voice workflow",
                        people_to_connect: "Imran",
                        blockers: "Database access credentials are pending",
                        dependencies: "Database access credentials from Imran",
                        expected_completion: "8 PM today",
                        original_reply: transcript,
                });
        });
});
