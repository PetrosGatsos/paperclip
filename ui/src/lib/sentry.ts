// Optional Sentry error monitoring for the browser.
//
// Activated only when the signed-in session carries a Sentry DSN. `SentryGate`
// reads the DSN off `GET /api/auth/get-session` and calls
// `initBrowserErrorMonitoring` once. A signed-out browser, or a browser with
// no DSN, calls this module never — see `SentryGate.tsx`.
//
// `@sentry/browser` loads through a dynamic import, so Vite puts it in a
// separate chunk that a browser with no DSN never fetches.
//
// Default-integration privacy note: two default integrations copy values
// this app does not want inside a Sentry event, so the initializer removes
// them with a built-in Sentry option — no custom filter code:
//   - `Breadcrumbs` turns a console call, a click, and a fetch call into a
//     breadcrumb with the raw arguments and the raw request URL.
//   - `HttpContext` copies the page URL, the query string, and the referrer
//     onto every event.
// The initializer keeps every other default integration, so the browser
// still captures `window.onerror` and `window.onunhandledrejection`
// (`GlobalHandlers`), the two React error boundaries, deduplicates a repeat
// event (`Dedupe`), and links a caused-by chain (`LinkedErrors`).

/** The subset of the `@sentry/browser` client surface this gate calls. */
interface SentryHandle {
  captureException(error: unknown): string;
}

let sentryHandle: SentryHandle | null = null;
let readyPromise: Promise<void> | null = null;

/**
 * Load `@sentry/browser` and start the client with the given DSN. Idempotent
 * — the session query can refetch and call this again, and a second call
 * returns the first call's promise instead of starting a second client.
 */
export function initBrowserErrorMonitoring(dsn: string): Promise<void> {
  readyPromise ??= bootstrapBrowserSentry(dsn);
  return readyPromise;
}

/**
 * Report an error to Sentry. Waits for `initBrowserErrorMonitoring` to
 * settle, so a call that races the dynamic import still reaches the client.
 * A no-op before the gate opens, when the gate never opens (no DSN on the
 * session), or when bootstrap failed. Never throws — observability must not
 * change control flow.
 */
export function captureBrowserException(error: unknown): void {
  void reportWhenReady(error);
}

async function reportWhenReady(error: unknown): Promise<void> {
  if (readyPromise) {
    await readyPromise;
  }
  if (!sentryHandle) return;
  try {
    sentryHandle.captureException(error);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[paperclip] Sentry captureBrowserException failed", err);
  }
}

/**
 * Build the `Sentry.init` options object. A pure function, split out from
 * `bootstrapBrowserSentry` so a test can call it with the real
 * `@sentry/browser` module and assert the resolved integration list and the
 * captured-event shape against the true SDK, not a stand-in.
 */
export function buildBrowserSentryInitOptions(dsn: string): Record<string, unknown> {
  return {
    dsn,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    integrations: (defaults: Array<{ name: string }>) =>
      defaults.filter(
        (integration) => integration.name !== "HttpContext" && integration.name !== "Breadcrumbs",
      ),
  };
}

async function bootstrapBrowserSentry(dsn: string): Promise<void> {
  try {
    const Sentry = await import("@sentry/browser");
    Sentry.init(buildBrowserSentryInitOptions(dsn));
    sentryHandle = { captureException: (error) => Sentry.captureException(error) };
  } catch (err) {
    // The dynamic import or the init call failed. Fall through with a
    // single diagnostic. The gate fails open — the app keeps running
    // without error monitoring rather than crashing on an opt-in feature.
    // eslint-disable-next-line no-console
    console.error("[paperclip] Sentry browser bootstrap failed", err);
  }
}
