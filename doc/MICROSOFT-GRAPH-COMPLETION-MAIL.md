# Microsoft Graph completion mail

Paperclip can prepare and send one completion notification for an email-triggered parent request after the request is ready for testing. The service boundary is in:

- `server/src/services/completion-notification-readiness.ts`
- `server/src/services/microsoft-graph-completion-mail.ts`

The transport is dependency-injected. Automated tests supply a mock HTTP function and reserved `example.invalid` addresses. Tests must not call Microsoft Graph or deliver email.

## Delegated authorization and re-consent

Use the Microsoft Entra application and delegated user authorization that already reads the authenticated inbox. Keep its existing read, OpenID, and refresh-token scopes. Add the delegated `Mail.Send` permission to the same authorization request.

The authorization helper preserves every existing scope and adds `Mail.Send`. A typical resulting scope set includes `Mail.Read` and `Mail.Send`. It can also include existing scopes such as `openid` and `offline_access`.

Adding a permission to the application registration does not update an existing user grant. An operator must complete Microsoft re-consent for the authenticated mailbox after deployment. Do not attempt re-consent from tests, agents, migrations, or issue automation.

The Microsoft Entra redirect URI must exactly match the redirect URI used by the existing delegated inbox authorization flow. Register the production HTTPS callback in Entra. Keep loopback callbacks limited to local development. Do not add a second callback or a second mail provider for completion mail.

## Runtime configuration

Set these values in the server deployment environment:

```sh
PAPERCLIP_GRAPH_COMPLETION_MAIL_RECIPIENTS=reviewer@example.invalid,owner@example.invalid
PAPERCLIP_GRAPH_COMPLETION_MAIL_AUTHENTICATED_SENDER=owner@example.invalid
```

The recipient setting must resolve to exactly two unique email addresses. The server snapshots those configured recipients when the dependent notification orchestration creates its durable record. Request text, agent output, and incoming email content must never supply or override recipients.

The authenticated sender setting is an identity check. The Graph request uses `POST https://graph.microsoft.com/v1.0/me/sendMail` and contains no `from` property. The acquired delegated access context must report the same authenticated mailbox and include `Mail.Send`, or the transport fails before HTTP dispatch.

Do not put an access token or refresh token in either setting. Bind the Microsoft client secret and delegated refresh material through the existing Paperclip secret provider and user-owned OAuth connection. The caller must inject a short-lived access context into the transport. Never persist or log that access token.

## Readiness and aggregation

The eligibility boundary accepts a complete parent snapshot and its required children. It returns the parent issue id as the notification key only when all of these conditions are true:

1. The parent status is exactly `READY_FOR_TESTING`.
2. Every parent-required validation or build evidence item exists once and has `SUCCEEDED` status.
3. Every required child exists and has `READY_FOR_TESTING` status.
4. Every child-required validation or build evidence item exists once and has `SUCCEEDED` status.

A missing, pending, blocked, failed, cancelled, or unvalidated child suppresses the parent notification. The boundary never creates a child notification. A multi-simulation request produces one consolidated parent message and one stable parent notification key. The durable uniqueness claim and retry worker belong to the completion-notification persistence layer.

The generated plain-text message contains the request, request type, bounded implementation summary, `Ready for testing` status, Paperclip reference, and implementation reference. Multi-simulation messages also list the completed child titles. The required English copy is isolated in the composer and must pass the QA and localization review before production activation.

## Graph result contract

Microsoft Graph v1.0 returns `202 Accepted` with no response body for `/me/sendMail`. Paperclip records this as provider acceptance, not confirmed delivery. The transport returns:

- a Paperclip-generated notification correlation id;
- Graph `request-id` and `client-request-id` response headers when present;
- `providerMessageId: null` because this API does not return one.

An HTTP `401` or `403` is a non-retryable authentication or permission result until credentials or consent change. A `429` result carries retry guidance. A provider `5xx` result is transient. Response bodies, access tokens, message content, and mailbox addresses are excluded from diagnostics.

A timeout, disconnect, or other failure without an HTTP response has an ambiguous outcome. The request might have reached Graph. The transport returns `outcome: "ambiguous"` and `automaticRetryAllowed: false`. Downstream orchestration must stop blind retries and require explicit reconciliation under the original correlation id.

## Deployment verification

1. Confirm the Entra app registration has delegated `Mail.Read` and `Mail.Send` permissions plus the existing sign-in scopes.
2. Confirm the production redirect URI exactly matches the deployed delegated OAuth callback.
3. Bind client and refresh secrets through the Paperclip secret provider. Confirm API/config reads stay redacted.
4. Set the two recipient addresses and authenticated mailbox through deployment configuration. Do not commit their production values.
5. Complete operator re-consent for the authenticated mailbox.
6. Use a staging email-triggered request. Confirm no notification claim occurs before the required validation/build evidence succeeds and the parent reaches `READY_FOR_TESTING`.
7. For a multi-simulation request, confirm incomplete children suppress the parent and the final eligible snapshot creates one parent claim.
8. Confirm the Graph result stores the Paperclip correlation id and response request identifiers. Interpret `202` only as acceptance.
9. Simulate a timeout after dispatch. Confirm the record enters ambiguous reconciliation and is not sent again automatically.

Production activation must wait for the independent security/database and QA/localization review gates.
