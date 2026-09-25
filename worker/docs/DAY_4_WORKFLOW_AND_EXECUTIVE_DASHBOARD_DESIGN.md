# Day 4 — Workflow and executive dashboard design

## Pilot workflow

1. Scheduler sends the daily stand-up request.
2. Employee replies by WhatsApp text or voice.
3. Dutha extracts progress, blockers, support needed and expected completion.
4. A blocker creates a coordination case in the correct tenant/project.
5. Manager approves, assigns a responsible person and sets duration.
6. Dutha creates the Jira ticket and shows a clickable Jira link.
7. Participants share availability; Dutha selects the earliest common time.
8. Manager adds the meeting link; Dutha sends it and records delivery status.
9. Jira or manager proposes resolution evidence.
10. Manager/requester verifies resolution or escalates the case.

## Dashboard information architecture

### Portfolio view

- Active projects, scheduled members and response rate
- Open blockers by priority and SLA state
- Cases awaiting approval, coordination and verification
- Integration health: WhatsApp, Jira, Teams and email
- Seven-day trend: response rate, blocker age and time to resolution

### Project view

- Today's response funnel: scheduled → submitted → processed → blocked
- Member status with last update and delivery state
- Blocker queue with owner, Jira key, SLA and next action
- Team workload and unresolved dependencies
- Recent workflow events and failed integrations

### Role lenses

| Role | Primary questions |
|---|---|
| CEO/portfolio leader | Which projects are at risk and how quickly are blockers resolving? |
| CTO/engineering leader | Which dependencies, owners or integrations are causing delay? |
| Project manager | Who has not responded, what needs approval, and what is the next action? |

## Status language

- Do not equate `submitted` or Meta `sent` with handset delivery.
- Display `submitted`, `sent`, `delivered`, `read` and `failed` separately.
- Every KPI must show its time window, tenant/project scope and denominator.
- Empty data must show “No evidence yet,” not a healthy zero.

## UI direction

- Modern calm control tower: navy foundation, blue actions, green success, amber risk and red breach.
- Compact left navigation, persistent project selector and role-aware actions.
- Responsive cards with subtle transitions; respect reduced-motion preferences.
- Keep operational tables for drill-down; charts are summaries, never the only evidence.
- Preserve server-rendered HTML and progressive enhancement for reliability.

## Implementation slices

1. Shared design tokens and application shell.
2. Portfolio KPI queries with tenant/project scoping tests.
3. Project response funnel and blocker/SLA cards.
4. Integration-health and delivery-status panels.
5. Trend charts and role-specific default views.

