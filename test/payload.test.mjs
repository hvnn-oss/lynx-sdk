import assert from "node:assert/strict";
import { test } from "node:test";
import { LynxTracer } from "../dist/index.js";

function createTracer(overrides = {}) {
  return new LynxTracer({
    clientId: "test-client",
    endpoint: "http://lynx.test",
    apiKey: "test-api-key",
    delivery: {
      flushIntervalMs: 60_000,
    },
    ...overrides,
  });
}

test("payload processing masks sensitive values by key name", async () => {
  const batches = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    batches.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  try {
    const tracer = createTracer({ captureMode: "full" });
    await tracer.run("SupportAgent", async () => {
      tracer.log("sensitive-input", {
        input: {
          password: "not-a-pattern",
          apiKey: "short-key",
          nested: {
            refreshToken: "opaque-refresh-token",
            email: "user@example.com",
          },
        },
      });
    });
    await tracer.shutdown();

    const event = batches
      .flat()
      .find((item) => item.label === "sensitive-input");
    assert.equal(event.payload.input.password, "[MASKED_SECRET]");
    assert.equal(event.payload.input.apiKey, "[MASKED_SECRET]");
    assert.equal(event.payload.input.nested.refreshToken, "[MASKED_SECRET]");
    assert.equal(event.payload.input.nested.email, "[MASKED_EMAIL]");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("payload processing keeps token usage metrics while masking auth tokens", async () => {
  const batches = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    batches.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  try {
    const tracer = createTracer({ captureMode: "full" });
    await tracer.run("SupportAgent", async () => {
      tracer.log("token-metrics", {
        usage: {
          promptTokens: 12,
          completionTokens: 8,
          totalTokens: 20,
        },
        maxTokens: 256,
        authToken: "opaque-auth-token",
        sessionToken: "opaque-session-token",
      });
    });
    await tracer.shutdown();

    const event = batches.flat().find((item) => item.label === "token-metrics");
    assert.equal(event.payload.usage.promptTokens, 12);
    assert.equal(event.payload.usage.completionTokens, 8);
    assert.equal(event.payload.usage.totalTokens, 20);
    assert.equal(event.payload.maxTokens, 256);
    assert.equal(event.payload.authToken, "[MASKED_SECRET]");
    assert.equal(event.payload.sessionToken, "[MASKED_SECRET]");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("metadata-only mode keeps hashes and removes raw input/output", async () => {
  const batches = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    batches.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  try {
    const tracer = createTracer({ captureMode: "metadata-only" });
    await tracer.run("SupportAgent", async () => {
      tracer.log("metadata-only", {
        input: "hello user@example.com",
        output: "done",
      });
    });
    await tracer.shutdown();

    const event = batches.flat().find((item) => item.label === "metadata-only");
    assert.equal("input" in event.payload, false);
    assert.equal("output" in event.payload, false);
    assert.equal(typeof event.payload.promptHash, "string");
    assert.equal(typeof event.payload.responseHash, "string");
    assert.equal(event.payload.promptLength > 0, true);
    assert.equal(event.payload.responseLength, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
