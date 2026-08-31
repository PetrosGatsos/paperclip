import { randomUUID } from "node:crypto";

export const MICROSOFT_GRAPH_MAIL_SEND_ENDPOINT = "https://graph.microsoft.com/v1.0/me/sendMail";
export const MICROSOFT_GRAPH_MAIL_SEND_SCOPE = "Mail.Send";
export const MICROSOFT_GRAPH_INBOX_READ_SCOPE = "Mail.Read";
export const GRAPH_COMPLETION_MAIL_RECIPIENTS_ENV = "PAPERCLIP_GRAPH_COMPLETION_MAIL_RECIPIENTS";
export const GRAPH_COMPLETION_MAIL_SENDER_ENV = "PAPERCLIP_GRAPH_COMPLETION_MAIL_AUTHENTICATED_SENDER";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REQUEST_ID_LENGTH = 200;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type MicrosoftGraphCompletionMailConfig = {
  recipients: readonly [string, string];
  authenticatedSender: string;
};

export type MicrosoftGraphAccessContext = {
  accessToken: string;
  authenticatedMailbox: string;
  grantedScopes: readonly string[];
};

export type CompletionMailMessage = {
  subject: string;
  body: string;
};

export type MicrosoftGraphRequestIdentifiers = {
  requestId: string | null;
  clientRequestId: string | null;
};

export type MicrosoftGraphMailSendResult =
  | {
      outcome: "accepted";
      correlationId: string;
      providerAcceptance: "accepted_not_delivered";
      providerMessageId: null;
      requestIdentifiers: MicrosoftGraphRequestIdentifiers;
    }
  | {
      outcome: "rejected";
      correlationId: string;
      providerMessageId: null;
      requestIdentifiers: MicrosoftGraphRequestIdentifiers;
      error: {
        category: "authentication" | "scope_or_permission" | "throttled" | "transient" | "provider_contract";
        httpStatus: number | null;
        retryable: boolean;
        retryAfterSeconds: number | null;
        diagnostic: string;
      };
    }
  | {
      outcome: "ambiguous";
      correlationId: string;
      providerMessageId: null;
      requestIdentifiers: MicrosoftGraphRequestIdentifiers;
      automaticRetryAllowed: false;
      error: {
        category: "transport_outcome_unknown";
        httpStatus: null;
        retryable: false;
        retryAfterSeconds: null;
        diagnostic: string;
      };
    };

export type MicrosoftGraphCompletionMailTransport = {
  send(message: CompletionMailMessage): Promise<MicrosoftGraphMailSendResult>;
};

export class MicrosoftGraphCompletionMailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicrosoftGraphCompletionMailConfigError";
  }
}

function normalizeEmail(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !EMAIL_PATTERN.test(normalized) || /[\r\n]/.test(normalized)) return null;
  return normalized;
}

export function resolveMicrosoftGraphCompletionMailConfig(
  env: Record<string, string | undefined> = process.env,
): MicrosoftGraphCompletionMailConfig {
  const recipients = Array.from(new Set(
    (env[GRAPH_COMPLETION_MAIL_RECIPIENTS_ENV] ?? "")
      .split(",")
      .map((value) => normalizeEmail(value))
      .filter((value): value is string => value !== null),
  ));
  if (recipients.length !== 2) {
    throw new MicrosoftGraphCompletionMailConfigError(
      `${GRAPH_COMPLETION_MAIL_RECIPIENTS_ENV} must contain exactly two unique email addresses.`,
    );
  }

  const authenticatedSender = normalizeEmail(env[GRAPH_COMPLETION_MAIL_SENDER_ENV]);
  if (!authenticatedSender) {
    throw new MicrosoftGraphCompletionMailConfigError(
      `${GRAPH_COMPLETION_MAIL_SENDER_ENV} must contain one email address.`,
    );
  }

  return {
    recipients: [recipients[0], recipients[1]],
    authenticatedSender,
  };
}

export function extendMicrosoftGraphDelegatedScopes(existingScopes: readonly string[]): string[] {
  const scopes: string[] = [];
  const seen = new Set<string>();
  for (const rawScope of [...existingScopes, MICROSOFT_GRAPH_MAIL_SEND_SCOPE]) {
    const scope = rawScope.trim();
    const key = scope.toLowerCase();
    if (!scope || seen.has(key)) continue;
    seen.add(key);
    scopes.push(scope);
  }
  return scopes;
}

/**
 * Add Mail.Send to an existing delegated authorization request without
 * replacing its inbox-read, OpenID, or refresh-token scopes.
 */
export function extendMicrosoftGraphDelegatedAuthorizationUrl(input: string | URL): URL {
  const authorizationUrl = new URL(input.toString());
  const existingScopes = (authorizationUrl.searchParams.get("scope") ?? "")
    .split(/\s+/)
    .filter(Boolean);
  if (!existingScopes.some(
    (scope) => scope.trim().toLowerCase() === MICROSOFT_GRAPH_INBOX_READ_SCOPE.toLowerCase(),
  )) {
    throw new MicrosoftGraphCompletionMailConfigError(
      "The Microsoft Graph delegated authorization request must include its existing Mail.Read scope.",
    );
  }
  authorizationUrl.searchParams.set("scope", extendMicrosoftGraphDelegatedScopes(existingScopes).join(" "));
  return authorizationUrl;
}

function safeResponseIdentifier(value: string | null): string | null {
  const normalized = value?.replace(/[\r\n\t]/g, " ").trim();
  return normalized ? normalized.slice(0, MAX_REQUEST_ID_LENGTH) : null;
}

function responseIdentifiers(response: Response): MicrosoftGraphRequestIdentifiers {
  return {
    requestId: safeResponseIdentifier(response.headers.get("request-id")),
    clientRequestId: safeResponseIdentifier(response.headers.get("client-request-id")),
  };
}

async function discardResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // Response metadata already determines the result. Body cleanup is best effort.
  }
}

function emptyRequestIdentifiers(): MicrosoftGraphRequestIdentifiers {
  return { requestId: null, clientRequestId: null };
}

function parseRetryAfterSeconds(value: string | null, now: () => Date): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, Math.ceil((retryAt - now().getTime()) / 1_000));
}

function hasScope(scopes: readonly string[], expected: string): boolean {
  const normalizedExpected = expected.toLowerCase();
  return scopes.some((scope) => scope.trim().toLowerCase() === normalizedExpected);
}

function rejectedBeforeDispatch(
  correlationId: string,
  category: "authentication" | "scope_or_permission" | "transient",
  diagnostic: string,
  retryable = false,
): MicrosoftGraphMailSendResult {
  return {
    outcome: "rejected",
    correlationId,
    providerMessageId: null,
    requestIdentifiers: emptyRequestIdentifiers(),
    error: {
      category,
      httpStatus: null,
      retryable,
      retryAfterSeconds: null,
      diagnostic,
    },
  };
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function resultForHttpFailure(
  correlationId: string,
  response: Response,
  now: () => Date,
): MicrosoftGraphMailSendResult {
  const requestIdentifiers = responseIdentifiers(response);
  if (response.status === 401) {
    return {
      outcome: "rejected",
      correlationId,
      providerMessageId: null,
      requestIdentifiers,
      error: {
        category: "authentication",
        httpStatus: response.status,
        retryable: false,
        retryAfterSeconds: null,
        diagnostic: "Microsoft Graph rejected the delegated authentication context.",
      },
    };
  }
  if (response.status === 403) {
    return {
      outcome: "rejected",
      correlationId,
      providerMessageId: null,
      requestIdentifiers,
      error: {
        category: "scope_or_permission",
        httpStatus: response.status,
        retryable: false,
        retryAfterSeconds: null,
        diagnostic: "Microsoft Graph denied Mail.Send. Operator re-consent may be required.",
      },
    };
  }
  if (response.status === 429) {
    return {
      outcome: "rejected",
      correlationId,
      providerMessageId: null,
      requestIdentifiers,
      error: {
        category: "throttled",
        httpStatus: response.status,
        retryable: true,
        retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after"), now),
        diagnostic: "Microsoft Graph throttled the completion-mail request.",
      },
    };
  }
  if (response.status >= 500) {
    return {
      outcome: "rejected",
      correlationId,
      providerMessageId: null,
      requestIdentifiers,
      error: {
        category: "transient",
        httpStatus: response.status,
        retryable: true,
        retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after"), now),
        diagnostic: "Microsoft Graph returned a transient completion-mail error.",
      },
    };
  }
  return {
    outcome: "rejected",
    correlationId,
    providerMessageId: null,
    requestIdentifiers,
    error: {
      category: "provider_contract",
      httpStatus: response.status,
      retryable: false,
      retryAfterSeconds: null,
      diagnostic: "Microsoft Graph returned an unexpected completion-mail status.",
    },
  };
}

export function createMicrosoftGraphCompletionMailTransport(input: {
  config: MicrosoftGraphCompletionMailConfig;
  acquireAccessContext: (signal: AbortSignal) => Promise<MicrosoftGraphAccessContext>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  createCorrelationId?: () => string;
  monotonicNow?: () => number;
  now?: () => Date;
}): MicrosoftGraphCompletionMailTransport {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const createCorrelationId = input.createCorrelationId ?? randomUUID;
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const now = input.now ?? (() => new Date());

  return {
    async send(message) {
      const correlationId = createCorrelationId();
      let access: MicrosoftGraphAccessContext;
      const controller = new AbortController();
      const deadline = monotonicNow() + timeoutMs;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        access = await abortable(input.acquireAccessContext(controller.signal), controller.signal);
      } catch {
        if (controller.signal.aborted) {
          clearTimeout(timer);
          return rejectedBeforeDispatch(
            correlationId,
            "transient",
            "Delegated Microsoft Graph access acquisition timed out before mail dispatch.",
            true,
          );
        }
        clearTimeout(timer);
        return rejectedBeforeDispatch(
          correlationId,
          "authentication",
          "The delegated Microsoft Graph access context could not be acquired.",
        );
      }
      const accessToken = access.accessToken.trim();
      if (!accessToken) {
        clearTimeout(timer);
        return rejectedBeforeDispatch(
          correlationId,
          "authentication",
          "The delegated Microsoft Graph access token is unavailable.",
        );
      }
      if (normalizeEmail(access.authenticatedMailbox) !== input.config.authenticatedSender) {
        clearTimeout(timer);
        return rejectedBeforeDispatch(
          correlationId,
          "authentication",
          "The delegated Microsoft Graph mailbox does not match the configured sender.",
        );
      }
      if (!hasScope(access.grantedScopes, MICROSOFT_GRAPH_MAIL_SEND_SCOPE)) {
        clearTimeout(timer);
        return rejectedBeforeDispatch(
          correlationId,
          "scope_or_permission",
          "The delegated Microsoft Graph grant does not include Mail.Send.",
        );
      }

      if (controller.signal.aborted || monotonicNow() >= deadline) {
        clearTimeout(timer);
        return rejectedBeforeDispatch(
          correlationId,
          "transient",
          "The Microsoft Graph completion-mail deadline expired before dispatch.",
          true,
        );
      }

      let response: Response;
      try {
        response = await fetchImpl(MICROSOFT_GRAPH_MAIL_SEND_ENDPOINT, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            accept: "application/json",
            "client-request-id": correlationId,
            "return-client-request-id": "true",
          },
          body: JSON.stringify({
            message: {
              subject: message.subject,
              body: { contentType: "Text", content: message.body },
              toRecipients: input.config.recipients.map((address) => ({ emailAddress: { address } })),
            },
            saveToSentItems: true,
          }),
        });
      } catch {
        return {
          outcome: "ambiguous",
          correlationId,
          providerMessageId: null,
          requestIdentifiers: emptyRequestIdentifiers(),
          automaticRetryAllowed: false,
          error: {
            category: "transport_outcome_unknown",
            httpStatus: null,
            retryable: false,
            retryAfterSeconds: null,
            diagnostic: "The Microsoft Graph connection ended before provider acceptance could be confirmed.",
          },
        };
      } finally {
        clearTimeout(timer);
      }

      if (response.status !== 202) {
        const result = resultForHttpFailure(correlationId, response, now);
        await discardResponseBody(response);
        return result;
      }

      return {
        outcome: "accepted",
        correlationId,
        providerAcceptance: "accepted_not_delivered",
        providerMessageId: null,
        requestIdentifiers: responseIdentifiers(response),
      };
    },
  };
}
