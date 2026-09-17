import type { WorkerEnv } from "./env";

export interface PreflightCheck {
        name: string;
        ready: boolean;
}

export interface DeploymentPreflight {
        ready: boolean;
        checks: PreflightCheck[];
        missing: string[];
}

function present(value: unknown): boolean {
        return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

export function evaluateDeploymentPreflight(env: WorkerEnv): DeploymentPreflight {
        const teamsEnabled = env.TEAMS_RELEASE_ENABLED?.trim().toLowerCase() === "true";
        const requirements: Array<[string, unknown]> = [
                ["DB binding", env.DB],
                ["AI binding", env.AI],
                ["Dashboard username", env.DASHBOARD_USERNAME],
                ["Dashboard password", env.DASHBOARD_PASSWORD],
                ["Dashboard session secret", env.DASHBOARD_SESSION_SECRET],
                ["WhatsApp access token", env.WHATSAPP_ACCESS_TOKEN],
                ["WhatsApp phone number ID", env.WHATSAPP_PHONE_NUMBER_ID],
                ["WhatsApp app secret", env.WHATSAPP_APP_SECRET],
                ["WhatsApp webhook verify token", env.WHATSAPP_WEBHOOK_VERIFY_TOKEN],
                ["Jira base URL", env.JIRA_BASE_URL],
                ["Jira email", env.JIRA_EMAIL],
                ["Jira API token", env.JIRA_API_TOKEN],
                ["Jira project key", env.JIRA_PROJECT_KEY],
                ["Jira webhook secret", env.JIRA_WEBHOOK_SECRET],
                ["Atlassian MCP authentication", env.ATLASSIAN_MCP_SERVICE_TOKEN || (env.ATLASSIAN_MCP_EMAIL && env.ATLASSIAN_MCP_API_TOKEN)],
        ];
        if (teamsEnabled) {
                requirements.push(
                        ["Microsoft app ID", env.MICROSOFT_APP_ID],
                        ["Microsoft app password", env.MICROSOFT_APP_PASSWORD],
                        ["Microsoft tenant ID", env.MICROSOFT_TENANT_ID],
                );
        }
        const checks = requirements.map(([name, value]) => ({ name, ready: present(value) }));
        const session = checks.find((check) => check.name === "Dashboard session secret");
        if (session && (env.DASHBOARD_SESSION_SECRET?.length ?? 0) < 32) session.ready = false;
        const missing = checks.filter((check) => !check.ready).map((check) => check.name);
        return { ready: missing.length === 0, checks, missing };
}

export function deploymentPreflightResponse(env: WorkerEnv): Response {
        const report = evaluateDeploymentPreflight(env);
        return Response.json(report, {
                status: report.ready ? 200 : 503,
                headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        });
}
