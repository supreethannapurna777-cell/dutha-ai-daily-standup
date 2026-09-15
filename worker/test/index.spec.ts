import {
        createExecutionContext,
        env,
        SELF,
        waitOnExecutionContext,
} from "cloudflare:test";
import {
        describe,
        expect,
        it,
} from "vitest";

import worker, {
        type WorkerEnv,
} from "../src/index";


const IncomingRequest =
        Request<unknown, IncomingRequestCfProperties>;

const testEnv: WorkerEnv = {
        ...env,
        WHATSAPP_WEBHOOK_VERIFY_TOKEN:
                "test-verify-token",
        DASHBOARD_USERNAME: "admin",
        DASHBOARD_PASSWORD: "test-password",
        DASHBOARD_SESSION_SECRET:
                "test-session-secret-that-is-long-enough",
};


async function callWorker(
        url: string,
        init?: RequestInit,
): Promise<Response> {
        const request = new IncomingRequest(url, init);
        const context = createExecutionContext();

        const response = await worker.fetch(
                request,
                testEnv,
                context,
        );

        await waitOnExecutionContext(context);

        return response;
}


describe("Dutha AI Daily Standup worker", () => {
        it(
                "returns a healthy service response",
                async () => {
                        const response = await SELF.fetch(
                                "https://example.com/",
                        );

                        expect(response.status).toBe(200);
                        expect(
                                await response.json(),
                        ).toEqual({
                                service:
                                        "Dutha AI Daily Standup",
                                status: "running",
                                environment:
                                        "cloudflare-worker",
                        });
                },
        );

        it(
                "verifies a valid Meta webhook request",
                async () => {
                        const response = await callWorker(
                                "https://example.com/webhook"
                                + "?hub.mode=subscribe"
                                + "&hub.verify_token=test-verify-token"
                                + "&hub.challenge=123456",
                        );

                        expect(response.status).toBe(200);
                        expect(
                                await response.text(),
                        ).toBe("123456");
                },
        );

        it(
                "rejects an invalid Meta verify token",
                async () => {
                        const response = await callWorker(
                                "https://example.com/webhook"
                                + "?hub.mode=subscribe"
                                + "&hub.verify_token=wrong-token"
                                + "&hub.challenge=123456",
                        );

                        expect(response.status).toBe(403);
                        expect(
                                await response.text(),
                        ).toBe("Forbidden");
                },
        );

        it(
                "routes availability management securely",
                async () => {
                        const response = await callWorker(
                                "https://example.com/dashboard/availability",
                        );

                        expect(response.status).toBe(302);
                        expect(response.headers.get("Location"))
                                .toContain("/login?next=");
                },
        );

        it("shows a dedicated management login page", async () => {
                const response = await callWorker("https://example.com/login");
                const html = await response.text();
                expect(response.status).toBe(200);
                expect(html).toContain("Welcome back");
                expect(html).toContain("Dutha");
                expect(html).toContain("type=\"password\"");
        });

        it("creates a secure session after valid login", async () => {
                const response = await callWorker(
                        "https://example.com/login",
                        {
                                method: "POST",
                                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                                body: "username=admin&password=test-password&next=%2Fdashboard",
                        },
                );
                expect(response.status).toBe(303);
                expect(response.headers.get("Location")).toBe("/dashboard");
                const cookie = response.headers.get("Set-Cookie") ?? "";
                expect(cookie).toContain("HttpOnly");
                expect(cookie).toContain("Secure");
                expect(cookie).toContain("SameSite=Strict");

                const dashboard = await callWorker(
                        "https://example.com/dashboard",
                        { headers: { Cookie: cookie.split(";")[0] } },
                );
                expect(dashboard.status).toBe(200);
                expect(await dashboard.text()).toContain("Dutha WorkOps");
        });

        it("does not redirect a successful login outside Dutha", async () => {
                const response = await callWorker(
                        "https://example.com/login",
                        {
                                method: "POST",
                                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                                body: "username=admin&password=test-password&next=https%3A%2F%2Fevil.example",
                        },
                );
                expect(response.headers.get("Location")).toBe("/dashboard");
        });

        it("rejects an invalid login without revealing which field failed", async () => {
                const response = await callWorker(
                        "https://example.com/login",
                        {
                                method: "POST",
                                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                                body: "username=admin&password=wrong",
                        },
                );
                expect(response.status).toBe(401);
                expect(await response.text()).toContain(
                        "The username or password is incorrect.",
                );
        });

        it(
                "returns 404 for an unknown route",
                async () => {
                        const response = await callWorker(
                                "https://example.com/unknown",
                        );

                        expect(response.status).toBe(404);
                        expect(
                                await response.json(),
                        ).toEqual({
                                error: "Not found",
                        });
                },
        );
});
