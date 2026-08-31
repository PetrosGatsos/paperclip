import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { completionNotifications, type Db } from "@paperclipai/db";
import type { CompletionNotificationErrorCategory } from "@paperclipai/shared";
import type {
  MicrosoftGraphCompletionMailTransport,
  MicrosoftGraphMailSendResult,
  MicrosoftGraphRequestIdentifiers,
} from "./microsoft-graph-completion-mail.js";
import {
  composeCompletionNotification,
  type CompletionNotificationEligibility,
} from "./completion-notification-readiness.js";
import { REDACTED_EVENT_VALUE, redactSensitiveText } from "../redaction.js";

export const COMPLETION_NOTIFICATION_MAX_ATTEMPTS = 5;
export const COMPLETION_NOTIFICATION_LEASE_MS = 60_000;
export const COMPLETION_NOTIFICATION_RETRY_BASE_MS = 30_000;
export const COMPLETION_NOTIFICATION_RETRY_CAP_MS = 60 * 60 * 1_000;
export const COMPLETION_NOTIFICATION_CORRELATION_LABEL = "Paperclip Notification";

const MAX_ERROR_MESSAGE_LENGTH = 500;
const MAX_LEASE_OWNER_LENGTH = 200;
const EMAIL_LIKE_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

type CompletionNotificationRow = typeof completionNotifications.$inferSelect;

export type CompletionNotificationReconciliationResult =
  | {
      outcome: "found";
      requestIdentifiers?: MicrosoftGraphRequestIdentifiers;
    }
  | {
      outcome: "not_found" | "indeterminate" | "scope_or_permission";
    };

export type CompletionNotificationReconciler = {
  /**
   * Read the authenticated mailbox using its existing Mail.Read authorization.
   * Implementations search for the exact deterministic correlation marker.
   * A not-found result never authorizes an automatic resend.
   */
  reconcile(input: {
    correlationId: string;
    correlationMarker: string;
    createdAt: Date;
  }): Promise<CompletionNotificationReconciliationResult>;
};

export type CompletionNotificationProcessResult =
  | { outcome: "idle" }
  | { outcome: "sent"; notification: CompletionNotificationRow }
  | { outcome: "retry_scheduled" | "failed"; notification: CompletionNotificationRow }
  | { outcome: "operator_attention"; notification: CompletionNotificationRow }
  | { outcome: "claim_lost"; notificationId: string };

export type CompletionNotificationScheduleResult =
  | {
      outcome: "suppressed";
      reason: Extract<CompletionNotificationEligibility, { eligible: false }>["reason"];
      blockingChildIds: readonly string[];
    }
  | {
      outcome: "created" | "existing";
      notification: CompletionNotificationRow;
    };

function normalizeLeaseOwner(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_LEASE_OWNER_LENGTH);
  if (!normalized) throw new Error("Completion notification lease owner is required.");
  return normalized;
}

function safeErrorMessage(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return redactSensitiveText(normalized)
    .replace(EMAIL_LIKE_PATTERN, REDACTED_EVENT_VALUE)
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

export function completionNotificationCorrelationMarker(correlationId: string): string {
  return `${COMPLETION_NOTIFICATION_CORRELATION_LABEL}: ${correlationId}`;
}

export function appendCompletionNotificationCorrelationMarker(
  body: string,
  correlationId: string,
): string {
  return `${body.trimEnd()}\n\n${completionNotificationCorrelationMarker(correlationId)}`;
}

export function computeCompletionNotificationRetryDelayMs(input: {
  attemptCount: number;
  retryAfterSeconds?: number | null;
  random?: () => number;
}): number {
  const attempt = Math.max(1, Math.min(COMPLETION_NOTIFICATION_MAX_ATTEMPTS, input.attemptCount));
  const exponential = COMPLETION_NOTIFICATION_RETRY_BASE_MS * (2 ** (attempt - 1));
  const providerDelay = Math.max(0, (input.retryAfterSeconds ?? 0) * 1_000);
  const uncapped = Math.max(exponential, providerDelay);
  const random = Math.min(1, Math.max(0, (input.random ?? Math.random)()));
  const jittered = Math.round(uncapped * (0.8 + random * 0.4));
  return Math.min(COMPLETION_NOTIFICATION_RETRY_CAP_MS, jittered);
}

function reconciliationError(
  outcome: Exclude<CompletionNotificationReconciliationResult["outcome"], "found">,
): { category: CompletionNotificationErrorCategory; message: string } {
  if (outcome === "scope_or_permission") {
    return {
      category: "scope_or_permission",
      message: "Mailbox reconciliation lacks the required read authorization. Operator action is required.",
    };
  }
  if (outcome === "not_found") {
    return {
      category: "reconciliation_not_found",
      message: "Mailbox reconciliation did not find the correlation marker. Automatic resend remains disabled.",
    };
  }
  return {
    category: "reconciliation_indeterminate",
    message: "Mailbox reconciliation could not prove the provider outcome. Operator action is required.",
  };
}

function retryTransition(input: {
  row: CompletionNotificationRow;
  errorCategory: CompletionNotificationErrorCategory;
  errorMessage: string;
  retryable: boolean;
  retryAfterSeconds?: number | null;
  now: Date;
  random: () => number;
}) {
  const canRetry = input.retryable && input.row.attemptCount < COMPLETION_NOTIFICATION_MAX_ATTEMPTS;
  return {
    status: "failed" as const,
    dispatchState: "not_started" as const,
    errorCategory: input.errorCategory,
    errorMessage: safeErrorMessage(input.errorMessage),
    nextAttemptAt: canRetry
      ? new Date(input.now.getTime() + computeCompletionNotificationRetryDelayMs({
          attemptCount: input.row.attemptCount,
          retryAfterSeconds: input.retryAfterSeconds,
          random: input.random,
        }))
      : null,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: input.now,
  };
}

export function completionNotificationService(
  db: Db,
  dependencies: {
    transportForRecipients: (
      recipients: readonly [string, string],
    ) => MicrosoftGraphCompletionMailTransport;
    reconciler?: CompletionNotificationReconciler;
    createCorrelationId?: () => string;
    random?: () => number;
  },
) {
  const createCorrelationId = dependencies.createCorrelationId ?? randomUUID;
  const random = dependencies.random ?? Math.random;

  async function get(companyId: string, notificationId: string): Promise<CompletionNotificationRow | null> {
    return db
      .select()
      .from(completionNotifications)
      .where(and(
        eq(completionNotifications.companyId, companyId),
        eq(completionNotifications.id, notificationId),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function schedule(input: {
    companyId: string;
    eligibility: CompletionNotificationEligibility;
    recipients: readonly [string, string];
    now?: Date;
  }): Promise<CompletionNotificationScheduleResult> {
    if (!input.eligibility.eligible) {
      return {
        outcome: "suppressed",
        reason: input.eligibility.reason,
        blockingChildIds: input.eligibility.blockingChildIds,
      };
    }
    if (input.eligibility.notificationKey !== input.eligibility.parent.id) {
      throw new Error("The completion notification key must be the email-triggered parent issue id.");
    }
    const now = input.now ?? new Date();
    const correlationId = createCorrelationId();
    const message = composeCompletionNotification(input.eligibility);
    const created = await db
      .insert(completionNotifications)
      .values({
        companyId: input.companyId,
        parentIssueId: input.eligibility.parent.id,
        parentRequestKey: input.eligibility.notificationKey,
        recipientsSnapshot: [input.recipients[0], input.recipients[1]],
        subjectSnapshot: message.subject,
        bodySnapshot: appendCompletionNotificationCorrelationMarker(message.body, correlationId),
        implementationReference: input.eligibility.parent.implementationReference,
        paperclipCorrelationId: correlationId,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [completionNotifications.companyId, completionNotifications.parentRequestKey],
      })
      .returning()
      .then((rows) => rows[0] ?? null);

    if (created) return { outcome: "created", notification: created };
    const existing = await db
      .select()
      .from(completionNotifications)
      .where(and(
        eq(completionNotifications.companyId, input.companyId),
        eq(completionNotifications.parentRequestKey, input.eligibility.notificationKey),
      ))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw new Error("The completion notification uniqueness claim changed unexpectedly.");
    return { outcome: "existing", notification: existing };
  }

  async function recoverExpiredLeases(companyId: string, now = new Date()): Promise<{
    operatorAttention: number;
    cappedBeforeDispatch: number;
  }> {
    const operatorAttention = await db
      .update(completionNotifications)
      .set({
        status: "operator_attention",
        dispatchState: "ambiguous",
        errorCategory: "transport_outcome_unknown",
        errorMessage: "The worker lease expired after dispatch started. Automatic resend is disabled.",
        nextAttemptAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(and(
        eq(completionNotifications.companyId, companyId),
        eq(completionNotifications.status, "sending"),
        eq(completionNotifications.dispatchState, "started"),
        lte(completionNotifications.leaseExpiresAt, now),
      ))
      .returning({ id: completionNotifications.id });

    const cappedBeforeDispatch = await db
      .update(completionNotifications)
      .set({
        status: "failed",
        dispatchState: "not_started",
        errorCategory: "transient",
        errorMessage: "The worker lease expired before dispatch and the retry limit was reached.",
        nextAttemptAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(and(
        eq(completionNotifications.companyId, companyId),
        eq(completionNotifications.status, "sending"),
        eq(completionNotifications.dispatchState, "not_started"),
        lte(completionNotifications.leaseExpiresAt, now),
        eq(completionNotifications.attemptCount, COMPLETION_NOTIFICATION_MAX_ATTEMPTS),
      ))
      .returning({ id: completionNotifications.id });

    return {
      operatorAttention: operatorAttention.length,
      cappedBeforeDispatch: cappedBeforeDispatch.length,
    };
  }

  async function claimNext(input: {
    companyId: string;
    workerId: string;
    now?: Date;
    leaseMs?: number;
  }): Promise<CompletionNotificationRow | null> {
    const now = input.now ?? new Date();
    const workerId = normalizeLeaseOwner(input.workerId);
    await recoverExpiredLeases(input.companyId, now);

    return db.transaction(async (tx) => {
      const candidate = await tx
        .select()
        .from(completionNotifications)
        .where(and(
          eq(completionNotifications.companyId, input.companyId),
          sql`${completionNotifications.attemptCount} < ${COMPLETION_NOTIFICATION_MAX_ATTEMPTS}`,
          or(
            and(
              eq(completionNotifications.status, "pending"),
              or(
                isNull(completionNotifications.nextAttemptAt),
                lte(completionNotifications.nextAttemptAt, now),
              ),
            ),
            and(
              eq(completionNotifications.status, "failed"),
              lte(completionNotifications.nextAttemptAt, now),
            ),
            and(
              eq(completionNotifications.status, "sending"),
              eq(completionNotifications.dispatchState, "not_started"),
              lte(completionNotifications.leaseExpiresAt, now),
            ),
          ),
        ))
        .orderBy(asc(sql`coalesce(
          ${completionNotifications.nextAttemptAt},
          ${completionNotifications.leaseExpiresAt},
          ${completionNotifications.createdAt}
        )`))
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!candidate) return null;

      return tx
        .update(completionNotifications)
        .set({
          status: "sending",
          dispatchState: "not_started",
          attemptCount: sql`${completionNotifications.attemptCount} + 1`,
          nextAttemptAt: null,
          leaseOwner: workerId,
          leaseExpiresAt: new Date(now.getTime() + (input.leaseMs ?? COMPLETION_NOTIFICATION_LEASE_MS)),
          errorCategory: null,
          errorMessage: null,
          updatedAt: now,
        })
        .where(eq(completionNotifications.id, candidate.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    });
  }

  async function markDispatchStarted(input: {
    companyId: string;
    notificationId: string;
    workerId: string;
    now: Date;
  }): Promise<boolean> {
    const updated = await db
      .update(completionNotifications)
      .set({ dispatchState: "started", updatedAt: input.now })
      .where(and(
        eq(completionNotifications.companyId, input.companyId),
        eq(completionNotifications.id, input.notificationId),
        eq(completionNotifications.status, "sending"),
        eq(completionNotifications.dispatchState, "not_started"),
        eq(completionNotifications.leaseOwner, normalizeLeaseOwner(input.workerId)),
        gt(completionNotifications.leaseExpiresAt, input.now),
      ))
      .returning({ id: completionNotifications.id });
    return updated.length === 1;
  }

  async function finishClaim(
    row: CompletionNotificationRow,
    workerId: string,
    result: MicrosoftGraphMailSendResult,
    now: Date,
  ): Promise<CompletionNotificationRow | null> {
    if (result.outcome === "accepted") {
      return db
        .update(completionNotifications)
        .set({
          status: "sent",
          dispatchState: "accepted",
          providerMessageId: result.providerMessageId,
          providerRequestId: result.requestIdentifiers.requestId,
          providerClientRequestId: result.requestIdentifiers.clientRequestId,
          errorCategory: null,
          errorMessage: null,
          nextAttemptAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          sentAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(completionNotifications.companyId, row.companyId),
          eq(completionNotifications.id, row.id),
          eq(completionNotifications.status, "sending"),
          eq(completionNotifications.dispatchState, "started"),
          eq(completionNotifications.leaseOwner, normalizeLeaseOwner(workerId)),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
    }

    if (result.outcome === "ambiguous") {
      return db
        .update(completionNotifications)
        .set({
          status: "operator_attention",
          dispatchState: "ambiguous",
          providerMessageId: result.providerMessageId,
          providerRequestId: result.requestIdentifiers.requestId,
          providerClientRequestId: result.requestIdentifiers.clientRequestId,
          errorCategory: result.error.category,
          errorMessage: safeErrorMessage(result.error.diagnostic),
          nextAttemptAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(and(
          eq(completionNotifications.companyId, row.companyId),
          eq(completionNotifications.id, row.id),
          eq(completionNotifications.status, "sending"),
          eq(completionNotifications.dispatchState, "started"),
          eq(completionNotifications.leaseOwner, normalizeLeaseOwner(workerId)),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
    }

    const transition = retryTransition({
      row,
      errorCategory: result.error.category,
      errorMessage: result.error.diagnostic,
      retryable: result.error.retryable,
      retryAfterSeconds: result.error.retryAfterSeconds,
      now,
      random,
    });
    return db
      .update(completionNotifications)
      .set({
        ...transition,
        providerMessageId: result.providerMessageId,
        providerRequestId: result.requestIdentifiers.requestId,
        providerClientRequestId: result.requestIdentifiers.clientRequestId,
      })
      .where(and(
        eq(completionNotifications.companyId, row.companyId),
        eq(completionNotifications.id, row.id),
        eq(completionNotifications.status, "sending"),
        eq(completionNotifications.leaseOwner, normalizeLeaseOwner(workerId)),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function reconcile(notification: CompletionNotificationRow, now = new Date()) {
    if (!dependencies.reconciler) return notification;
    const result = await dependencies.reconciler.reconcile({
      correlationId: notification.paperclipCorrelationId,
      correlationMarker: completionNotificationCorrelationMarker(notification.paperclipCorrelationId),
      createdAt: notification.createdAt,
    });

    if (result.outcome === "found") {
      return db
        .update(completionNotifications)
        .set({
          status: "sent",
          dispatchState: "accepted",
          providerRequestId: result.requestIdentifiers?.requestId ?? notification.providerRequestId,
          providerClientRequestId:
            result.requestIdentifiers?.clientRequestId ?? notification.providerClientRequestId,
          errorCategory: null,
          errorMessage: null,
          sentAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(completionNotifications.companyId, notification.companyId),
          eq(completionNotifications.id, notification.id),
          eq(completionNotifications.status, "operator_attention"),
        ))
        .returning()
        .then((rows) => rows[0] ?? notification);
    }

    const error = reconciliationError(result.outcome);
    return db
      .update(completionNotifications)
      .set({
        errorCategory: error.category,
        errorMessage: error.message,
        updatedAt: now,
      })
      .where(and(
        eq(completionNotifications.companyId, notification.companyId),
        eq(completionNotifications.id, notification.id),
        eq(completionNotifications.status, "operator_attention"),
      ))
      .returning()
      .then((rows) => rows[0] ?? notification);
  }

  async function reconcileById(input: { companyId: string; notificationId: string; now?: Date }) {
    const row = await get(input.companyId, input.notificationId);
    if (!row || row.status !== "operator_attention") return null;
    return reconcile(row, input.now ?? new Date());
  }

  async function processNext(input: {
    companyId: string;
    workerId: string;
    now?: Date;
  }): Promise<CompletionNotificationProcessResult> {
    const now = input.now ?? new Date();
    const claimed = await claimNext({ ...input, now });
    if (!claimed) return { outcome: "idle" };
    if (claimed.recipientsSnapshot.length !== 2) {
      const failed = await finishClaim(claimed, input.workerId, {
        outcome: "rejected",
        correlationId: claimed.paperclipCorrelationId,
        providerMessageId: null,
        requestIdentifiers: { requestId: null, clientRequestId: null },
        error: {
          category: "provider_contract",
          httpStatus: null,
          retryable: false,
          retryAfterSeconds: null,
          diagnostic: "The immutable recipient snapshot does not contain exactly two recipients.",
        },
      }, now);
      return failed
        ? { outcome: "failed", notification: failed }
        : { outcome: "claim_lost", notificationId: claimed.id };
    }

    const recipients: readonly [string, string] = [
      claimed.recipientsSnapshot[0]!,
      claimed.recipientsSnapshot[1]!,
    ];
    const transport = dependencies.transportForRecipients(recipients);
    let dispatchStarted = false;
    let result: MicrosoftGraphMailSendResult;
    try {
      result = await transport.send(
        { subject: claimed.subjectSnapshot, body: claimed.bodySnapshot },
        {
          correlationId: claimed.paperclipCorrelationId,
          beforeDispatch: async () => {
            const marked = await markDispatchStarted({
              companyId: claimed.companyId,
              notificationId: claimed.id,
              workerId: input.workerId,
              now,
            });
            if (!marked) throw new Error("Completion notification claim expired before dispatch.");
            dispatchStarted = true;
          },
        },
      );
    } catch {
      result = dispatchStarted
        ? {
            outcome: "ambiguous",
            correlationId: claimed.paperclipCorrelationId,
            providerMessageId: null,
            requestIdentifiers: { requestId: null, clientRequestId: null },
            automaticRetryAllowed: false,
            error: {
              category: "transport_outcome_unknown",
              httpStatus: null,
              retryable: false,
              retryAfterSeconds: null,
              diagnostic: "The completion-mail transport failed after dispatch started.",
            },
          }
        : {
            outcome: "rejected",
            correlationId: claimed.paperclipCorrelationId,
            providerMessageId: null,
            requestIdentifiers: { requestId: null, clientRequestId: null },
            error: {
              category: "transient",
              httpStatus: null,
              retryable: true,
              retryAfterSeconds: null,
              diagnostic: "The completion-mail transport failed before dispatch.",
            },
          };
    }

    const finished = await finishClaim(claimed, input.workerId, result, now);
    if (!finished) return { outcome: "claim_lost", notificationId: claimed.id };
    if (finished.status === "sent") return { outcome: "sent", notification: finished };
    if (finished.status === "operator_attention") {
      const reconciled = await reconcile(finished, now);
      return reconciled.status === "sent"
        ? { outcome: "sent", notification: reconciled }
        : { outcome: "operator_attention", notification: reconciled };
    }
    return {
      outcome: finished.nextAttemptAt ? "retry_scheduled" : "failed",
      notification: finished,
    };
  }

  return {
    get,
    schedule,
    claimNext,
    markDispatchStarted,
    recoverExpiredLeases,
    reconcileById,
    processNext,
  };
}

export type CompletionNotificationService = ReturnType<typeof completionNotificationService>;
