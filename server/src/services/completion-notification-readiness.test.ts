import { describe, expect, it } from "vitest";
import {
  COMPLETION_READY_FOR_TESTING,
  composeCompletionNotification,
  evaluateCompletionNotificationEligibility,
  type CompletionNotificationChild,
  type CompletionNotificationParent,
} from "./completion-notification-readiness.js";

function successfulEvidence() {
  return [
    { kind: "tests", status: "SUCCEEDED" as const, reference: "test-run" },
    { kind: "build", status: "SUCCEEDED" as const, reference: "build-run" },
  ];
}

function parent(overrides: Partial<CompletionNotificationParent> = {}): CompletionNotificationParent {
  return {
    id: "parent-1",
    request: "Three mechanics simulations",
    requestType: "New simulation addition",
    implementationSummary: "Added the requested simulations and catalog entries.",
    paperclipReference: "SIM-101",
    implementationReference: "feat/mechanics@abc123",
    status: COMPLETION_READY_FOR_TESTING,
    requiredValidationKinds: ["tests", "build"],
    validationEvidence: successfulEvidence(),
    requiredChildIds: [],
    ...overrides,
  };
}

function child(id: string, overrides: Partial<CompletionNotificationChild> = {}): CompletionNotificationChild {
  return {
    id,
    title: `Simulation ${id}`,
    status: COMPLETION_READY_FOR_TESTING,
    requiredValidationKinds: ["tests", "build"],
    validationEvidence: successfulEvidence(),
    ...overrides,
  };
}

describe("completion notification readiness", () => {
  it("does not become eligible before the parent reaches canonical READY_FOR_TESTING", () => {
    expect(evaluateCompletionNotificationEligibility({
      parent: parent({ status: "IN_PROGRESS" }),
      children: [],
    })).toEqual({
      eligible: false,
      notificationKey: "parent-1",
      reason: "parent_not_ready",
      blockingChildIds: [],
    });
  });

  it("suppresses notification when required parent validation or build evidence is missing or unsuccessful", () => {
    for (const validationEvidence of [
      [{ kind: "tests", status: "SUCCEEDED" as const }],
      [
        { kind: "tests", status: "SUCCEEDED" as const },
        { kind: "build", status: "FAILED" as const },
      ],
    ]) {
      expect(evaluateCompletionNotificationEligibility({
        parent: parent({ validationEvidence }),
        children: [],
      })).toMatchObject({
        eligible: false,
        reason: "parent_validation_missing_or_unsuccessful",
      });
    }
  });

  it("aggregates multiple simulations under one stable parent notification key", () => {
    const first = child("child-1");
    const secondPending = child("child-2", { status: "IN_PROGRESS" });
    const request = parent({ requiredChildIds: [first.id, secondPending.id] });

    expect(evaluateCompletionNotificationEligibility({
      parent: request,
      children: [first, secondPending],
    })).toMatchObject({
      eligible: false,
      notificationKey: "parent-1",
      reason: "required_child_not_ready",
      blockingChildIds: ["child-2"],
    });

    const eligible = evaluateCompletionNotificationEligibility({
      parent: request,
      children: [first, child("child-2")],
    });
    expect(eligible).toMatchObject({
      eligible: true,
      notificationKey: "parent-1",
      children: [{ id: "child-1" }, { id: "child-2" }],
    });
  });

  it.each(["FAILED", "BLOCKED", "IN_PROGRESS", "PENDING"] as const)(
    "suppresses the parent notification while a required child is %s",
    (status) => {
      const blockedChild = child("child-1", { status });
      expect(evaluateCompletionNotificationEligibility({
        parent: parent({ requiredChildIds: [blockedChild.id] }),
        children: [blockedChild],
      })).toMatchObject({
        eligible: false,
        reason: "required_child_not_ready",
        blockingChildIds: ["child-1"],
      });
    },
  );

  it("suppresses the parent notification for a missing child or missing child validation evidence", () => {
    expect(evaluateCompletionNotificationEligibility({
      parent: parent({ requiredChildIds: ["missing-child"] }),
      children: [],
    })).toMatchObject({
      eligible: false,
      reason: "required_child_missing",
      blockingChildIds: ["missing-child"],
    });

    expect(evaluateCompletionNotificationEligibility({
      parent: parent({ requiredChildIds: ["child-1"] }),
      children: [child("child-1", { validationEvidence: [{ kind: "tests", status: "SUCCEEDED" }] })],
    })).toMatchObject({
      eligible: false,
      reason: "required_child_validation_missing_or_unsuccessful",
      blockingChildIds: ["child-1"],
    });
  });
});

describe("completion notification composition", () => {
  it("generates the required concise subject, body fields, and implementation references", () => {
    const eligibility = evaluateCompletionNotificationEligibility({ parent: parent(), children: [] });
    expect(eligibility.eligible).toBe(true);
    if (!eligibility.eligible) throw new Error("Expected an eligible notification fixture.");

    expect(composeCompletionNotification(eligibility)).toEqual({
      subject: "Implemented — Ready for Testing: Three mechanics simulations",
      body: [
        "The requested action has been successfully implemented and is ready for testing.",
        "Request:\nThree mechanics simulations",
        "Type:\nNew simulation addition",
        "Implementation:\nAdded the requested simulations and catalog entries.",
        "Status:\nReady for testing",
        "Paperclip Issue:\nSIM-101",
        "Implementation Reference:\nfeat/mechanics@abc123",
        "Automated by Paperclip.",
      ].join("\n\n"),
    });
  });

  it("lists every ready child in one consolidated parent message", () => {
    const first = child("projectile", { title: "Projectile Motion" });
    const second = child("momentum", { title: "Conservation of Momentum" });
    const eligibility = evaluateCompletionNotificationEligibility({
      parent: parent({ requiredChildIds: [first.id, second.id] }),
      children: [first, second],
    });
    expect(eligibility.eligible).toBe(true);
    if (!eligibility.eligible) throw new Error("Expected an eligible notification fixture.");

    const message = composeCompletionNotification(eligibility);
    expect(message.body).toContain("Completed:\n- Projectile Motion\n- Conservation of Momentum");
    expect(message.body.match(/Status:\nReady for testing/g)).toHaveLength(1);
  });

  it("normalizes subject and reference control characters", () => {
    const eligibility = evaluateCompletionNotificationEligibility({
      parent: parent({
        request: "Safe request\r\nBcc: injected@example.invalid",
        paperclipReference: "SIM-101\r\nX-Header: bad",
      }),
      children: [],
    });
    if (!eligibility.eligible) throw new Error("Expected an eligible notification fixture.");

    const message = composeCompletionNotification(eligibility);
    expect(message.subject).toBe("Implemented — Ready for Testing: Safe request Bcc: injected@example.invalid");
    expect(message.body).toContain("Paperclip Issue:\nSIM-101 X-Header: bad");
  });
});
