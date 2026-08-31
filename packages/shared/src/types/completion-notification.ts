export const COMPLETION_NOTIFICATION_STATUSES = [
  "pending",
  "sending",
  "sent",
  "failed",
  "operator_attention",
] as const;

export type CompletionNotificationStatus = typeof COMPLETION_NOTIFICATION_STATUSES[number];

export const COMPLETION_NOTIFICATION_DISPATCH_STATES = [
  "not_started",
  "started",
  "accepted",
  "ambiguous",
] as const;

export type CompletionNotificationDispatchState =
  typeof COMPLETION_NOTIFICATION_DISPATCH_STATES[number];

export const COMPLETION_NOTIFICATION_ERROR_CATEGORIES = [
  "authentication",
  "scope_or_permission",
  "throttled",
  "transient",
  "provider_contract",
  "transport_outcome_unknown",
  "reconciliation_not_found",
  "reconciliation_indeterminate",
] as const;

export type CompletionNotificationErrorCategory =
  typeof COMPLETION_NOTIFICATION_ERROR_CATEGORIES[number];

export type CompletionNotificationRecipientsSnapshot = readonly [string, string];

export type CompletionNotificationRecord = {
  id: string;
  companyId: string;
  parentIssueId: string;
  parentRequestKey: string;
  status: CompletionNotificationStatus;
  dispatchState: CompletionNotificationDispatchState;
  recipientsSnapshot: CompletionNotificationRecipientsSnapshot;
  subjectSnapshot: string;
  bodySnapshot: string;
  implementationReference: string;
  paperclipCorrelationId: string;
  providerMessageId: string | null;
  providerRequestId: string | null;
  providerClientRequestId: string | null;
  errorCategory: CompletionNotificationErrorCategory | null;
  errorMessage: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
};
