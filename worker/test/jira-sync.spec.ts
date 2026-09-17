import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
        syncApprovedCaseToJira,
        type JiraConfig,
} from "../src/jira-sync";

const config: JiraConfig = {
        baseUrl: "https://example.atlassian.net",
        email: "integration@example.com",
        apiToken: "test-token",
        projectKey: "DUTHA",
        issueType: "Task",
};

describe("Jira outbound case sync", () => {
        let caseId: number;

        beforeEach(async () => {
                await env.DB.batch([
                        env.DB.prepare("DELETE FROM jira_case_links"),
                        env.DB.prepare("DELETE FROM case_events"),
                        env.DB.prepare("DELETE FROM coordination_cases"),
                        env.DB.prepare("DELETE FROM processed_updates"),
                        env.DB.prepare("DELETE FROM incoming_messages"),
                        env.DB.prepare("DELETE FROM team_members"),
                ]);
                const requester = await env.DB.prepare(`
                        INSERT INTO team_members (
                                name, phone, department, tenant_id, primary_project_id
                        ) VALUES ('Supreeth', '919100000010', 'Management', 1, 1)
                        RETURNING id
                `).first<{ id: number }>();
                const responsible = await env.DB.prepare(`
                        INSERT INTO team_members (
                                name, phone, department, tenant_id, primary_project_id
                        ) VALUES ('Imran', '919100000011', 'Platform', 1, 1)
                        RETURNING id
                `).first<{ id: number }>();
                const incoming = await env.DB.prepare(`
                        INSERT INTO incoming_messages (
                                whatsapp_message_id, received_at, sender_name,
                                sender_phone, original_reply, processing_status,
                                tenant_id, project_id, channel, external_message_id,
                                sender_external_id, team_member_id
                        ) VALUES (
                                'wamid.jira-test', '2026-09-17T06:00:00.000Z',
                                'Supreeth', '919100000010', 'Blocked by Jira access',
                                'processed', 1, 1, 'whatsapp', 'wamid.jira-test',
                                '919100000010', ?
                        ) RETURNING id
                `).bind(requester!.id).first<{ id: number }>();
                const processed = await env.DB.prepare(`
                        INSERT INTO processed_updates (
                                message_id, sender_name, blockers, original_reply,
                                processing_status, tenant_id, project_id
                        ) VALUES (?, 'Supreeth', 'Blocked by Jira access',
                                'Blocked by Jira access', 'processed', 1, 1)
                        RETURNING id
                `).bind(incoming!.id).first<{ id: number }>();
                const coordinationCase = await env.DB.prepare(`
                        INSERT INTO coordination_cases (
                                source_update_id, requester_member_id,
                                responsible_member_id, case_type, issue_summary,
                                status, priority, tenant_id, project_id,
                                resolution_state, sla_due_at
                        ) VALUES (?, ?, ?, 'blocker', 'Blocked by Jira access',
                                'approved', 'high', 1, 1, 'triaged',
                                '2026-09-18T06:00:00.000Z') RETURNING id
                `).bind(processed!.id, requester!.id, responsible!.id)
                        .first<{ id: number }>();
                caseId = coordinationCase!.id;
        });

        it("creates one Jira issue and stores the durable link", async () => {
                const fetcher = vi.fn().mockResolvedValue(Response.json({
                        id: "10001",
                        key: "DUTHA-42",
                }, { status: 201 }));
                const first = await syncApprovedCaseToJira(
                        env.DB,
                        caseId,
                        config,
                        fetcher,
                );
                const second = await syncApprovedCaseToJira(
                        env.DB,
                        caseId,
                        config,
                        fetcher,
                );
                expect(first).toEqual({ status: "synced", issueKey: "DUTHA-42" });
                expect(second).toEqual({ status: "already_synced", issueKey: "DUTHA-42" });
                expect(fetcher).toHaveBeenCalledOnce();
                expect(fetcher.mock.calls[0][0]).toBe(
                        "https://example.atlassian.net/rest/api/3/issue",
                );
                const request = fetcher.mock.calls[0][1] as RequestInit;
                const payload = JSON.parse(String(request.body));
                expect(payload.fields).toMatchObject({
                        project: { key: "DUTHA" },
                        issuetype: { name: "Task" },
                        summary: "[Dutha] Blocked by Jira access",
                });
                expect(JSON.stringify(payload)).not.toContain("test-token");
                expect(await env.DB.prepare(`
                        SELECT sync_status, external_issue_id,
                                external_issue_key, external_issue_url,
                                attempt_count, last_error
                        FROM jira_case_links WHERE case_id = ?
                `).bind(caseId).first()).toEqual({
                        sync_status: "synced",
                        external_issue_id: "10001",
                        external_issue_key: "DUTHA-42",
                        external_issue_url: "https://example.atlassian.net/browse/DUTHA-42",
                        attempt_count: 1,
                        last_error: null,
                });
        });

        it("records a failure and safely retries", async () => {
                const fetcher = vi.fn()
                        .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
                        .mockResolvedValueOnce(Response.json({
                                id: "10002",
                                key: "DUTHA-43",
                        }, { status: 201 }));
                expect((await syncApprovedCaseToJira(
                        env.DB,
                        caseId,
                        config,
                        fetcher,
                )).status).toBe("failed");
                expect((await syncApprovedCaseToJira(
                        env.DB,
                        caseId,
                        config,
                        fetcher,
                )).status).toBe("synced");
                expect(fetcher).toHaveBeenCalledTimes(2);
                expect(await env.DB.prepare(`
                        SELECT sync_status, attempt_count, last_error
                        FROM jira_case_links WHERE case_id = ?
                `).bind(caseId).first()).toEqual({
                        sync_status: "synced",
                        attempt_count: 2,
                        last_error: null,
                });
        });

        it("does not create Jira work before case approval", async () => {
                await env.DB.prepare(`
                        UPDATE coordination_cases SET status = 'pending_approval'
                        WHERE id = ?
                `).bind(caseId).run();
                const fetcher = vi.fn();
                expect(await syncApprovedCaseToJira(
                        env.DB,
                        caseId,
                        config,
                        fetcher,
                )).toEqual({ status: "not_ready" });
                expect(fetcher).not.toHaveBeenCalled();
        });
});
