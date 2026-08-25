// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the browser Sentry gate. Unlike the server gate,
 * `@sentry/browser` is a real development dependency of this package (see
 * the constraint in the plan), so most tests here run against the true SDK
 * instead of a stand-in.
 *
 * The module holds module-scoped state (the readiness promise, the client
 * handle), so each test resets the module registry and imports a fresh copy.
 */

const DSN = "https://public@o0.ingest.sentry.io/1";

async function importFreshSentry() {
  vi.resetModules();
  return await import("./sentry");
}

/**
 * Register a fake `@sentry/browser` module for the next dynamic import. Used
 * by the tests that only care about the call the module makes into the SDK,
 * not the shape of a captured event.
 */
function mockSentryPackage() {
  const init = vi.fn();
  const captureException = vi.fn(() => "event-id");

  vi.doMock("@sentry/browser", () => ({ init, captureException }));

  return { init, captureException };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@sentry/browser");
});

// A representative default-integration list, shaped like the array
// `@sentry/browser@10.71.0`'s `getDefaultIntegrations()` returns. Recorded
// 2026-08-25 with `node -e` against the published package.
const DEFAULT_INTEGRATION_NAMES = [
  "InboundFilters",
  "FunctionToString",
  "ConversationId",
  "BrowserApiErrors",
  "Breadcrumbs",
  "GlobalHandlers",
  "LinkedErrors",
  "Dedupe",
  "HttpContext",
  "CultureContext",
  "BrowserSession",
];

describe("initBrowserErrorMonitoring", () => {
  it("initializes with the DSN it receives", async () => {
    const mocks = mockSentryPackage();
    const { initBrowserErrorMonitoring } = await importFreshSentry();

    await initBrowserErrorMonitoring(DSN);

    expect(mocks.init).toHaveBeenCalledTimes(1);
    const initOptions = mocks.init.mock.calls[0][0] as { dsn: string };
    expect(initOptions.dsn).toBe(DSN);
  });

  it("a second call starts no second client", async () => {
    const mocks = mockSentryPackage();
    const { initBrowserErrorMonitoring } = await importFreshSentry();

    await initBrowserErrorMonitoring(DSN);
    await initBrowserErrorMonitoring(DSN);

    expect(mocks.init).toHaveBeenCalledTimes(1);
  });
});

describe("captureBrowserException", () => {
  it("does not throw when the gate is closed", async () => {
    const { captureBrowserException } = await importFreshSentry();

    expect(() => captureBrowserException(new Error("boom"))).not.toThrow();
  });

  it("reaches the client once the gate opens", async () => {
    const mocks = mockSentryPackage();
    const { initBrowserErrorMonitoring, captureBrowserException } = await importFreshSentry();

    await initBrowserErrorMonitoring(DSN);
    captureBrowserException(new Error("boom"));
    // captureBrowserException resolves asynchronously; give its internal
    // promise a turn to settle before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe("buildBrowserSentryInitOptions", () => {
  it("sets the recorded built-in privacy options", async () => {
    const { buildBrowserSentryInitOptions } = await importFreshSentry();

    const options = buildBrowserSentryInitOptions(DSN);

    expect(options.sendDefaultPii).toBe(false);
    expect(options.tracesSampleRate).toBe(0);
  });

  it("holds no beforeSend hook and no custom filter function", async () => {
    const { buildBrowserSentryInitOptions } = await importFreshSentry();

    const options = buildBrowserSentryInitOptions(DSN);

    expect(options.beforeSend).toBeUndefined();
    expect(options.beforeSendTransaction).toBeUndefined();
  });

  it("the resolved integration list holds no HttpContext integration and no Breadcrumbs integration", async () => {
    const { buildBrowserSentryInitOptions } = await importFreshSentry();

    const options = buildBrowserSentryInitOptions(DSN);
    const integrationsFn = options.integrations as (
      defaults: Array<{ name: string }>,
    ) => Array<{ name: string }>;
    const resolved = integrationsFn(DEFAULT_INTEGRATION_NAMES.map((name) => ({ name })));
    const names = resolved.map((i) => i.name);

    expect(names).not.toContain("HttpContext");
    expect(names).not.toContain("Breadcrumbs");
  });

  it("the resolved integration list keeps GlobalHandlers, BrowserApiErrors, Dedupe, and LinkedErrors", async () => {
    const { buildBrowserSentryInitOptions } = await importFreshSentry();

    const options = buildBrowserSentryInitOptions(DSN);
    const integrationsFn = options.integrations as (
      defaults: Array<{ name: string }>,
    ) => Array<{ name: string }>;
    const resolved = integrationsFn(DEFAULT_INTEGRATION_NAMES.map((name) => ({ name })));
    const names = resolved.map((i) => i.name);

    expect(names).toEqual(
      expect.arrayContaining(["GlobalHandlers", "BrowserApiErrors", "Dedupe", "LinkedErrors"]),
    );
  });
});

/**
 * Tests against the real `@sentry/browser` SDK. `@sentry/browser` is not an
 * optional dependency here — it is a real, always-installed development
 * dependency of this package (see the module comment in `sentry.ts`) — so
 * these tests run unconditionally.
 */
describe("captured event shape against the real @sentry/browser SDK", () => {
  /**
   * Initialize the real SDK with this module's exact options, plus a
   * transport stub so no event leaves the test process, plus `beforeSend`
   * so the test can inspect the resolved event before it would have been
   * sent. `beforeSend` here is test-only introspection — the shipped module
   * adds no `beforeSend` of its own (see the "holds no beforeSend hook"
   * test above).
   */
  async function initRealSentryForTest(onEvent: (event: Record<string, unknown>) => void) {
    const { buildBrowserSentryInitOptions } = await importFreshSentry();
    const Sentry = await import("@sentry/browser");
    Sentry.init({
      ...buildBrowserSentryInitOptions(DSN),
      transport: () => ({ send: async () => ({}), flush: async () => true }),
      beforeSend: (event) => {
        onEvent(event as unknown as Record<string, unknown>);
        return event;
      },
    });
    return Sentry;
  }

  it("an event from a page URL that holds a test capability value carries no request URL, no query string, and no referrer", async () => {
    window.history.pushState({}, "", "/dashboard?token=test-capability-value");
    Object.defineProperty(document, "referrer", {
      value: "https://from.example/previous-page",
      configurable: true,
    });
    let captured: Record<string, unknown> | null = null;
    const Sentry = await initRealSentryForTest((event) => {
      captured = event;
    });

    Sentry.captureException(new Error("boom"));
    await Sentry.flush(2000);

    expect(captured).not.toBeNull();
    // `HttpContext` is the only default integration that writes
    // `event.request`. With it removed, the field never appears.
    expect((captured as unknown as Record<string, unknown>).request).toBeUndefined();
  });

  it("an event captured after a console call and a fetch call carries no breadcrumb", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    let captured: Record<string, unknown> | null = null;
    const Sentry = await initRealSentryForTest((event) => {
      captured = event;
    });

    // eslint-disable-next-line no-console
    console.warn("a console call the Breadcrumbs integration would otherwise record");
    await fetch("/api/probe?token=test-capability-value");
    Sentry.captureException(new Error("boom"));
    await Sentry.flush(2000);

    globalThis.fetch = originalFetch;
    expect(captured).not.toBeNull();
    expect((captured as unknown as Record<string, unknown>).breadcrumbs).toBeUndefined();
  });
});
