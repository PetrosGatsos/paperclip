import { useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AttentionItem, CompactIssue, DashboardSummary } from "@paperclipai/shared";
import {
  Activity,
  Bot,
  CheckCircle2,
  CircleAlert,
  CircleDot,
  Clock3,
  ExternalLink,
  Gauge,
  PauseCircle,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { dashboardApi } from "../api/dashboard";
import { attentionApi } from "../api/attention";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { IssueStatusBadge, StatusBadge } from "../components/StatusBadge";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useCompanyLiveEvent } from "../context/LiveUpdatesProvider";
import { useTranslation } from "../i18n";
import { attentionDetailLine } from "../lib/attention";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

const CURRENT_TASK_LIMIT = 6;
const RECENT_TASK_LIMIT = 4;
const ATTENTION_LIMIT = 6;

type HealthState = "healthy" | "attention" | "critical";
type MonitorRun = Pick<
  LiveRunForIssue,
  "id" | "status" | "startedAt" | "finishedAt" | "createdAt" | "agentId" | "agentName" | "issueId"
>;

function projectMonitorRun(run: LiveRunForIssue): MonitorRun {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
    agentId: run.agentId,
    agentName: run.agentName,
    issueId: run.issueId,
  };
}

const HEALTH_STYLES: Record<HealthState, string> = {
  healthy: "border-border bg-card",
  attention: "border-primary/40 bg-primary/5",
  critical: "border-destructive/50 bg-destructive/10",
};

function deriveHealth(summary: DashboardSummary, attention: AttentionItem[]): HealthState {
  if (
    summary.agents.error > 0 ||
    summary.tasks.blocked > 0 ||
    summary.budgets.activeIncidents > 0 ||
    attention.some((item) => item.severity === "critical")
  ) {
    return "critical";
  }
  if (
    summary.agents.paused > 0 ||
    summary.pendingApprovals > 0 ||
    attention.some((item) => item.severity === "high")
  ) {
    return "attention";
  }
  return "healthy";
}

function safeAppHref(value: string | null | undefined, fallback: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/api/")) {
    return fallback;
  }
  return value;
}

function HealthSummary({ state, summary }: { state: HealthState; summary: DashboardSummary }) {
  const { t } = useTranslation();
  const copy = {
    healthy: {
      label: t("monitor.health.healthy.label", { defaultValue: "Healthy" }),
      description: t("monitor.health.healthy.description", {
        defaultValue: "No failed agents, blocked tasks, or urgent decisions need attention.",
      }),
      icon: CheckCircle2,
    },
    attention: {
      label: t("monitor.health.attention.label", { defaultValue: "Needs attention" }),
      description: t("monitor.health.attention.description", {
        defaultValue: "Paused work or pending decisions need an operator review.",
      }),
      icon: ShieldAlert,
    },
    critical: {
      label: t("monitor.health.critical.label", { defaultValue: "Critical state" }),
      description: t("monitor.health.critical.description", {
        defaultValue: "Failed agents, blocked tasks, or critical decisions need action.",
      }),
      icon: CircleAlert,
    },
  }[state];
  const Icon = copy.icon;

  return (
    <section
      className={cn("rounded-lg border p-4 sm:p-5", HEALTH_STYLES[state])}
      data-health={state}
      role="status"
      aria-labelledby="monitor-health-title"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Icon className={cn("mt-0.5 size-5 shrink-0", state === "critical" ? "text-destructive" : "text-foreground")} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("monitor.overallHealth", { defaultValue: "Overall health" })}
          </p>
          <h2 id="monitor-health-title" className="mt-1 text-xl font-semibold text-foreground">{copy.label}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{copy.description}</p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{summary.tasks.blocked} {t("monitor.blockedTasks", { defaultValue: "blocked tasks" })}</span>
            <span>{summary.pendingApprovals} {t("monitor.pendingApprovals", { defaultValue: "pending approvals" })}</span>
            <span>{summary.budgets.activeIncidents} {t("monitor.budgetIncidents", { defaultValue: "budget incidents" })}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function AgentStateCard({ label, count, href, icon: Icon, critical = false }: {
  label: string;
  count: number;
  href: string;
  icon: typeof Bot;
  critical?: boolean;
}) {
  return (
    <Link
      to={href}
      className={cn(
        "min-w-0 rounded-lg border bg-card p-3 transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        critical && count > 0 && "border-destructive/50 bg-destructive/10",
      )}
      aria-label={`${label}: ${count}`}
    >
      <div className="flex items-center justify-between gap-2">
        <Icon className={cn("size-4 shrink-0 text-muted-foreground", critical && count > 0 && "text-destructive")} aria-hidden />
        <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      </div>
      <p className="mt-3 font-mono text-2xl font-semibold tabular-nums text-foreground">{count}</p>
      <p className="mt-1 truncate text-xs font-medium text-muted-foreground">{label}</p>
    </Link>
  );
}

function TaskRow({ task }: { task: CompactIssue }) {
  const { t } = useTranslation();
  const taskRef = task.identifier ?? task.id;
  return (
    <Link
      to={`/issues/${taskRef}`}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-md border border-border p-3 transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:justify-between",
        task.status === "blocked" && "border-destructive/50 bg-destructive/10",
      )}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {task.identifier ?? t("monitor.taskFallback", { defaultValue: "Task" })}
          </span>
          {task.priority === "critical" ? <Badge variant="destructive">{t("monitor.critical", { defaultValue: "Critical" })}</Badge> : null}
        </div>
        <p className="mt-1 break-words text-sm font-medium text-foreground">{task.title}</p>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {t("monitor.updated", { defaultValue: "Updated" })} {timeAgo(task.updatedAt)}
        </p>
      </div>
      <IssueStatusBadge status={task.status} />
    </Link>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const { t } = useTranslation();
  const detail = attentionDetailLine(item) ?? item.whyNow;
  const fallback = item.sourceKind === "approval" ? "/approvals/pending" : "/decisions";
  const href = safeAppHref(item.subject.href ?? item.relatedIssue?.href, fallback);
  return (
    <Link
      to={href}
      className={cn(
        "block min-w-0 rounded-md border border-border p-3 transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        item.severity === "critical" && "border-destructive/50 bg-destructive/10",
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="break-words text-sm font-medium text-foreground">
              {item.subject.title ?? item.subject.identifier ?? t("monitor.attentionItem", { defaultValue: "Attention item" })}
            </p>
            {item.severity === "critical" ? <Badge variant="destructive">{t("monitor.critical", { defaultValue: "Critical" })}</Badge> : null}
          </div>
          <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{detail}</p>
          <p className="mt-2 font-mono text-xs text-muted-foreground">{timeAgo(item.activityAt)}</p>
        </div>
        <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </div>
    </Link>
  );
}

function RunRow({ run }: { run: MonitorRun }) {
  const { t } = useTranslation();
  const active = run.status === "queued" || run.status === "running";
  const phase = {
    queued: t("monitor.runPhase.queued", { defaultValue: "Queued to start." }),
    running: t("monitor.runPhase.running", { defaultValue: "Run is in progress." }),
    succeeded: t("monitor.runPhase.succeeded", { defaultValue: "Run completed." }),
    failed: t("monitor.runPhase.failed", { defaultValue: "Run failed." }),
    cancelled: t("monitor.runPhase.cancelled", { defaultValue: "Run was cancelled." }),
    timed_out: t("monitor.runPhase.timedOut", { defaultValue: "Run timed out." }),
  }[run.status] ?? t("monitor.runPhase.unknown", { defaultValue: "Run status is unavailable." });
  const time = run.finishedAt ?? run.startedAt ?? run.createdAt;
  return (
    <div className="min-w-0 rounded-md border border-border p-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="break-words text-sm font-medium text-foreground">{run.agentName}</p>
            <StatusBadge status={run.status} />
          </div>
          <p className="mt-2 line-clamp-2 break-words text-xs text-muted-foreground">{phase}</p>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            {active ? t("monitor.progress", { defaultValue: "Progress" }) : t("monitor.finished", { defaultValue: "Finished" })} {timeAgo(time)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {run.issueId ? (
            <Button asChild variant="ghost" size="icon-xs">
              <Link to={`/issues/${run.issueId}`} aria-label={t("monitor.openTask", { defaultValue: "Open task" })}>
                <CircleDot aria-hidden />
              </Link>
            </Button>
          ) : null}
          <Button asChild variant="ghost" size="icon-xs">
            <Link to={`/agents/${run.agentId}/runs/${run.id}`} aria-label={t("monitor.openRun", { defaultValue: "Open run" })}>
              <ExternalLink aria-hidden />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Monitor() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: t("monitor.title", { defaultValue: "Monitor" }) }]);
  }, [setBreadcrumbs, t]);

  const dashboardQuery = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const currentTasksQuery = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "monitor", "current", CURRENT_TASK_LIMIT],
    queryFn: () => issuesApi.listCompact(selectedCompanyId!, {
      status: "todo,in_progress,in_review,blocked",
      limit: CURRENT_TASK_LIMIT,
      sortField: "updated",
      sortDir: "desc",
    }),
    enabled: !!selectedCompanyId,
  });
  const recentTasksQuery = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "monitor", "recent", RECENT_TASK_LIMIT],
    queryFn: () => issuesApi.listCompact(selectedCompanyId!, {
      status: "done,cancelled",
      limit: RECENT_TASK_LIMIT,
      sortField: "updated",
      sortDir: "desc",
    }),
    enabled: !!selectedCompanyId,
  });
  const attentionQuery = useQuery({
    queryKey: [...queryKeys.attention(selectedCompanyId!), "monitor", "activity", ATTENTION_LIMIT],
    queryFn: () => attentionApi.list(selectedCompanyId!, { sort: "activity", limit: ATTENTION_LIMIT }),
    enabled: !!selectedCompanyId,
  });
  const liveRunsQuery = useQuery({
    queryKey: queryKeys.monitorLiveRuns(selectedCompanyId!),
    queryFn: async () => {
      const runs = await heartbeatsApi.liveRunsForCompany(selectedCompanyId!);
      return runs.map(projectMonitorRun);
    },
    enabled: !!selectedCompanyId,
  });

  useCompanyLiveEvent((event) => {
    if (!selectedCompanyId || event.companyId !== selectedCompanyId) return;
    if (event.type === "activity.logged") {
      void queryClient.invalidateQueries({ queryKey: queryKeys.attention(selectedCompanyId) });
    }
    if (event.type === "heartbeat.run.queued" || event.type === "heartbeat.run.status") {
      void queryClient.invalidateQueries({ queryKey: queryKeys.monitorLiveRuns(selectedCompanyId) });
    }
  });

  const refresh = useCallback(async () => {
    await Promise.all([
      dashboardQuery.refetch(),
      currentTasksQuery.refetch(),
      recentTasksQuery.refetch(),
      attentionQuery.refetch(),
      liveRunsQuery.refetch(),
    ]);
  }, [attentionQuery, currentTasksQuery, dashboardQuery, liveRunsQuery, recentTasksQuery]);

  const isRefreshing = [dashboardQuery, currentTasksQuery, recentTasksQuery, attentionQuery, liveRunsQuery]
    .some((query) => query.isFetching);
  const lastUpdatedAt = Math.max(
    dashboardQuery.dataUpdatedAt,
    currentTasksQuery.dataUpdatedAt,
    recentTasksQuery.dataUpdatedAt,
    attentionQuery.dataUpdatedAt,
    liveRunsQuery.dataUpdatedAt,
  );
  const errors = [dashboardQuery.error, currentTasksQuery.error, recentTasksQuery.error, attentionQuery.error, liveRunsQuery.error]
    .filter(Boolean);
  const attentionItems = attentionQuery.data?.items ?? [];
  const summary = dashboardQuery.data;
  const health = useMemo(() => summary ? deriveHealth(summary, attentionItems) : "healthy", [attentionItems, summary]);

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={Gauge}
        message={companies.length === 0
          ? t("monitor.createCompany", { defaultValue: "Create a company to monitor operations." })
          : t("monitor.selectCompany", { defaultValue: "Select a company to monitor operations." })}
      />
    );
  }

  if (dashboardQuery.isPending) return <PageSkeleton variant="dashboard" />;

  if (!summary) {
    return (
      <EmptyState
        icon={CircleAlert}
        title={t("monitor.unavailable", { defaultValue: "Monitor unavailable" })}
        message={t("monitor.unavailableDescription", { defaultValue: "The monitor data could not be loaded." })}
        action={t("monitor.tryAgain", { defaultValue: "Try again" })}
        onAction={() => void refresh()}
        hideActionIcon
      />
    );
  }

  return (
    <div className="min-w-0 max-w-full space-y-5" data-testid="monitor-page">
      <header className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">{t("monitor.title", { defaultValue: "Monitor" })}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {t("monitor.description", { defaultValue: "Company health, active work, decisions, and execution progress in one view." })}
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground" aria-live="polite">
            {lastUpdatedAt > 0
              ? `${t("monitor.updated", { defaultValue: "Updated" })} ${timeAgo(new Date(lastUpdatedAt))}`
              : t("monitor.notUpdated", { defaultValue: "Not updated yet" })}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={isRefreshing}>
            <RefreshCw className={cn(isRefreshing && "animate-spin")} aria-hidden />
            {isRefreshing ? t("monitor.refreshing", { defaultValue: "Refreshing" }) : t("monitor.refresh", { defaultValue: "Refresh" })}
          </Button>
        </div>
      </header>

      {errors.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <p className="text-sm text-foreground">
            {t("monitor.partialError", { defaultValue: "Some monitor data could not be updated. Existing data remains visible." })}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>{t("monitor.tryAgain", { defaultValue: "Try again" })}</Button>
        </div>
      ) : null}

      <HealthSummary state={health} summary={summary} />

      <section aria-labelledby="monitor-agent-states">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 id="monitor-agent-states" className="text-sm font-semibold text-foreground">{t("monitor.agentStates", { defaultValue: "Agent states" })}</h2>
          <Link to="/agents/all" className="text-xs text-muted-foreground hover:text-foreground hover:underline">{t("monitor.viewAll", { defaultValue: "View all" })}</Link>
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-4">
          <AgentStateCard label={t("monitor.agentState.active", { defaultValue: "Active" })} count={summary.agents.running} href="/agents/active" icon={Activity} />
          <AgentStateCard label={t("monitor.agentState.idle", { defaultValue: "Idle" })} count={summary.agents.active} href="/agents/active" icon={Clock3} />
          <AgentStateCard label={t("monitor.agentState.paused", { defaultValue: "Paused" })} count={summary.agents.paused} href="/agents/paused" icon={PauseCircle} />
          <AgentStateCard label={t("monitor.agentState.failed", { defaultValue: "Failed" })} count={summary.agents.error} href="/agents/error" icon={CircleAlert} critical />
        </div>
      </section>

      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <Card className="min-w-0 gap-3 py-4">
          <CardHeader className="min-w-0 px-4">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <CardTitle className="text-sm">{t("monitor.currentTasks", { defaultValue: "Current tasks" })}</CardTitle>
              <Badge variant={summary.tasks.blocked > 0 ? "destructive" : "secondary"}>{summary.tasks.inProgress} {t("monitor.inProgress", { defaultValue: "in progress" })}</Badge>
            </div>
          </CardHeader>
          <CardContent className="min-w-0 space-y-2 px-4">
            {(currentTasksQuery.data ?? []).length > 0
              ? currentTasksQuery.data?.map((task) => <TaskRow key={task.id} task={task} />)
              : <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">{t("monitor.noCurrentTasks", { defaultValue: "No current tasks." })}</p>}
            <Button asChild variant="ghost" size="sm" className="w-full"><Link to="/issues">{t("monitor.openTasks", { defaultValue: "Open tasks" })}</Link></Button>
          </CardContent>
        </Card>

        <Card className="min-w-0 gap-3 py-4">
          <CardHeader className="min-w-0 px-4"><CardTitle className="text-sm">{t("monitor.recentTasks", { defaultValue: "Recent tasks" })}</CardTitle></CardHeader>
          <CardContent className="min-w-0 space-y-2 px-4">
            {(recentTasksQuery.data ?? []).length > 0
              ? recentTasksQuery.data?.map((task) => <TaskRow key={task.id} task={task} />)
              : <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">{t("monitor.noRecentTasks", { defaultValue: "No recently completed tasks." })}</p>}
          </CardContent>
        </Card>
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <Card className="min-w-0 gap-3 py-4">
          <CardHeader className="min-w-0 px-4">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <CardTitle className="text-sm">{t("monitor.pendingAndAttention", { defaultValue: "Pending approvals and attention" })}</CardTitle>
              <Button asChild variant="ghost" size="xs"><Link to="/approvals/pending">{summary.pendingApprovals} {t("monitor.pending", { defaultValue: "pending" })}</Link></Button>
            </div>
          </CardHeader>
          <CardContent className="min-w-0 space-y-2 px-4">
            {attentionItems.length > 0
              ? attentionItems.map((item) => <AttentionRow key={item.id} item={item} />)
              : <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">{t("monitor.noAttention", { defaultValue: "No recent attention items." })}</p>}
            <Button asChild variant="ghost" size="sm" className="w-full"><Link to="/decisions">{t("monitor.openDecisions", { defaultValue: "Open decisions" })}</Link></Button>
          </CardContent>
        </Card>

        <Card className="min-w-0 gap-3 py-4">
          <CardHeader className="min-w-0 px-4">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <CardTitle className="text-sm">{t("monitor.executionProgress", { defaultValue: "Execution progress" })}</CardTitle>
              <Badge variant="secondary">{liveRunsQuery.data?.length ?? 0} {t("monitor.live", { defaultValue: "live" })}</Badge>
            </div>
          </CardHeader>
          <CardContent className="min-w-0 space-y-2 px-4">
            {(liveRunsQuery.data ?? []).length > 0
              ? liveRunsQuery.data?.map((run) => <RunRow key={run.id} run={run} />)
              : <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">{t("monitor.noLiveRuns", { defaultValue: "No agent runs are active." })}</p>}
            <Button asChild variant="ghost" size="sm" className="w-full"><Link to="/dashboard/live">{t("monitor.openRuns", { defaultValue: "Open live and recent runs" })}</Link></Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
