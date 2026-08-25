import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { finalizeServerShutdown } from "../shutdown.js";
import * as sentryModule from "../sentry.js";

/**
 * Tests for the opt-in Sentry error-monitoring gate. `@sentry/node` is an
 * optional runtime dependency and is NOT installed in CI, which is itself
 * part of the contract under test: with `SENTRY_DSN` set and the package
 * absent, the module must warn and settle instead of crashing the server.
 *
 * The module reads `SENTRY_DSN` at import time, so each test resets the
 * module registry and imports a fresh copy.
 */

const DSN_ENV = "SENTRY_DSN";
const originalDsn = process.env[DSN_ENV];

async function importFreshSentry() {
  vi.resetModules();
  return await import("../sentry.js");
}

/**
 * Register a fake `@sentry/node` module for the next dynamic import. Each
 * mock function is returned so a test can assert on the call it received.
 * The mock stays in place until `vi.doUnmock` runs, so `afterEach` clears it.
 */
function mockSentryPackage() {
  const init = vi.fn();
  const captureException = vi.fn(() => "event-id");
  const close = vi.fn(async () => true);
  const httpIntegration = vi.fn((options: unknown) => ({ name: "Http", ...(options as object) }));
  const onUnhandledRejectionIntegration = vi.fn((options: unknown) => ({
    name: "OnUnhandledRejection",
    ...(options as object),
  }));

  vi.doMock("@sentry/node", () => ({
    init,
    captureException,
    close,
    httpIntegration,
    onUnhandledRejectionIntegration,
  }));

  return { init, captureException, close, httpIntegration, onUnhandledRejectionIntegration };
}

// A representative default-integration list, shaped like the array
// `@sentry/node@10.71.0`'s `getDefaultIntegrations()` returns for a Node
// server. Recorded 2026-08-25 with `node -e` against the published package —
// see the disposition comment on PAP-5131 for the full command.
const DEFAULT_INTEGRATION_NAMES = [
  "InboundFilters",
  "FunctionToString",
  "LinkedErrors",
  "RequestData",
  "NodeSystemError",
  "ConversationId",
  "Console",
  "OnUncaughtException",
  "OnUnhandledRejection",
  "ContextLines",
  "LocalVariablesAsync",
  "Context",
  "ChildProcess",
  "ProcessSession",
  "Modules",
  "Http",
  "NodeFetch",
];

beforeEach(() => {
  delete process.env[DSN_ENV];
});

afterEach(() => {
  if (originalDsn === undefined) delete process.env[DSN_ENV];
  else process.env[DSN_ENV] = originalDsn;
  vi.restoreAllMocks();
  vi.doUnmock("@sentry/node");
});

describe("sentryReady", () => {
  it("resolves and imports no SDK when SENTRY_DSN is unset", async () => {
    // A spy that fails the test if the module attempts a dynamic import of
    // an SDK it should never touch on the closed-gate path. `@sentry/node`
    // is not installed, so an attempted import would settle this promise
    // with a warning instead of resolving clean.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { sentryReady } = await importFreshSentry();

    await expect(sentryReady).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("captureException", () => {
  it("is a no-op and does not throw when the gate is closed", async () => {
    const { captureException, sentryReady } = await importFreshSentry();
    await sentryReady;

    expect(() => captureException(new Error("boom"))).not.toThrow();
  });
});

describe("shutdownSentry", () => {
  it("resolves once for concurrent callers", async () => {
    const { shutdownSentry } = await importFreshSentry();

    const first = shutdownSentry();
    const second = shutdownSentry();

    // Memoized: concurrent callers share one shutdown promise.
    expect(first).toBe(second);
    await expect(first).resolves.toBeUndefined();
  });
});

/**
 * Seam tests for the two `errorHandler` call sites that report to Sentry.
 * These tests spy on the exported `captureException` binding rather than
 * import a real client, so they assert the call-site shape (one call, the
 * Error object only) without a live Sentry SDK.
 */
describe("errorHandler Sentry capture", () => {
  function makeReq(): Request {
    return {
      method: "GET",
      originalUrl: "/api/test",
      body: { a: 1 },
      params: { id: "123" },
      query: { q: "x" },
    } as unknown as Request;
  }

  function makeRes(): Response {
    const res = {
      status: vi.fn(),
      json: vi.fn(),
    } as unknown as Response;
    (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
    return res;
  }

  it("captures one event for a 500-level HttpError", () => {
    const capture = vi.spyOn(sentryModule, "captureException").mockImplementation(() => {});
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(500, "db exploded");

    errorHandler(err, req, res, next);

    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("captures one event for an unknown error", () => {
    const capture = vi.spyOn(sentryModule, "captureException").mockImplementation(() => {});
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("boom");

    errorHandler(err, req, res, next);

    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("captures no event for a Zod validation 400 response", () => {
    const capture = vi.spyOn(sentryModule, "captureException").mockImplementation(() => {});
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    const issue = {
      code: "invalid_type",
      expected: "string",
      received: "undefined",
      path: ["provider"],
      message: "Required",
    };
    const err = Object.assign(new Error("Validation failed"), {
      name: "ZodError",
      issues: [issue],
    });

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(capture).not.toHaveBeenCalled();
  });

  it("passes the Error object only to captureException, never the request-bearing ErrorContext", () => {
    const capture = vi.spyOn(sentryModule, "captureException").mockImplementation(() => {});
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("boom");

    errorHandler(err, req, res, next);

    expect(capture).toHaveBeenCalledWith(err);
    const [received] = capture.mock.calls[0]!;
    expect(received).toBeInstanceOf(Error);
    // The `ErrorContext` shape carries the request body, params, and query.
    // The received value must not carry any of them.
    expect(received).not.toHaveProperty("reqBody");
    expect(received).not.toHaveProperty("reqParams");
    expect(received).not.toHaveProperty("reqQuery");
  });

  it("does not change the errorHandler response when a capture call throws", () => {
    const capture = vi.spyOn(sentryModule, "captureException").mockImplementation(() => {
      throw new Error("Sentry capture exploded");
    });
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("boom");

    expect(() => errorHandler(err, req, res, next)).not.toThrow();

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

describe("finalizeServerShutdown Sentry teardown", () => {
  it("calls shutdownSentry after shutdownInstrumentation", async () => {
    const order: string[] = [];
    const shutdownInstrumentation = vi.fn(async () => {
      order.push("instrumentation");
    });
    const shutdownSentry = vi.fn(async () => {
      order.push("sentry");
    });

    await finalizeServerShutdown({
      signal: "SIGTERM",
      shutdownAppServices: undefined,
      stopEmbeddedPostgres: null,
      shutdownInstrumentation,
      shutdownSentry,
      log: { info: vi.fn(), error: vi.fn() },
    });

    expect(order).toEqual(["instrumentation", "sentry"]);
  });
});

describe("missing @sentry/node package", () => {
  it("logs one warning and resolves", async () => {
    process.env[DSN_ENV] = "https://public@o0.ingest.sentry.io/1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { sentryReady } = await importFreshSentry();

    // Bootstrap must absorb the failed dynamic import — the server keeps
    // booting without error monitoring rather than crashing on an opt-in
    // feature.
    await expect(sentryReady).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("@sentry/node package is not installed"),
      expect.anything(),
    );
  });
});

describe("buildSentryInitOptions", () => {
  it("sets sendDefaultPii false, tracesSampleRate 0, and skipOpenTelemetrySetup true", async () => {
    const { buildSentryInitOptions } = await importFreshSentry();

    const options = buildSentryInitOptions("https://public@o0.ingest.sentry.io/1", {
      httpIntegration: () => ({ name: "Http" }),
      onUnhandledRejectionIntegration: () => ({ name: "OnUnhandledRejection" }),
    });

    expect(options.sendDefaultPii).toBe(false);
    expect(options.tracesSampleRate).toBe(0);
    expect(options.skipOpenTelemetrySetup).toBe(true);
  });

  it("passes onUnhandledRejection with mode strict", async () => {
    const { buildSentryInitOptions } = await importFreshSentry();
    const onUnhandledRejectionIntegration = vi.fn((options: unknown) => ({
      name: "OnUnhandledRejection",
      ...(options as object),
    }));

    const options = buildSentryInitOptions("https://public@o0.ingest.sentry.io/1", {
      httpIntegration: () => ({ name: "Http" }),
      onUnhandledRejectionIntegration,
    });
    const integrationsFn = options.integrations as (defaults: Array<{ name: string }>) => Array<{ name: string }>;
    const resolved = integrationsFn(DEFAULT_INTEGRATION_NAMES.map((name) => ({ name })));

    expect(onUnhandledRejectionIntegration).toHaveBeenCalledWith({ mode: "strict" });
    const rejectionIntegration = resolved.find((i) => i.name === "OnUnhandledRejection");
    expect(rejectionIntegration).toMatchObject({ mode: "strict" });
    // The default OnUnhandledRejection entry must not survive alongside it.
    expect(resolved.filter((i) => i.name === "OnUnhandledRejection")).toHaveLength(1);
  });

  it("the resolved server integration list holds no Console integration and no ContextLines integration", async () => {
    const { buildSentryInitOptions } = await importFreshSentry();

    const options = buildSentryInitOptions("https://public@o0.ingest.sentry.io/1", {
      httpIntegration: () => ({ name: "Http" }),
      onUnhandledRejectionIntegration: () => ({ name: "OnUnhandledRejection" }),
    });
    const integrationsFn = options.integrations as (defaults: Array<{ name: string }>) => Array<{ name: string }>;
    const resolved = integrationsFn(DEFAULT_INTEGRATION_NAMES.map((name) => ({ name })));
    const names = resolved.map((i) => i.name);

    expect(names).not.toContain("Console");
    expect(names).not.toContain("ContextLines");
  });

  it("the resolved server integration list keeps OnUncaughtException, OnUnhandledRejection, LinkedErrors, and RequestData", async () => {
    const { buildSentryInitOptions } = await importFreshSentry();

    const options = buildSentryInitOptions("https://public@o0.ingest.sentry.io/1", {
      httpIntegration: () => ({ name: "Http" }),
      onUnhandledRejectionIntegration: () => ({ name: "OnUnhandledRejection" }),
    });
    const integrationsFn = options.integrations as (defaults: Array<{ name: string }>) => Array<{ name: string }>;
    const resolved = integrationsFn(DEFAULT_INTEGRATION_NAMES.map((name) => ({ name })));
    const names = resolved.map((i) => i.name);

    // The full error-capture set the plan requires, not just the four named
    // in this test's title.
    expect(names).toEqual(
      expect.arrayContaining([
        "OnUncaughtException",
        "OnUnhandledRejection",
        "ChildProcess",
        "LinkedErrors",
        "RequestData",
        "Modules",
        "Context",
        "ProcessSession",
      ]),
    );
  });

  it("turns the outbound HTTP breadcrumb off and keeps the rest of the Http integration", async () => {
    const { buildSentryInitOptions } = await importFreshSentry();
    const httpIntegration = vi.fn((options: unknown) => ({ name: "Http", ...(options as object) }));

    const options = buildSentryInitOptions("https://public@o0.ingest.sentry.io/1", {
      httpIntegration,
      onUnhandledRejectionIntegration: () => ({ name: "OnUnhandledRejection" }),
    });
    const integrationsFn = options.integrations as (defaults: Array<{ name: string }>) => Array<{ name: string }>;
    const resolved = integrationsFn(DEFAULT_INTEGRATION_NAMES.map((name) => ({ name })));

    expect(httpIntegration).toHaveBeenCalledWith({ breadcrumbs: false });
    expect(resolved.filter((i) => i.name === "Http")).toHaveLength(1);
  });
});

describe("with @sentry/node mocked", () => {
  it("initializes the client and shares captureException / shutdownSentry with it", async () => {
    process.env[DSN_ENV] = "https://public@o0.ingest.sentry.io/1";
    const mocks = mockSentryPackage();

    const { sentryReady, captureException, shutdownSentry } = await importFreshSentry();
    await sentryReady;

    expect(mocks.init).toHaveBeenCalledTimes(1);
    const initOptions = mocks.init.mock.calls[0][0] as { dsn: string };
    expect(initOptions.dsn).toBe("https://public@o0.ingest.sentry.io/1");

    captureException(new Error("boom"));
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error));

    await shutdownSentry();
    expect(mocks.close).toHaveBeenCalledWith(5_000);
  });
});

// `@sentry/node` is an optional runtime dependency (see the module comment
// in sentry.ts). When it is absent, the three tests below cannot run against
// the true SDK, so they are skipped — the same pattern instrumentation.test.ts
// uses for its OpenTelemetry-SDK-dependent test.
const sentryPackage = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require("@sentry/node") as {
      init(options: Record<string, unknown>): unknown;
      captureException(error: unknown): string;
      httpIntegration(options: { breadcrumbs: boolean }): { name: string };
      onUnhandledRejectionIntegration(options: { mode: string }): { name: string };
      flush(timeout?: number): Promise<boolean>;
      close(timeout?: number): Promise<boolean>;
    };
  } catch {
    return null;
  }
})();

describe.skipIf(!sentryPackage)("captured event shape against the real @sentry/node SDK", () => {
  /**
   * Initialize the real SDK with this module's exact options, plus a
   * transport stub so no event leaves the test process, plus `beforeSend`
   * so the test can inspect the resolved event before it would have been
   * sent. `beforeSend` is test-only introspection — the module under test
   * adds no `beforeSend` of its own (constraint: built-in options only).
   */
  async function initRealSentryForTest(onEvent: (event: Record<string, unknown>) => void) {
    const Sentry = sentryPackage!;
    const { buildSentryInitOptions } = await importFreshSentry();
    const options = {
      ...buildSentryInitOptions("https://public@o0.ingest.sentry.io/1", Sentry),
      transport: () => ({ send: async () => ({}), flush: async () => true }),
      beforeSend: (event: Record<string, unknown>) => {
        onEvent(event);
        return event;
      },
    };
    Sentry.init(options);
  }

  it("a server event captured after a console.error call carries no console breadcrumb", async () => {
    const Sentry = sentryPackage!;
    let captured: Record<string, unknown> | null = null;
    await initRealSentryForTest((event) => {
      captured = event;
    });

    // eslint-disable-next-line no-console
    console.error("child process stderr: simulated failure");
    Sentry.captureException(new Error("after console.error"));
    await Sentry.flush(2000);

    expect(captured).not.toBeNull();
    expect((captured as Record<string, unknown>).breadcrumbs).toBeUndefined();
  });

  it("a server event carries no stack-frame source context", async () => {
    const Sentry = sentryPackage!;
    let captured: Record<string, unknown> | null = null;
    await initRealSentryForTest((event) => {
      captured = event;
    });

    Sentry.captureException(new Error("stack frame check"));
    await Sentry.flush(2000);

    const event = captured as unknown as {
      exception: { values: Array<{ stacktrace: { frames: Array<Record<string, unknown>> } }> };
    };
    const frames = event.exception.values[0].stacktrace.frames;
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.context_line).toBeUndefined();
      expect(frame.pre_context).toBeUndefined();
      expect(frame.post_context).toBeUndefined();
    }
  });

  it("a server event carries no outbound HTTP breadcrumb", async () => {
    const Sentry = sentryPackage!;
    let captured: Record<string, unknown> | null = null;
    await initRealSentryForTest((event) => {
      captured = event;
    });

    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => {
      http.get(`http://127.0.0.1:${port}/probe?token=secret`, (res) => {
        res.resume();
        res.on("end", resolve);
      });
    });
    server.close();

    Sentry.captureException(new Error("after outbound http call"));
    await Sentry.flush(2000);

    expect((captured as unknown as Record<string, unknown>).breadcrumbs).toBeUndefined();
  });
});
