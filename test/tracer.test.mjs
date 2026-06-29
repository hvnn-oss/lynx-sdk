import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { LynxPolicyError, LynxTracer } from "../dist/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

test("flush sends queued events even when the batch size is not reached", async () => {
  const batches = [];
  globalThis.fetch = async (_url, init) => {
    batches.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const tracer = createTracer({
    delivery: { batchSize: 50, flushIntervalMs: 60_000 },
  });
  await tracer.run("SupportAgent", async () => {
    tracer.log("decision", { reason: "selected refund workflow" });
  });
  await tracer.flush();

  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
  assert.deepEqual(
    batches[0].map((event) => event.payload.phase),
    ["start", undefined, "end"],
  );
});

test("uses the hosted Lynx API endpoint by default", async () => {
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const tracer = new LynxTracer({
    clientId: "test-client",
    apiKey: "test-api-key",
    delivery: {
      flushIntervalMs: 60_000,
    },
  });

  await tracer.run("SupportAgent", async () => {
    tracer.log("manual-note", { ok: true });
  });
  await tracer.flush();
  await tracer.shutdown();

  assert.equal(requestedUrl, "https://api.lynxops.co/openapi/v1/events/batch");
});

test("shutdown flushes queued events and clears the timer", async () => {
  const batches = [];
  globalThis.fetch = async (_url, init) => {
    batches.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const tracer = createTracer({
    delivery: { batchSize: 50, flushIntervalMs: 60_000 },
  });
  await tracer.run("SupportAgent", async () => {
    tracer.log("manual-note", { ok: true });
  });
  await tracer.shutdown();
  await tracer.shutdown();

  assert.equal(batches.length, 1);
});

test("default background delivery keeps telemetry out of the run response path", async () => {
  const batches = [];
  globalThis.fetch = async (_url, init) => {
    batches.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const tracer = createTracer({
    delivery: { batchSize: 50, flushIntervalMs: 60_000 },
  });
  await tracer.run("SupportAgent", async () => {
    tracer.log("manual-note", { ok: true });
  });

  assert.equal(batches.length, 0);
  await tracer.shutdown();
  assert.equal(batches.length, 1);
});

test("background mode does not start HTTP delivery from run", async () => {
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const tracer = createTracer({
    delivery: { mode: "BACKGROUND", batchSize: 50, flushIntervalMs: 60_000 },
  });
  await tracer.run("SupportAgent", async () => {
    tracer.log("manual-note", { ok: true });
  });

  assert.equal(fetchCount, 0);
  await tracer.flush();
  assert.equal(fetchCount, 1);
  await tracer.shutdown();
});

test("delivery.timeoutMs is passed to telemetry requests", async () => {
  let signal;
  globalThis.fetch = async (_url, init) => {
    signal = init.signal;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const tracer = createTracer({
    delivery: { timeoutMs: 25, flushIntervalMs: 60_000 },
  });
  await tracer.run("SupportAgent", async () => {
    tracer.log("manual-note", { ok: true });
  });
  await tracer.shutdown();

  assert.ok(signal instanceof AbortSignal);
});

test("circuit breaker skips immediate telemetry retries after failures", async () => {
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ success: false }), { status: 200 });
  };

  const tracer = createTracer({
    delivery: {
      batchSize: 50,
      flushOnRunEnd: true,
      flushIntervalMs: 60_000,
    },
    circuitBreaker: {
      failureThreshold: 1,
      cooldownMs: 60_000,
    },
  });

  await tracer.run("SupportAgent", async () => {
    tracer.log("first", { ok: false });
  });
  await tracer.run("SupportAgent", async () => {
    tracer.log("second", { ok: false });
  });
  await tracer.shutdown();

  assert.equal(fetchCount, 1);
});

test("parallel runs keep AsyncLocalStorage contexts isolated", async () => {
  const batches = [];
  globalThis.fetch = async (_url, init) => {
    batches.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const tracer = createTracer({
    delivery: { batchSize: 100, flushIntervalMs: 60_000 },
  });
  await Promise.all([
    tracer.run(
      { agentName: "SupportAgent", sessionId: "session-A" },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        tracer.decision("A decision");
      },
    ),
    tracer.run(
      { agentName: "SupportAgent", sessionId: "session-B" },
      async () => {
        tracer.decision("B decision");
      },
    ),
  ]);
  await tracer.shutdown();

  const events = batches.flat();
  const decisionA = events.find(
    (event) => event.payload.reason === "A decision",
  );
  const decisionB = events.find(
    (event) => event.payload.reason === "B decision",
  );
  assert.equal(decisionA.sessionId, "session-A");
  assert.equal(decisionB.sessionId, "session-B");
});

test("delivery queue drops oldest events when maxQueueSize is reached", async () => {
  const batches = [];
  globalThis.fetch = async (_url, init) => {
    batches.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const tracer = createTracer({
    delivery: {
      batchSize: 100,
      flushIntervalMs: 60_000,
      maxQueueSize: 3,
      overflowStrategy: "DROP_OLDEST",
    },
  });

  await tracer.run("SupportAgent", async () => {
    tracer.log("first", { index: 1 });
    tracer.log("second", { index: 2 });
    tracer.log("third", { index: 3 });
    tracer.log("fourth", { index: 4 });
  });
  await tracer.shutdown();

  const labels = batches
    .flat()
    .map((event) => event.label)
    .filter((label) => ["first", "second", "third", "fourth"].includes(label));
  assert.deepEqual(labels, ["third", "fourth"]);
});

test("setAttributes attaches metadata to subsequent events only", async () => {
  const batches = [];
  globalThis.fetch = async (_url, init) => {
    batches.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const tracer = createTracer({
    delivery: { batchSize: 100, flushIntervalMs: 60_000 },
  });
  await tracer.run("SupportAgent", async () => {
    tracer.log("before", { ok: true });
    tracer.setAttributes({ orderId: "order-1" });
    tracer.log("after", { ok: true });
  });
  await tracer.shutdown();

  const events = batches.flat();
  assert.equal(
    events.find((event) => event.label === "before").payload.orderId,
    undefined,
  );
  assert.equal(
    events.find((event) => event.label === "after").payload.orderId,
    "order-1",
  );
});

test("guardTool supports action decisions and input shortcut", async () => {
  const batches = [];
  globalThis.fetch = async (_url, init) => {
    batches.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const tracer = createTracer();
  const refund = tracer.guardTool(
    "refund",
    async ({ amount }) => ({ refunded: amount }),
    {
      riskLevel: "HIGH",
      beforeCall: ({ input }) => ({
        action: input.amount <= 100 ? "ALLOW" : "BLOCK",
        policyId: "refund-limit",
        reason: "Refund amount is over the limit",
      }),
    },
  );

  await assert.rejects(
    () => tracer.run("SupportAgent", () => refund({ amount: 500 })),
    (error) => {
      assert.ok(error instanceof LynxPolicyError);
      assert.equal(error.action, "BLOCK");
      assert.equal(error.policyId, "refund-limit");
      assert.match(error.message, /Refund amount is over the limit/);
      return true;
    },
  );
  await tracer.shutdown();

  const policy = batches
    .flat()
    .find((event) => event.eventType === "POLICY_EVALUATION");
  assert.equal(policy.payload.action, "BLOCK");
  assert.equal(policy.payload.input.amount, 500);
});

test("getStatus reports queue and circuit breaker state", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: false }), { status: 200 });

  const tracer = createTracer({
    delivery: {
      batchSize: 50,
      flushIntervalMs: 60_000,
    },
    circuitBreaker: {
      failureThreshold: 1,
      cooldownMs: 60_000,
    },
  });

  await tracer.run("SupportAgent", async () => {
    tracer.log("manual-note", { ok: false });
  });
  await tracer.flush();

  const status = tracer.getStatus();
  assert.equal(status.queueSize, 3);
  assert.equal(status.circuitState, "OPEN");
  assert.equal(status.lastError, "batch_failed");
  await tracer.shutdown({ timeoutMs: 20 });
});

test("shutdown can return after the configured timeout", async () => {
  globalThis.fetch = async () => new Promise(() => {});

  const tracer = createTracer({
    delivery: {
      batchSize: 50,
      flushIntervalMs: 60_000,
    },
  });

  await tracer.run("SupportAgent", async () => {
    tracer.log("manual-note", { ok: true });
  });

  const start = Date.now();
  await tracer.shutdown({ timeoutMs: 20 });
  assert.equal(Date.now() - start < 500, true);
});

test("guardTool applies failureMode when policy evaluation throws", async () => {
  const batches = [];
  globalThis.fetch = async (_url, init) => {
    batches.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const tracer = createTracer();
  const riskyTool = tracer.guardTool(
    "wireTransfer",
    async () => ({ ok: true }),
    {
      riskLevel: "HIGH",
      failureMode: "FAIL_CLOSED",
      beforeCall: () => {
        throw new Error("policy service unavailable");
      },
    },
  );

  await assert.rejects(
    () => tracer.run("SupportAgent", () => riskyTool({ amount: 500 })),
    /policy service unavailable/,
  );
  await tracer.shutdown();

  const policy = batches
    .flat()
    .find((event) => event.eventType === "POLICY_EVALUATION");
  assert.equal(policy.payload.action, "BLOCK");
  assert.equal(policy.payload.metadata.policyError, true);
  assert.equal(policy.payload.metadata.failureMode, "FAIL_CLOSED");
});

test("semantic APIs capture agent behavior and outcome events", async () => {
  const batches = [];
  globalThis.fetch = async (_url, init) => {
    batches.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const tracer = createTracer({
    appVersion: "1.2.3",
    deploymentId: "deploy-7",
    environment: "test",
    policyVersion: "policy-1",
  });

  await tracer.run("SupportAgent", async () => {
    tracer.userInput("refund my last order", { userId: "usr-1" });
    tracer.decision("selected refund workflow", {
      candidates: ["refund", "faq"],
    });
    tracer.context({ orderId: "ord-1", refundWindowDays: 30 });
    tracer.memory("read", { key: "customer-tier", value: "gold" });
    tracer.outcome({
      status: "COMPLETED",
      businessStatus: "FAILED",
      reason: "Refund amount exceeded policy",
      userImpact: "HIGH",
    });
  });
  await tracer.shutdown();

  const events = batches.flat();
  assert.ok(events.some((event) => event.eventType === "USER_INPUT"));
  assert.ok(events.some((event) => event.eventType === "AGENT_DECISION"));
  assert.ok(events.some((event) => event.eventType === "CONTEXT_RETRIEVAL"));
  assert.ok(events.some((event) => event.eventType === "MEMORY_ACCESS"));
  const outcome = events.find((event) => event.eventType === "SESSION_OUTCOME");
  assert.equal(outcome.payload.businessStatus, "FAILED");
  assert.equal(outcome.payload.appVersion, "1.2.3");
  assert.equal(outcome.payload.deploymentId, "deploy-7");
  assert.equal(outcome.payload.environment, "test");
  assert.equal(outcome.payload.policyVersion, "policy-1");
});

test("instrumentLLM captures OpenAI Responses API calls", async () => {
  const batches = [];
  globalThis.fetch = async (_url, init) => {
    batches.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const tracer = createTracer();
  const client = tracer.instrumentLLM({
    responses: {
      create: async (input) => ({
        id: "resp_123",
        output_text: `answer: ${input.input}`,
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          total_tokens: 20,
        },
      }),
    },
  });

  await tracer.run("SupportAgent", async () => {
    const result = await client.responses.create({
      model: "gpt-4.1-mini",
      input: "Summarize this ticket",
      promptVersion: "support-summary-v3",
    });

    assert.equal(result.output_text, "answer: Summarize this ticket");
  });
  await tracer.shutdown();

  const llmEvents = batches
    .flat()
    .filter((event) => event.eventType === "LLM_CALL");

  assert.equal(llmEvents.length, 2);
  assert.equal(llmEvents[0].payload.path, "responses.create");
  assert.equal(llmEvents[0].payload.model, "gpt-4.1-mini");
  assert.equal(llmEvents[0].payload.promptVersion, "support-summary-v3");
  assert.equal(llmEvents[1].payload.phase, "end");
  assert.equal(llmEvents[1].payload.usage.totalTokens, 20);
});

test("instrumentTool captures tool call metadata and result summary", async () => {
  const batches = [];
  globalThis.fetch = async (_url, init) => {
    batches.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const tracer = createTracer();
  const lookupOrder = tracer.instrumentTool(
    "orders.lookup",
    async ({ orderId }) => ({ orderId, status: "paid" }),
    {
      sideEffect: false,
      riskLevel: "LOW",
      externalTarget: "orders-api",
      toolVersion: "2026-06-29",
    },
  );

  await tracer.run("SupportAgent", async () => {
    const result = await lookupOrder({ orderId: "order_123" });
    assert.equal(result.status, "paid");
  });
  await tracer.shutdown();

  const events = batches.flat();
  const call = events.find((event) => event.eventType === "TOOL_CALL");
  const result = events.find((event) => event.eventType === "TOOL_RESULT");

  assert.equal(call.label, "orders.lookup");
  assert.equal(call.payload.externalTarget, "orders-api");
  assert.equal(call.payload.toolVersion, "2026-06-29");
  assert.equal(result.payload.toolName, "orders.lookup");
  assert.match(result.payload.resultSummary, /order_123/);
});

test("guardTool records policy events and blocks unsafe calls", async () => {
  const batches = [];
  globalThis.fetch = async (_url, init) => {
    batches.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const tracer = createTracer();
  const refund = tracer.guardTool(
    "refund",
    async ({ amount }) => ({ refunded: amount }),
    {
      riskLevel: "HIGH",
      sideEffect: true,
      beforeCall: ({ args }) => {
        const amount = args[0]?.amount ?? 0;
        return {
          allow: amount <= 100,
          policyId: "refund-limit",
          reason: "Refund amount is over the limit",
          severity: "HIGH",
        };
      },
    },
  );

  await assert.rejects(
    () => tracer.run("SupportAgent", () => refund({ amount: 500 })),
    /Refund amount is over the limit/,
  );
  await tracer.shutdown();

  const events = batches.flat();
  assert.ok(events.some((event) => event.eventType === "POLICY_EVALUATION"));
  assert.ok(events.some((event) => event.eventType === "POLICY_VIOLATION"));
  assert.ok(events.some((event) => event.eventType === "GUARDRAIL_ACTIVATED"));
  assert.equal(
    events.some((event) => event.eventType === "TOOL_RESULT"),
    false,
  );
});
