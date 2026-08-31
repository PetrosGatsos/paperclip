import type { CompletionMailMessage } from "./microsoft-graph-completion-mail.js";

export const COMPLETION_READY_FOR_TESTING = "READY_FOR_TESTING";

export type CompletionWorkStatus =
  | typeof COMPLETION_READY_FOR_TESTING
  | "PENDING"
  | "IN_PROGRESS"
  | "BLOCKED"
  | "FAILED"
  | "CANCELLED";

export type CompletionValidationStatus = "SUCCEEDED" | "PENDING" | "RUNNING" | "FAILED";

export type CompletionValidationEvidence = {
  kind: string;
  status: CompletionValidationStatus;
  reference?: string | null;
};

export type CompletionNotificationChild = {
  id: string;
  title: string;
  status: CompletionWorkStatus;
  requiredValidationKinds: readonly string[];
  validationEvidence: readonly CompletionValidationEvidence[];
};

export type CompletionNotificationParent = {
  id: string;
  request: string;
  requestType: string;
  implementationSummary: string;
  paperclipReference: string;
  implementationReference: string;
  status: CompletionWorkStatus;
  requiredValidationKinds: readonly string[];
  validationEvidence: readonly CompletionValidationEvidence[];
  requiredChildIds: readonly string[];
};

export type CompletionNotificationSuppressionReason =
  | "parent_not_ready"
  | "parent_validation_missing_or_unsuccessful"
  | "required_child_missing"
  | "required_child_not_ready"
  | "required_child_validation_missing_or_unsuccessful";

export type CompletionNotificationEligibility =
  | {
      eligible: true;
      notificationKey: string;
      parent: CompletionNotificationParent;
      children: readonly CompletionNotificationChild[];
    }
  | {
      eligible: false;
      notificationKey: string;
      reason: CompletionNotificationSuppressionReason;
      blockingChildIds: readonly string[];
    };

function hasSuccessfulRequiredEvidence(
  requiredKinds: readonly string[],
  evidence: readonly CompletionValidationEvidence[],
): boolean {
  const normalizedRequiredKinds = Array.from(new Set(requiredKinds.map((kind) => kind.trim()).filter(Boolean)));
  if (normalizedRequiredKinds.length === 0) return false;
  return normalizedRequiredKinds.every((requiredKind) => {
    const matchingEvidence = evidence.filter((item) => item.kind.trim() === requiredKind);
    return matchingEvidence.length === 1 && matchingEvidence[0]?.status === "SUCCEEDED";
  });
}

/**
 * Evaluate the complete parent snapshot. The returned notification key is
 * always the parent id, so child transitions can only produce one parent claim.
 */
export function evaluateCompletionNotificationEligibility(input: {
  parent: CompletionNotificationParent;
  children: readonly CompletionNotificationChild[];
}): CompletionNotificationEligibility {
  const { parent } = input;
  if (parent.status !== COMPLETION_READY_FOR_TESTING) {
    return { eligible: false, notificationKey: parent.id, reason: "parent_not_ready", blockingChildIds: [] };
  }
  if (!hasSuccessfulRequiredEvidence(parent.requiredValidationKinds, parent.validationEvidence)) {
    return {
      eligible: false,
      notificationKey: parent.id,
      reason: "parent_validation_missing_or_unsuccessful",
      blockingChildIds: [],
    };
  }

  const childById = new Map(input.children.map((child) => [child.id, child]));
  const requiredChildIds = Array.from(new Set(parent.requiredChildIds));
  const missingChildIds = requiredChildIds.filter((childId) => !childById.has(childId));
  if (missingChildIds.length > 0) {
    return {
      eligible: false,
      notificationKey: parent.id,
      reason: "required_child_missing",
      blockingChildIds: missingChildIds,
    };
  }

  const requiredChildren = requiredChildIds.map((childId) => childById.get(childId)!);
  const nonReadyChildIds = requiredChildren
    .filter((child) => child.status !== COMPLETION_READY_FOR_TESTING)
    .map((child) => child.id);
  if (nonReadyChildIds.length > 0) {
    return {
      eligible: false,
      notificationKey: parent.id,
      reason: "required_child_not_ready",
      blockingChildIds: nonReadyChildIds,
    };
  }

  const unvalidatedChildIds = requiredChildren
    .filter((child) => !hasSuccessfulRequiredEvidence(child.requiredValidationKinds, child.validationEvidence))
    .map((child) => child.id);
  if (unvalidatedChildIds.length > 0) {
    return {
      eligible: false,
      notificationKey: parent.id,
      reason: "required_child_validation_missing_or_unsuccessful",
      blockingChildIds: unvalidatedChildIds,
    };
  }

  return {
    eligible: true,
    notificationKey: parent.id,
    parent,
    children: requiredChildren,
  };
}

function singleLine(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function plainText(value: string, maxLength: number): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength);
}

export function composeCompletionNotification(
  eligibility: Extract<CompletionNotificationEligibility, { eligible: true }>,
): CompletionMailMessage {
  const parent = eligibility.parent;
  const request = singleLine(parent.request, 200);
  const requestType = singleLine(parent.requestType, 120);
  const implementationSummary = plainText(parent.implementationSummary, 2_000);
  const paperclipReference = singleLine(parent.paperclipReference, 500);
  const implementationReference = singleLine(parent.implementationReference, 500);
  const completedChildren = eligibility.children.length > 0
    ? `\n\nCompleted:\n${eligibility.children
      .map((child) => `- ${singleLine(child.title, 200)}`)
      .join("\n")}`
    : "";

  return {
    subject: `Implemented — Ready for Testing: ${request}`,
    body: [
      "The requested action has been successfully implemented and is ready for testing.",
      `Request:\n${request}`,
      `Type:\n${requestType}`,
      `Implementation:\n${implementationSummary}${completedChildren}`,
      "Status:\nReady for testing",
      `Paperclip Issue:\n${paperclipReference}`,
      `Implementation Reference:\n${implementationReference}`,
      "Automated by Paperclip.",
    ].join("\n\n"),
  };
}
