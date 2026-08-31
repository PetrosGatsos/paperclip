import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  completionNotifications,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import type {
  CompletionMailDispatchOptions,
  CompletionMailMessage,
  MicrosoftGraphCompletionMailTransport,
  MicrosoftGraphMailSendResult,
} from "./microsoft-graph-completion-mail.js";
import {
  COMPLETION_READY_FOR_TESTING,
  evaluateCompletionNotificationEligibility,
  type CompletionNotificationChild,
  type CompletionNotificationParent,
} from "./completion-notification-readiness.js";
import {
  COMPLETION_NOTIFICATION_MAX_ATTEMPTS,
  COMPLETION_NOTIFICATION_RETRY_BASE_MS,
  COMPLETION_NOTIFICATION_RETRY_CAP_MS,
  completionNotificationCorrelationMarker,
  completionNotificationService,
  computeCompletionNotificationRetryDelayMs,
  type CompletionNotificationReconciler,
} from "./completion-notifications.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping completion notification persistence tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const RECIPIENTS = ["reviewer@example.invalid", "owner@example.invalid"] as const;
const BASE_NOW = new Date("2026-08-31T12:00:00.000Z");

type Db = ReturnType<typeof createDb>;

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

async function expectDatabaseRejection(
  operation: Promise<unknown>,
  expectedCause: RegExp,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(errorChain(error)).toMatch(expectedCause);
    return;
  }
  throw new Error("Expected the database operation to be rejected.");
}

function resultTransport(
  buildResult: (correlationId: string) => MicrosoftGraphMailSendResult,
  onSend?: (input: {
    message: CompletionMailMessage;
    options: CompletionMailDispatchOptions | undefined;
  }) => void,
): MicrosoftGraphCompletionMailTransport {
  return {
    async send(message, options) {
      onSend?.({ message, options });
      await options?.beforeDispatch?.();
      return buildResult(options?.correlationId ?? "missing-correlation");
    },
  };
}

function acceptedResult(correlationId: string): MicrosoftGraphMailSendResult {
  return {
    outcome: "accepted",
    correlationId,
    providerAcceptance: "accepted_not_delivered",
    providerMessageId: null,
    requestIdentifiers: {
      requestId: "graph-request-1",
      clientRequestId: correlationId,
    },
  };
}

function transientResult(correlationId: string): MicrosoftGraphMailSendResult {
  return {
    outcome: "rejected",
    correlationId,
    providerMessageId: null,
    requestIdentifiers: { requestId: "graph-request-transient", clientRequestId: correlationId },
    error: {
      category: "transient",
      httpStatus: 503,
      retryable: true,
      retryAfterSeconds: null,
      diagnostic: "Microsoft Graph returned a transient completion-mail error.",
    },
  };
}

function ambiguousResult(correlationId: string): MicrosoftGraphMailSendResult {
  return {
    outcome: "ambiguous",
    correlationId,
    providerMessageId: null,
    requestIdentifiers: { requestId: null, clientRequestId: null },
    automaticRetryAllowed: false,
    error: {
      category: "transport_outcome_unknown",
      httpStatus: null,
      retryable: false,
      retryAfterSeconds: null,
      diagnostic: "The Microsoft Graph connection ended before provider acceptance could be confirmed.",
    },
  };
}

describe("completion notification retry policy", () => {
  it("uses bounded exponential backoff with jitter and a hard cap", () => {
    expect(computeCompletionNotificationRetryDelayMs({ attemptCount: 1, random: () => 0.5 }))
      .toBe(COMPLETION_NOTIFICATION_RETRY_BASE_MS);
    expect(computeCompletionNotificationRetryDelayMs({ attemptCount: 2, random: () => 0 }))
      .toBe(COMPLETION_NOTIFICATION_RETRY_BASE_MS * 2 * 0.8);
    expect(computeCompletionNotificationRetryDelayMs({
      attemptCount: COMPLETION_NOTIFICATION_MAX_ATTEMPTS,
      retryAfterSeconds: 24 * 60 * 60,
      random: () => 1,
    })).toBe(COMPLETION_NOTIFICATION_RETRY_CAP_MS);
  });
});

describeEmbeddedPostgres("completion notification persistence and orchestration", () => {
  let db!: Db;
  let otherWorkerDb!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-completion-notifications-");
    db = createDb(tempDb.connectionString);
    otherWorkerDb = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(completionNotifications);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedParent(input: { companyId?: string; issueStatus?: string } = {}) {
    const companyId = input.companyId ?? randomUUID();
    if (!input.companyId) {
      await db.insert(companies).values({
        id: companyId,
        name: "Completion notification test",
        issuePrefix: `N${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      });
    }
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Email-triggered parent request",
      status: input.issueStatus ?? "in_review",
    });
    return { companyId, issueId };
  }

  function serviceFor(
    targetDb: Db,
    input: {
      transport?: MicrosoftGraphCompletionMailTransport;
      reconciler?: CompletionNotificationReconciler;
      createCorrelationId?: () => string;
      random?: () => number;
    } = {},
  ) {
    const transport = input.transport ?? resultTransport(acceptedResult);
    return completionNotificationService(targetDb, {
      transportForRecipients: (recipients) => {
        expect(recipients).toEqual(RECIPIENTS);
        return transport;
      },
      reconciler: input.reconciler,
      createCorrelationId: input.createCorrelationId,
      random: input.random ?? (() => 0.5),
    });
  }

  async function schedule(
    service: ReturnType<typeof completionNotificationService>,
    parent: { companyId: string; issueId: string },
    now = BASE_NOW,
  ) {
    const eligibility = evaluateCompletionNotificationEligibility({
      parent: readinessParent(parent.issueId),
      children: [],
    });
    const result = await service.schedule({
      companyId: parent.companyId,
      eligibility,
      recipients: RECIPIENTS,
      now,
    });
    if (result.outcome === "suppressed") {
      throw new Error(`Expected eligible completion notification, got ${result.reason}.`);
    }
    return { created: result.outcome === "created", notification: result.notification };
  }

  function readinessParent(
    issueId: string,
    overrides: Partial<CompletionNotificationParent> = {},
  ): CompletionNotificationParent {
    return {
      id: issueId,
      request: "Example",
      requestType: "Implementation request",
      implementationSummary: "Implemented the requested change.",
      paperclipReference: "N-101",
      implementationReference: "feat/example@abc123",
      status: COMPLETION_READY_FOR_TESTING,
      requiredValidationKinds: ["tests"],
      validationEvidence: [{ kind: "tests", status: "SUCCEEDED", reference: "test-run" }],
      requiredChildIds: [],
      ...overrides,
    };
  }

  it("creates one row under concurrent readiness events", async () => {
    const parent = await seedParent();
    const services = [serviceFor(db), serviceFor(otherWorkerDb)];
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => schedule(services[index % services.length]!, parent)),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.notification.id)).size).toBe(1);
    expect(await db.select().from(completionNotifications)).toHaveLength(1);
  });

  it("consumes parent readiness and suppresses mail while a required child is not ready", async () => {
    const parent = await seedParent();
    const child: CompletionNotificationChild = {
      id: randomUUID(),
      title: "Required child",
      status: "IN_PROGRESS",
      requiredValidationKinds: ["tests"],
      validationEvidence: [],
    };
    const eligibility = evaluateCompletionNotificationEligibility({
      parent: readinessParent(parent.issueId, { requiredChildIds: [child.id] }),
      children: [child],
    });

    await expect(serviceFor(db).schedule({
      companyId: parent.companyId,
      eligibility,
      recipients: RECIPIENTS,
      now: BASE_NOW,
    })).resolves.toEqual({
      outcome: "suppressed",
      reason: "required_child_not_ready",
      blockingChildIds: [child.id],
    });
    expect(await db.select().from(completionNotifications)).toHaveLength(0);
  });

  it("lets exactly one of two database workers claim the due row", async () => {
    const parent = await seedParent();
    await schedule(serviceFor(db), parent);
    const first = serviceFor(db);
    const second = serviceFor(otherWorkerDb);

    const claims = await Promise.all([
      first.claimNext({ companyId: parent.companyId, workerId: "worker-a", now: BASE_NOW }),
      second.claimNext({ companyId: parent.companyId, workerId: "worker-b", now: BASE_NOW }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({ status: "sending", attemptCount: 1 });
  });

  it("recovers an expired lease before dispatch and increments the attempt", async () => {
    const parent = await seedParent();
    const service = serviceFor(db);
    await schedule(service, parent);
    await service.claimNext({
      companyId: parent.companyId,
      workerId: "crashed-worker",
      now: BASE_NOW,
      leaseMs: 10,
    });

    const reclaimed = await serviceFor(otherWorkerDb).claimNext({
      companyId: parent.companyId,
      workerId: "restart-worker",
      now: new Date(BASE_NOW.getTime() + 11),
    });

    expect(reclaimed).toMatchObject({
      status: "sending",
      dispatchState: "not_started",
      leaseOwner: "restart-worker",
      attemptCount: 2,
    });
  });

  it("persists provider acceptance with immutable recipient and content snapshots", async () => {
    const parent = await seedParent();
    const observed = vi.fn();
    const service = serviceFor(db, {
      createCorrelationId: () => "correlation-accepted-1",
      transport: resultTransport(acceptedResult, observed),
    });
    const created = await schedule(service, parent);

    const processed = await service.processNext({
      companyId: parent.companyId,
      workerId: "success-worker",
      now: BASE_NOW,
    });

    expect(processed).toMatchObject({
      outcome: "sent",
      notification: {
        status: "sent",
        dispatchState: "accepted",
        recipientsSnapshot: RECIPIENTS,
        providerMessageId: null,
        providerRequestId: "graph-request-1",
        providerClientRequestId: "correlation-accepted-1",
        sentAt: BASE_NOW,
      },
    });
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({
        subject: "Implemented — Ready for Testing: Example",
        body: expect.stringContaining(
          completionNotificationCorrelationMarker("correlation-accepted-1"),
        ),
      }),
    }));
    await expectDatabaseRejection(db
      .update(completionNotifications)
      .set({ subjectSnapshot: "mutated" })
      .where(eq(completionNotifications.id, created.notification.id)), /immutable/i);
  });

  it("does not persist provider acceptance when a transport skips the durable dispatch marker", async () => {
    const parent = await seedParent();
    const transport: MicrosoftGraphCompletionMailTransport = {
      async send(_message, options) {
        return acceptedResult(options?.correlationId ?? "missing-correlation");
      },
    };
    const service = serviceFor(db, { transport });
    const scheduled = await schedule(service, parent);

    const result = await service.processNext({
      companyId: parent.companyId,
      workerId: "invalid-transport-worker",
      now: BASE_NOW,
    });

    expect(result).toEqual({
      outcome: "claim_lost",
      notificationId: scheduled.notification.id,
    });
    expect(await service.get(parent.companyId, scheduled.notification.id)).toMatchObject({
      status: "sending",
      dispatchState: "not_started",
    });
  });

  it("retries definite transient failures and stops at the attempt cap", async () => {
    const parent = await seedParent();
    const send = vi.fn();
    const transport = resultTransport((correlationId) => {
      send();
      return transientResult(correlationId);
    });
    const service = serviceFor(db, { transport });
    let currentTime = BASE_NOW;
    await schedule(service, parent, currentTime);
    let lastResult: Awaited<ReturnType<typeof service.processNext>> | null = null;

    for (let attempt = 1; attempt <= COMPLETION_NOTIFICATION_MAX_ATTEMPTS; attempt += 1) {
      lastResult = await service.processNext({
        companyId: parent.companyId,
        workerId: `retry-worker-${attempt}`,
        now: currentTime,
      });
      if (lastResult.outcome === "retry_scheduled") {
        currentTime = lastResult.notification.nextAttemptAt!;
      }
    }

    expect(send).toHaveBeenCalledTimes(COMPLETION_NOTIFICATION_MAX_ATTEMPTS);
    expect(lastResult).toMatchObject({
      outcome: "failed",
      notification: {
        status: "failed",
        attemptCount: COMPLETION_NOTIFICATION_MAX_ATTEMPTS,
        nextAttemptAt: null,
        errorCategory: "transient",
      },
    });
    await expect(service.processNext({
      companyId: parent.companyId,
      workerId: "forbidden-sixth-attempt",
      now: new Date(currentTime.getTime() + COMPLETION_NOTIFICATION_RETRY_CAP_MS),
    })).resolves.toEqual({ outcome: "idle" });
  });

  it("redacts credentials and mailbox addresses from persisted failure diagnostics", async () => {
    const parent = await seedParent();
    const service = serviceFor(db, {
      transport: resultTransport((correlationId) => ({
        outcome: "rejected",
        correlationId,
        providerMessageId: null,
        requestIdentifiers: { requestId: null, clientRequestId: correlationId },
        error: {
          category: "transient",
          httpStatus: 503,
          retryable: true,
          retryAfterSeconds: null,
          diagnostic:
            "Mailbox private@example.invalid failed with authorization: Bearer live-bearer-token-value.",
        },
      })),
    });
    await schedule(service, parent);

    const result = await service.processNext({
      companyId: parent.companyId,
      workerId: "redaction-worker",
      now: BASE_NOW,
    });

    expect(result).toMatchObject({
      outcome: "retry_scheduled",
      notification: { errorCategory: "transient" },
    });
    if (result.outcome !== "retry_scheduled") throw new Error("Expected a scheduled retry.");
    expect(result.notification.errorMessage).toContain("***REDACTED***");
    expect(result.notification.errorMessage).not.toContain("private@example.invalid");
    expect(result.notification.errorMessage).not.toContain("live-bearer-token-value");
  });

  it("reconciles an ambiguous outcome without a blind duplicate send", async () => {
    const parent = await seedParent();
    const send = vi.fn();
    const reconcile = vi.fn(async () => ({ outcome: "not_found" as const }));
    const service = serviceFor(db, {
      transport: resultTransport((correlationId) => {
        send();
        return ambiguousResult(correlationId);
      }),
      reconciler: { reconcile },
    });
    await schedule(service, parent);

    const result = await service.processNext({
      companyId: parent.companyId,
      workerId: "ambiguous-worker",
      now: BASE_NOW,
    });

    expect(result).toMatchObject({
      outcome: "operator_attention",
      notification: {
        status: "operator_attention",
        dispatchState: "ambiguous",
        nextAttemptAt: null,
        errorCategory: "reconciliation_not_found",
      },
    });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      correlationMarker: expect.stringContaining("Paperclip Notification:"),
    }));
    await expect(service.processNext({
      companyId: parent.companyId,
      workerId: "must-not-resend",
      now: new Date(BASE_NOW.getTime() + 86_400_000),
    })).resolves.toEqual({ outcome: "idle" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("handles crash boundaries before dispatch and after dispatch without duplicate sends", async () => {
    const preDispatchParent = await seedParent();
    const service = serviceFor(db);
    await schedule(service, preDispatchParent);
    const preDispatchClaim = await service.claimNext({
      companyId: preDispatchParent.companyId,
      workerId: "before-dispatch-crash",
      now: BASE_NOW,
      leaseMs: 10,
    });
    expect(preDispatchClaim).not.toBeNull();
    const safeRetry = await service.claimNext({
      companyId: preDispatchParent.companyId,
      workerId: "safe-restart",
      now: new Date(BASE_NOW.getTime() + 11),
    });
    expect(safeRetry).toMatchObject({ dispatchState: "not_started", attemptCount: 2 });

    await db.delete(completionNotifications);
    const postDispatchParent = await seedParent({ companyId: preDispatchParent.companyId });
    await schedule(service, postDispatchParent);
    const postDispatchClaim = await service.claimNext({
      companyId: postDispatchParent.companyId,
      workerId: "after-dispatch-crash",
      now: BASE_NOW,
      leaseMs: 10,
    });
    expect(postDispatchClaim).not.toBeNull();
    await service.markDispatchStarted({
      companyId: postDispatchParent.companyId,
      notificationId: postDispatchClaim!.id,
      workerId: "after-dispatch-crash",
      now: BASE_NOW,
    });
    const recovered = await service.recoverExpiredLeases(
      postDispatchParent.companyId,
      new Date(BASE_NOW.getTime() + 11),
    );
    expect(recovered.operatorAttention).toBe(1);
    await expect(service.claimNext({
      companyId: postDispatchParent.companyId,
      workerId: "unsafe-restart",
      now: new Date(BASE_NOW.getTime() + 12),
    })).resolves.toBeNull();
  });

  it("reconciles the crash after 202 but before sent persistence from the same correlation marker", async () => {
    const parent = await seedParent();
    const reconcile = vi.fn(async () => ({
      outcome: "found" as const,
      requestIdentifiers: { requestId: "found-request", clientRequestId: "found-client-request" },
    }));
    const service = serviceFor(db, { reconciler: { reconcile } });
    const scheduled = await schedule(service, parent);
    const claimed = await service.claimNext({
      companyId: parent.companyId,
      workerId: "accepted-before-crash",
      now: BASE_NOW,
      leaseMs: 10,
    });
    await service.markDispatchStarted({
      companyId: parent.companyId,
      notificationId: claimed!.id,
      workerId: "accepted-before-crash",
      now: BASE_NOW,
    });
    await service.recoverExpiredLeases(parent.companyId, new Date(BASE_NOW.getTime() + 11));

    const reconciled = await service.reconcileById({
      companyId: parent.companyId,
      notificationId: scheduled.notification.id,
      now: new Date(BASE_NOW.getTime() + 12),
    });

    expect(reconciled).toMatchObject({
      status: "sent",
      dispatchState: "accepted",
      providerMessageId: null,
      providerRequestId: "found-request",
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("classifies authorization failures and leaves implementation status untouched", async () => {
    const parent = await seedParent({ issueStatus: "in_review" });
    const service = serviceFor(db, {
      transport: resultTransport((correlationId) => ({
        outcome: "rejected",
        correlationId,
        providerMessageId: null,
        requestIdentifiers: { requestId: "scope-request", clientRequestId: correlationId },
        error: {
          category: "scope_or_permission",
          httpStatus: 403,
          retryable: false,
          retryAfterSeconds: null,
          diagnostic: "Microsoft Graph denied Mail.Send. Operator re-consent may be required.",
        },
      })),
    });
    await schedule(service, parent);

    const result = await service.processNext({
      companyId: parent.companyId,
      workerId: "scope-worker",
      now: BASE_NOW,
    });

    expect(result).toMatchObject({
      outcome: "failed",
      notification: { errorCategory: "scope_or_permission", nextAttemptAt: null },
    });
    const implementationIssue = await db
      .select({ status: issues.status, statusVersion: issues.statusVersion })
      .from(issues)
      .where(eq(issues.id, parent.issueId))
      .then((rows) => rows[0]);
    expect(implementationIssue).toEqual({ status: "in_review", statusVersion: 0 });
  });

  it("enforces migration checks and cross-company isolation", async () => {
    const first = await seedParent();
    const secondCompanyId = randomUUID();
    await db.insert(companies).values({
      id: secondCompanyId,
      name: "Other company",
      issuePrefix: `N${secondCompanyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    });
    const service = serviceFor(db);
    const created = await schedule(service, first);

    expect(await service.get(secondCompanyId, created.notification.id)).toBeNull();
    const crossCompanyEligibility = evaluateCompletionNotificationEligibility({
      parent: readinessParent(first.issueId),
      children: [],
    });
    await expect(service.schedule({
      companyId: secondCompanyId,
      eligibility: crossCompanyEligibility,
      recipients: RECIPIENTS,
      now: BASE_NOW,
    })).rejects.toThrow();
    await expect(db.execute(sql`
      update completion_notifications
      set status = 'pending'
      where id = ${created.notification.id}
    `)).resolves.toBeDefined();
    await expectDatabaseRejection(db.execute(sql`
      update completion_notifications
      set status = 'sent', dispatch_state = 'accepted', sent_at = now()
      where id = ${created.notification.id}
    `), /invalid completion notification status transition/i);

    await expectDatabaseRejection(db.execute(sql`
      update completion_notifications
      set dispatch_state = 'accepted'
      where id = ${created.notification.id}
    `), /completion_notifications_dispatch_state_check/i);
  });
});
