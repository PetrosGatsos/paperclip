// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { Monitor } from "./Monitor";

const mockDashboardApi = vi.hoisted(() => ({ summary: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ listCompact: vi.fn() }));
const mockAttentionApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockHeartbeatsApi = vi.hoisted(() => ({ liveRunsForCompany: vi.fn() }));
const liveEvent = vi.hoisted(() => ({ handler: null as ((event: any) => void) | null }));
const setBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

vi.mock("../api/dashboard", () => ({ dashboardApi: mockDashboardApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/attention", () => ({ attentionApi: mockAttentionApi }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: mockHeartbeatsApi }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    companies: [{ id: "company-1", issuePrefix: "PAP", name: "Paperclip" }],
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs }),
}));

vi.mock("../context/LiveUpdatesProvider", () => ({
  useCompanyLiveEvent: (handler: (event: any) => void) => {
    liveEvent.handler = handler;
  },
}));

const summary = {
  companyId: "company-1",
  agents: { active: 3, running: 2, paused: 1, error: 1 },
  tasks: { open: 7, inProgress: 2, blocked: 1, done: 9 },
  costs: { monthSpendCents: 100, monthBudgetCents: 1000, monthUtilizationPercent: 10 },
  pendingApprovals: 2,
  budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
  runActivity: [],
};

const currentTask = {
  id: "task-current",
  companyId: "company-1",
  identifier: "PAP-42",
  title: "Repair checkout worker",
  status: "blocked",
  priority: "critical",
  updatedAt: new Date().toISOString(),
};

const recentTask = {
  ...currentTask,
  id: "task-recent",
  identifier: "PAP-41",
  title: "Document recovery path",
  status: "done",
  priority: "medium",
};

const attentionItem = {
  id: "attention-1",
  companyId: "company-1",
  sourceKind: "approval",
  subject: {
    kind: "approval",
    id: "approval-1",
    companyId: "company-1",
    title: "Approve production deploy",
    identifier: null,
    status: "pending",
    href: "https://internal.invalid/secrets",
  },
  relatedIssue: null,
  whyNow: "A decision is waiting.",
  detail: null,
  severity: "critical",
  activityAt: new Date().toISOString(),
};

const liveRun = {
  id: "run-1",
  status: "running",
  invocationSource: "heartbeat",
  triggerDetail: "SENSITIVE_TRIGGER_CONTENT",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  createdAt: new Date().toISOString(),
  agentId: "agent-1",
  agentName: "Operator",
  adapterType: "codex_local",
  issueId: "task-current",
  currentStatusMessage: "SENSITIVE_CURRENT_STATUS_MESSAGE",
  currentStatusUpdatedAt: new Date().toISOString(),
  currentToolName: "https://internal.invalid/private-tool",
  lastAssistantSnippet: "SECRET_TRANSCRIPT_CONTENT",
  livenessReason: "SENSITIVE_LIVENESS_REASON",
  nextAction: "SENSITIVE_NEXT_ACTION",
};

async function settle(container: HTMLElement) {
  await vi.waitFor(() => expect(container.querySelector('[data-testid="monitor-page"]')).toBeTruthy());
}

describe("Monitor", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockDashboardApi.summary.mockResolvedValue(summary);
    mockIssuesApi.listCompact.mockImplementation((_companyId: string, filters: { status?: string }) =>
      Promise.resolve(filters.status?.includes("done") ? [recentTask] : [currentTask]));
    mockAttentionApi.list.mockResolvedValue({ items: [attentionItem], totalCount: 1 });
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([liveRun]);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    flushSync(() => {
      root.render(<QueryClientProvider client={queryClient}><Monitor /></QueryClientProvider>);
    });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    liveEvent.handler = null;
    vi.clearAllMocks();
  });

  it("renders critical health, all agent states, tasks, attention, and safe execution progress links", async () => {
    await settle(container);

    expect(container.textContent).toContain("Critical state");
    for (const label of ["Active", "Idle", "Paused", "Failed"]) {
      expect(container.textContent).toContain(label);
    }
    expect(container.textContent).toContain("Repair checkout worker");
    expect(container.textContent).toContain("Document recovery path");
    expect(container.textContent).toContain("Approve production deploy");
    expect(container.textContent).toContain("Run is in progress.");
    expect(container.textContent).not.toContain("SENSITIVE_CURRENT_STATUS_MESSAGE");
    expect(container.textContent).not.toContain("SECRET_TRANSCRIPT_CONTENT");
    expect(container.textContent).not.toContain("private-tool");
    expect(container.textContent).not.toContain("SENSITIVE_TRIGGER_CONTENT");
    expect(container.textContent).not.toContain("SENSITIVE_LIVENESS_REASON");
    expect(container.textContent).not.toContain("SENSITIVE_NEXT_ACTION");
    expect(container.querySelector('a[href="/decisions"]')).toBeTruthy();
    expect(container.querySelector('a[href="/issues/PAP-42"]')).toBeTruthy();
    expect(container.querySelector('a[href="/agents/agent-1/runs/run-1"]')).toBeTruthy();

    expect(queryClient.getQueryData(queryKeys.monitorLiveRuns("company-1"))).toEqual([{
      id: liveRun.id,
      status: liveRun.status,
      startedAt: liveRun.startedAt,
      finishedAt: liveRun.finishedAt,
      createdAt: liveRun.createdAt,
      agentId: liveRun.agentId,
      agentName: liveRun.agentName,
      issueId: liveRun.issueId,
    }]);
    expect(queryClient.getQueryData(queryKeys.liveRuns("company-1"))).toBeUndefined();
  });

  it("keeps the refresh action visible at a 360px viewport and refreshes without navigation", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
    await settle(container);
    const page = container.querySelector('[data-testid="monitor-page"]');
    const refreshButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Refresh"));
    expect(page?.className).toContain("max-w-full");
    expect(refreshButton).toBeTruthy();

    await vi.waitFor(() => expect(refreshButton?.disabled).toBe(false));
    flushSync(() => refreshButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await vi.waitFor(() => expect(mockDashboardApi.summary).toHaveBeenCalledTimes(2));
    expect(container.querySelector('[data-testid="monitor-page"]')).toBeTruthy();
  });

  it("uses the shared live-event subscription to refresh attention data", async () => {
    await settle(container);
    expect(liveEvent.handler).toBeTypeOf("function");

    flushSync(() => liveEvent.handler?.({
      type: "activity.logged",
      companyId: "company-1",
      payload: {},
      createdAt: new Date().toISOString(),
    }));

    await vi.waitFor(() => expect(mockAttentionApi.list).toHaveBeenCalledTimes(2));
  });

  it("refreshes the projected monitor run cache after run lifecycle events", async () => {
    await settle(container);
    expect(liveEvent.handler).toBeTypeOf("function");

    flushSync(() => liveEvent.handler?.({
      type: "heartbeat.run.status",
      companyId: "company-1",
      payload: { runId: liveRun.id, status: "succeeded" },
      createdAt: new Date().toISOString(),
    }));

    await vi.waitFor(() => expect(mockHeartbeatsApi.liveRunsForCompany).toHaveBeenCalledTimes(2));
  });
});
