import { describe, expect, it, vi } from "vitest";
import {
  createMicrosoftGraphCompletionMailTransport,
  extendMicrosoftGraphDelegatedAuthorizationUrl,
  extendMicrosoftGraphDelegatedScopes,
  GRAPH_COMPLETION_MAIL_RECIPIENTS_ENV,
  GRAPH_COMPLETION_MAIL_SENDER_ENV,
  MICROSOFT_GRAPH_MAIL_SEND_ENDPOINT,
  resolveMicrosoftGraphCompletionMailConfig,
  type MicrosoftGraphAccessContext,
  type MicrosoftGraphCompletionMailConfig,
} from "./microsoft-graph-completion-mail.js";

const CONFIG: MicrosoftGraphCompletionMailConfig = {
  recipients: ["reviewer@example.invalid", "owner@example.invalid"],
  authenticatedSender: "owner@example.invalid",
};

const ACCESS: MicrosoftGraphAccessContext = {
  accessToken: "synthetic-access-token",
  authenticatedMailbox: "owner@example.invalid",
  grantedScopes: ["Mail.Read", "Mail.Send"],
};

const MESSAGE = {
  subject: "Implemented — Ready for Testing: Example",
  body: "Status:\nReady for testing",
};

function transportWith(fetchImpl: typeof fetch, access: MicrosoftGraphAccessContext = ACCESS) {
  return createMicrosoftGraphCompletionMailTransport({
    config: CONFIG,
    fetchImpl,
    acquireAccessContext: async () => access,
    createCorrelationId: () => "notification-correlation-123",
    now: () => new Date("2026-08-26T12:00:00.000Z"),
  });
}

describe("Microsoft Graph delegated authorization", () => {
  it("preserves the existing read scopes and adds Mail.Send once", () => {
    expect(extendMicrosoftGraphDelegatedScopes(["openid", "offline_access", "Mail.Read", "mail.send"])).toEqual([
      "openid",
      "offline_access",
      "Mail.Read",
      "mail.send",
    ]);

    const url = extendMicrosoftGraphDelegatedAuthorizationUrl(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=client&scope=openid%20offline_access%20Mail.Read",
    );
    expect(url.searchParams.get("scope")).toBe("openid offline_access Mail.Read Mail.Send");

    expect(() => extendMicrosoftGraphDelegatedAuthorizationUrl(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=client&scope=openid%20offline_access",
    )).toThrow("existing Mail.Read scope");
  });
});

describe("Microsoft Graph completion-mail configuration", () => {
  it("resolves exactly the two injected non-real recipients and authenticated sender", () => {
    const config = resolveMicrosoftGraphCompletionMailConfig({
      [GRAPH_COMPLETION_MAIL_RECIPIENTS_ENV]: " Reviewer@Example.Invalid,owner@example.invalid,reviewer@example.invalid ",
      [GRAPH_COMPLETION_MAIL_SENDER_ENV]: " Owner@Example.Invalid ",
    });

    expect(config).toEqual({
      recipients: ["reviewer@example.invalid", "owner@example.invalid"],
      authenticatedSender: "owner@example.invalid",
    });
  });

  it("rejects recipient configuration that does not resolve to two unique addresses", () => {
    expect(() => resolveMicrosoftGraphCompletionMailConfig({
      [GRAPH_COMPLETION_MAIL_RECIPIENTS_ENV]: "owner@example.invalid",
      [GRAPH_COMPLETION_MAIL_SENDER_ENV]: "owner@example.invalid",
    })).toThrow("exactly two unique email addresses");
  });
});

describe("Microsoft Graph completion-mail transport", () => {
  it("uses the authenticated mailbox through /me/sendMail without a spoofable sender field", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));

    await transportWith(fetchImpl).send(MESSAGE);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(MICROSOFT_GRAPH_MAIL_SEND_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer synthetic-access-token",
      "client-request-id": "notification-correlation-123",
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      message: {
        subject: MESSAGE.subject,
        body: { contentType: "Text", content: MESSAGE.body },
        toRecipients: [
          { emailAddress: { address: "reviewer@example.invalid" } },
          { emailAddress: { address: "owner@example.invalid" } },
        ],
      },
      saveToSentItems: true,
    });
    expect(JSON.stringify(body).toLowerCase()).not.toContain('"from"');
  });

  it("treats 202 with no response body as provider acceptance, not confirmed delivery", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 202,
      headers: {
        "request-id": "graph-request-1",
        "client-request-id": "notification-correlation-123",
      },
    }));

    await expect(transportWith(fetchImpl).send(MESSAGE)).resolves.toEqual({
      outcome: "accepted",
      correlationId: "notification-correlation-123",
      providerAcceptance: "accepted_not_delivered",
      providerMessageId: null,
      requestIdentifiers: {
        requestId: "graph-request-1",
        clientRequestId: "notification-correlation-123",
      },
    });
  });

  it.each([
    [401, "authentication"],
    [403, "scope_or_permission"],
  ] as const)("classifies HTTP %s as a non-retryable authorization failure", async (status, category) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "token=private recipient=person@example.invalid" } }),
      { status, headers: { "request-id": "graph-request-auth" } },
    ));

    const result = await transportWith(fetchImpl).send(MESSAGE);

    expect(result).toMatchObject({
      outcome: "rejected",
      providerMessageId: null,
      requestIdentifiers: { requestId: "graph-request-auth" },
      error: { category, httpStatus: status, retryable: false },
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("person@example.invalid");
  });

  it("classifies throttling with bounded retry guidance", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 429,
      headers: { "retry-after": "30" },
    }));

    await expect(transportWith(fetchImpl).send(MESSAGE)).resolves.toMatchObject({
      outcome: "rejected",
      error: {
        category: "throttled",
        httpStatus: 429,
        retryable: true,
        retryAfterSeconds: 30,
      },
    });
  });

  it("classifies provider 5xx responses as transient failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 503,
      headers: { "retry-after": "Wed, 26 Aug 2026 12:00:10 GMT" },
    }));

    await expect(transportWith(fetchImpl).send(MESSAGE)).resolves.toMatchObject({
      outcome: "rejected",
      error: {
        category: "transient",
        httpStatus: 503,
        retryable: true,
        retryAfterSeconds: 10,
      },
    });
  });

  it("returns a redacted ambiguous outcome on timeout or disconnect and forbids blind retry", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(
      new Error("disconnect synthetic-access-token private-mailbox@example.invalid"),
    );

    const result = await transportWith(fetchImpl).send(MESSAGE);

    expect(result).toEqual({
      outcome: "ambiguous",
      correlationId: "notification-correlation-123",
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
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-access-token");
    expect(JSON.stringify(result)).not.toContain("private-mailbox@example.invalid");
  });

  it("redacts access-context acquisition failures before dispatch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const transport = createMicrosoftGraphCompletionMailTransport({
      config: CONFIG,
      fetchImpl,
      acquireAccessContext: async () => {
        throw new Error("refresh-token=private-token mailbox=private@example.invalid");
      },
      createCorrelationId: () => "notification-correlation-123",
    });

    const result = await transport.send(MESSAGE);

    expect(result).toMatchObject({
      outcome: "rejected",
      correlationId: "notification-correlation-123",
      error: {
        category: "authentication",
        retryable: false,
        diagnostic: "The delegated Microsoft Graph access context could not be acquired.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-token");
    expect(JSON.stringify(result)).not.toContain("private@example.invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed before dispatch when Mail.Send is absent", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await transportWith(fetchImpl, { ...ACCESS, grantedScopes: ["Mail.Read"] }).send(MESSAGE);

    expect(result).toMatchObject({
      outcome: "rejected",
      error: { category: "scope_or_permission", retryable: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed before dispatch when the authenticated mailbox does not match configuration", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await transportWith(fetchImpl, {
      ...ACCESS,
      authenticatedMailbox: "different@example.invalid",
    }).send(MESSAGE);

    expect(result).toMatchObject({
      outcome: "rejected",
      error: { category: "authentication", retryable: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
