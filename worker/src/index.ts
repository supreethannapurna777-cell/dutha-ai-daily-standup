import {
        availabilityManagementResponse,
} from "./availability-management";
import {
        caseManagementResponse,
} from "./case-management";
import {
        createDashboardResponse,
} from "./dashboard";
import type { WorkerEnv } from "./env";
import {
        dataDeletionResponse,
        privacyPolicyResponse,
        termsOfServiceResponse,
} from "./legal";
import {
        memberManagementResponse,
} from "./member-management";
import {
        verifyMetaSignature,
} from "./meta-signature";
import {
        runScheduledAction,
} from "./scheduler";
import {
        processWebhookPayload,
} from "./webhook";
import {
        sendTextMessage,
} from "./whatsapp";
import {
        acceptVoiceUpdate,
        createCloudflareVoiceTranscriber,
        createCloudflareVoiceExtractor,
        defaultVoiceSender,
        processVoiceUpdate,
        retryFailedVoiceUpdates,
} from "./voice-update";
import {
        authenticatedManagementRequest,
        loginResponse,
        logoutResponse,
} from "./auth";
import { projectManagementResponse } from "./project-management";
import { channelManagementResponse } from "./channel-management";

export type { WorkerEnv } from "./env";


function jsonResponse(
        body: unknown,
        status = 200,
): Response {
        return Response.json(body, { status });
}


function verifyWebhook(
        request: Request,
        env: WorkerEnv,
): Response {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const token =
                url.searchParams.get("hub.verify_token");
        const challenge =
                url.searchParams.get("hub.challenge");

        const isValid =
                mode === "subscribe"
                && Boolean(
                        env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
                )
                && token
                        === env.WHATSAPP_WEBHOOK_VERIFY_TOKEN
                && Boolean(challenge);

        if (!isValid) {
                return new Response(
                        "Forbidden",
                        { status: 403 },
                );
        }

        return new Response(
                challenge,
                {
                        status: 200,
                        headers: {
                                "Content-Type":
                                        "text/plain; charset=utf-8",
                        },
                },
        );
}


async function receiveWebhook(
        request: Request,
        env: WorkerEnv,
        context: ExecutionContext,
): Promise<Response> {
        if (!env.WHATSAPP_APP_SECRET) {
                return jsonResponse(
                        {
                                error:
                                        "Webhook security is not configured",
                        },
                        503,
                );
        }

        const rawBody = await request.text();

        const signatureIsValid =
                await verifyMetaSignature(
                        rawBody,
                        request.headers.get(
                                "X-Hub-Signature-256",
                        ),
                        env.WHATSAPP_APP_SECRET,
                );

        if (!signatureIsValid) {
                return jsonResponse(
                        {
                                error:
                                        "Invalid webhook signature",
                        },
                        401,
                );
        }

        let payload: unknown;

        try {
                payload = JSON.parse(rawBody);
        } catch {
                return jsonResponse(
                        {
                                error:
                                        "Invalid JSON payload",
                        },
                        400,
                );
        }

        const result =
                await processWebhookPayload(
                        payload,
                        env.DB,
                        new Date(),
                        (recipient, text) =>
                                sendTextMessage(
                                        env,
                                        recipient,
                                        text,
                                ),
                        async (message) => {
                                const id = await acceptVoiceUpdate(
                                        env.DB,
                                        message,
                                );
                                if (!id) {
                                        return false;
                                }

                                context.waitUntil(
                                        processVoiceUpdate(
                                                env.DB,
                                                id,
                                                createCloudflareVoiceTranscriber(env),
                                                defaultVoiceSender(env),
                                                createCloudflareVoiceExtractor(env),
                                        ),
                                );
                                return true;
                        },
                        createCloudflareVoiceExtractor(env),
                );

        console.log(
                JSON.stringify({
                        event:
                                "whatsapp_webhook_processed",
                        received: result.received,
                        duplicates:
                                result.duplicates,
                        ignored: result.ignored,
                }),
        );

        return jsonResponse({
                status: "EVENT_RECEIVED",
                ...result,
        });
}


export default {
        async fetch(
                request: Request,
                env: WorkerEnv,
                context: ExecutionContext,
        ): Promise<Response> {
                const url = new URL(request.url);

                if (
                        request.method === "GET"
                        && url.pathname === "/"
                ) {
                        return jsonResponse({
                                service:
                                        "Dutha AI Daily Standup",
                                status: "running",
                                environment:
                                        "cloudflare-worker",
                        });
                }

                if (
                        request.method === "GET"
                        && url.pathname === "/webhook"
                ) {
                        return verifyWebhook(
                                request,
                                env,
                        );
                }

                if (
                        request.method === "POST"
                        && url.pathname === "/webhook"
                ) {
                        return receiveWebhook(
                                request,
                                env,
                                context,
                        );
                }

                if (
                        request.method === "GET"
                        && url.pathname === "/privacy"
                ) {
                        return privacyPolicyResponse();
                }

                if (
                        request.method === "GET"
                        && url.pathname
                                === "/data-deletion"
                ) {
                        return dataDeletionResponse();
                }

                if (
                        request.method === "GET"
                        && url.pathname === "/terms"
                ) {
                        return termsOfServiceResponse();
                }

                if (url.pathname === "/login") {
                        return loginResponse(request, env);
                }

                if (url.pathname === "/logout") {
                        if (request.method !== "POST") {
                                return new Response("Method not allowed", { status: 405 });
                        }
                        return logoutResponse();
                }

                let managementRequest = request;
                if (url.pathname.startsWith("/dashboard")) {
                        const authenticated = await authenticatedManagementRequest(request, env);
                        if (!authenticated) {
                                if (request.method === "GET") {
                                        const next = url.pathname + url.search;
                                        return Response.redirect(
                                                `${url.origin}/login?next=${encodeURIComponent(next)}`,
                                                302,
                                        );
                                }
                                return new Response("Authentication required.", { status: 401 });
                        }
                        managementRequest = authenticated;
                }

                if (
                        request.method === "GET"
                        && url.pathname === "/dashboard"
                ) {
                        return createDashboardResponse(
                                managementRequest,
                                env,
                        );
                }

                if (
                        url.pathname
                                === "/dashboard/members"
                ) {
                        return memberManagementResponse(
                                managementRequest,
                                env,
                        );
                }

                if (
                        url.pathname
                                === "/dashboard/cases"
                ) {
                        return caseManagementResponse(
                                managementRequest,
                                env,
                        );
                }

                if (
                        url.pathname
                                === "/dashboard/availability"
                ) {
                        return availabilityManagementResponse(
                                managementRequest,
                                env,
                        );
                }

                if (url.pathname === "/dashboard/projects") {
                        return projectManagementResponse(managementRequest, env);
                }

                if (url.pathname === "/dashboard/channels") {
                        return channelManagementResponse(managementRequest, env);
                }

                return jsonResponse(
                        { error: "Not found" },
                        404,
                );
        },

        async scheduled(
                controller: ScheduledController,
                env: WorkerEnv,
                context: ExecutionContext,
        ): Promise<void> {
                context.waitUntil(
                        Promise.all([
                                runScheduledAction(
                                        controller.cron,
                                        controller.scheduledTime,
                                        env,
                                ),
                                retryFailedVoiceUpdates(env),
                        ]).then(() => undefined),
                );
        },
} satisfies ExportedHandler<WorkerEnv>;
