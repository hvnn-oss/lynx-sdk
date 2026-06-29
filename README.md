# Lynx SDK

TypeScript SDK for tracing, debugging, and governing AI agent runs with Lynx.

Lynx records what happened during an agent run: user input, agent decisions,
LLM calls, tool calls, context loading, policy decisions, retries, errors, and
the final outcome. The SDK is designed for production services, so event
delivery failures do not stop your application by default.

## Installation

```bash
pnpm add @lynxops/sdk
```

```bash
npm install @lynxops/sdk
```

```bash
yarn add @lynxops/sdk
```

## Quick Start

```ts
import { LynxTracer } from "@lynxops/sdk";

const lynx = new LynxTracer({
  clientId: "support-api",
  apiKey: process.env.LYNX_API_KEY,
  workspaceId: process.env.LYNX_WORKSPACE_ID,
  environment: "production",
});

await lynx.run("SupportAgent", async () => {
  lynx.userInput("I want a refund", { userId: "usr_123" });
  lynx.setAttributes({ orderId: "order_123" });

  lynx.context("refund-policy", {
    refundWindowDays: 30,
  });

  lynx.decision({
    name: "select_refund_workflow",
    selected: "refund",
    confidence: 0.82,
    reason: "Order is inside the refund window",
  });

  lynx.outcome({
    status: "COMPLETED",
    businessStatus: "SUCCEEDED",
    reason: "Refund request was accepted",
  });
});
```

By default, events are sent to:

```text
https://api.lynxops.co
```

Use `endpoint` or `LYNX_ENDPOINT` for local development or self-hosted
deployments.

## Default Instance

The SDK exports a default `lynx` instance configured from environment
variables.

```ts
import { lynx } from "@lynxops/sdk";

await lynx.run("ResearchAgent", async () => {
  lynx.userInput("Find the latest invoice policy");
  lynx.decision("search internal docs first");
});
```

```bash
LYNX_CLIENT_ID=support-api
LYNX_API_KEY=lynx_sk_...
LYNX_WORKSPACE_ID=...
LYNX_ENVIRONMENT=production
```

## Production Delivery Model

The SDK prioritizes your application over event delivery.

Production-oriented defaults:

| Option | Default |
| --- | --- |
| `endpoint` | `https://api.lynxops.co` |
| `delivery.mode` | `BACKGROUND` |
| `delivery.timeoutMs` | `1000` |
| `delivery.flushOnRunEnd` | `false` |
| `delivery.flushIntervalMs` | `3000` |
| `delivery.batchSize` | `50` |
| `delivery.maxQueueSize` | `1000` |
| `delivery.overflowStrategy` | `DROP_OLDEST` |
| `circuitBreaker.enabled` | `true` |
| `circuitBreaker.failureThreshold` | `3` |
| `circuitBreaker.cooldownMs` | `30000` |

Recommended production configuration:

```ts
const lynx = new LynxTracer({
  clientId: "support-api",
  apiKey: process.env.LYNX_API_KEY,
  workspaceId: process.env.LYNX_WORKSPACE_ID,

  delivery: {
    mode: "BACKGROUND",
    timeoutMs: 1000,
    flushOnRunEnd: false,
    flushIntervalMs: 5000,
    batchSize: 50,
    maxQueueSize: 10_000,
    overflowStrategy: "DROP_OLDEST",
  },

  circuitBreaker: {
    enabled: true,
    failureThreshold: 3,
    cooldownMs: 30_000,
  },
});
```

If the Lynx API is unavailable, the SDK:

- catches network, timeout, and non-2xx delivery errors
- queues events in memory
- retries with backoff
- opens a circuit breaker after repeated failures
- drops events according to the configured overflow strategy when the queue is
  full

With the default background delivery mode, `run()` does not wait for event
HTTP requests.

## Capturing Agent Runs

Use `run()` as the unit of work for one agent execution.

```ts
await lynx.run(
  "InvoiceAgent",
  async () => {
    lynx.userInput("Can this invoice be paid?");
    lynx.decision("verify vendor and payment policy");
  },
  {
    workspaceId: "workspace_123",
    agentId: "agent_invoice",
    sessionId: "session_456",
  },
);
```

Useful identifiers:

| Field | Purpose |
| --- | --- |
| `runId` | Unique execution id for one agent run. Generated automatically unless provided. |
| `sessionId` | Groups multiple runs or events into a user-visible session. |
| `workspaceId` | Tenant boundary for Lynx ingestion and dashboards. |
| `agentId` | Stable agent identifier. |
| `agentName` | Human-readable agent name shown in debugging views. |
| `environment` | Runtime environment such as `production`, `staging`, or `local`. |
| `appVersion` | Application release metadata. |
| `deploymentId` | Deployment metadata for incident correlation. |
| `promptVersion` | Prompt version metadata attached to LLM and reasoning events. |
| `policyVersion` | Guardrail or policy version metadata. |

## Semantic Events

Prefer semantic helpers over raw event logging. They make Lynx debugging views
more useful.

```ts
lynx.userInput("Book a flight to Seoul", { userId: "usr_123" });

lynx.context("calendar-availability", {
  daysLoaded: 14,
  source: "calendar-api",
});

lynx.decision({
  name: "choose_booking_tool",
  selected: "flight_search",
  alternatives: ["email_assistant", "manual_handoff"],
  confidence: 0.76,
  reason: "The user requested a travel booking action",
});

lynx.log("tool.timeout", {
  error: "Travel API timed out",
  toolName: "travel.search",
});

lynx.outcome({
  status: "FAILED",
  businessStatus: "FAILED",
  reason: "The external travel API timed out",
  userImpact: "MEDIUM",
});
```

## Record LLM calls

Use `instrumentLLM()` to wrap a model client. The returned proxy preserves the
original client shape while recording supported model calls.

```ts
const instrumentedClient = lynx.instrumentLLM(client, {
  modelLabel: "openai.gpt-4.1-mini",
});

await lynx.run("SupportAgent", async () => {
  await instrumentedClient.responses.create({
    model: "gpt-4.1-mini",
    input: "Summarize this support ticket",
    metadata: {
      promptVersion: "support-summary-v3",
    },
  });
});
```

## Record tool calls

Use `instrumentTool()` to wrap a reusable tool function.

```ts
const postSlackMessage = lynx.instrumentTool(
  "slack.postMessage",
  async (input: { channel: string; text: string }) => {
    return await slack.chat.postMessage(input);
  },
  {
    sideEffect: true,
    riskLevel: "MEDIUM",
    externalTarget: "slack",
  },
);

await postSlackMessage({
  channel: "C123",
  text: "Refund approved",
});
```

## Local Guardrails

`guardTool()` evaluates your policy locally before a tool runs. Lynx server
availability does not decide whether the tool is blocked.

```ts
import { LynxPolicyError } from "@lynxops/sdk";

const refund = lynx.guardTool(
  "refund.create",
  async ({ amount }: { amount: number }) => {
    return { refunded: amount };
  },
  {
    sideEffect: true,
    riskLevel: "HIGH",
    failureMode: "FAIL_CLOSED",
    beforeCall: ({ input }) => {
      if (input.amount > 100) {
        return {
          action: "BLOCK",
          policyId: "refund-limit",
          reason: "Refund amount is over the approved limit",
          severity: "HIGH",
        };
      }

      return {
        action: "ALLOW",
        policyId: "refund-limit",
      };
    },
  },
);

try {
  await lynx.run("SupportAgent", () => refund({ amount: 500 }));
} catch (error) {
  if (error instanceof LynxPolicyError) {
    console.log(error.action, error.policyId, error.reason);
  }
}
```

Policy behavior:

| Policy result | Behavior |
| --- | --- |
| `ALLOW` | Runs the tool and records policy evaluation metadata. |
| `WARN` | Runs the tool and records a warning. |
| `BLOCK` | Blocks the tool and throws `LynxPolicyError`. |
| `REQUIRE_APPROVAL` | Blocks the tool and throws `LynxPolicyError`. |

If policy evaluation itself throws, `failureMode` decides the fallback:

| Failure mode | Behavior |
| --- | --- |
| `FAIL_OPEN` | Allows the tool call and records the policy error. |
| `FAIL_CLOSED` | Blocks the tool call. |
| `REQUIRE_APPROVAL` | Blocks with `action: "REQUIRE_APPROVAL"`. |

## Capture Modes

Lynx does not require you to store full payloads.

| Mode | Behavior |
| --- | --- |
| `full` | Captures input and output payloads according to `captureInput` and `captureOutput`. |
| `metadata-only` | Keeps structure, timing, token usage, cost, status, errors, tool names, and trace metadata without raw content. |
| `smart` | Captures metadata for normal events and preserves richer detail for failures, policy violations, and abnormal latency. |

```ts
const lynx = new LynxTracer({
  clientId: "support-api",
  apiKey: process.env.LYNX_API_KEY,
  captureMode: "smart",
  maxPayloadLength: 16_000,
});
```

## Flush, Shutdown, and Health

Use `flush()` to send the current queue while keeping the SDK active.

```ts
await lynx.flush();
```

Use `shutdown()` when the process is about to exit, in serverless handlers, or
in tests.

```ts
await lynx.shutdown({ timeoutMs: 1000 });
```

Use `getStatus()` for local diagnostics.

```ts
const status = lynx.getStatus();

console.log({
  queueSize: status.queueSize,
  droppedEvents: status.droppedEvents,
  circuitState: status.circuitState,
  pendingTransmissions: status.pendingTransmissions,
});
```

## Configuration Reference

```ts
const lynx = new LynxTracer({
  clientId: "support-api",
  endpoint: "https://api.lynxops.co",
  workspaceId: "workspace_123",
  agentId: "agent_support",
  apiKey: process.env.LYNX_API_KEY,
  appVersion: "2026.06.29",
  deploymentId: "deploy_123",
  environment: "production",
  policyVersion: "policy_2026_06",
  sampleRate: 1,
  captureInput: true,
  captureOutput: true,
  captureMode: "smart",
  maxPayloadLength: 16_000,
  delivery: {
    mode: "BACKGROUND",
    timeoutMs: 1000,
    flushOnRunEnd: false,
    flushIntervalMs: 3000,
    batchSize: 50,
    maxQueueSize: 1000,
    overflowStrategy: "DROP_OLDEST",
  },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 3,
    cooldownMs: 30_000,
  },
});
```

| Option | Description |
| --- | --- |
| `clientId` | Required service or client identifier. |
| `endpoint` | Lynx API endpoint. Defaults to `https://api.lynxops.co`. |
| `workspaceId` | Default workspace id attached to events. |
| `agentId` | Default agent id attached to events. |
| `apiKey` | Lynx ingestion API key. Sent as a bearer token. |
| `appVersion` | Application version metadata. |
| `deploymentId` | Deployment id metadata. |
| `environment` | Runtime environment metadata. |
| `policyVersion` | Default policy version metadata. |
| `sampleRate` | Trace sampling ratio from `0` to `1`. |
| `captureInput` | Whether input payloads can be captured. |
| `captureOutput` | Whether output payloads can be captured. |
| `captureMode` | `full`, `metadata-only`, or `smart`. |
| `maxPayloadLength` | Maximum serialized payload length per event. |
| `delivery.mode` | `BACKGROUND` or `BLOCKING`. |
| `delivery.timeoutMs` | Timeout for one event delivery request. |
| `delivery.flushOnRunEnd` | Whether `run()` tries to flush after the wrapped work finishes. |
| `delivery.flushIntervalMs` | Background flush interval. |
| `delivery.batchSize` | Batch size for delivery. |
| `delivery.maxQueueSize` | Maximum queued events in memory. |
| `delivery.overflowStrategy` | `DROP_OLDEST` or `DROP_NEWEST`. |
| `circuitBreaker.enabled` | Enables delivery circuit breaker protection. |
| `circuitBreaker.failureThreshold` | Consecutive delivery failures before opening the breaker. |
| `circuitBreaker.cooldownMs` | Cooldown before retrying after the breaker opens. |

## Environment Variables

The default `lynx` export reads these variables:

| Variable | Description |
| --- | --- |
| `LYNX_CLIENT_ID` | Client or service identifier. Defaults to `local_dev_env`. |
| `LYNX_ENDPOINT` | Optional Lynx API endpoint override. |
| `LYNX_API_KEY` | Lynx ingestion API key. |
| `LYNX_WORKSPACE_ID` | Default workspace id. |
| `LYNX_AGENT_ID` | Default agent id. |
| `LYNX_SESSION_ID` | Default session id when `run()` does not receive one. |
| `LYNX_SAMPLE_RATE` | Sampling rate from `0` to `1`. |
| `LYNX_CAPTURE_INPUT` | `true` or `false`. |
| `LYNX_CAPTURE_OUTPUT` | `true` or `false`. |
| `LYNX_CAPTURE_MODE` | `full`, `metadata-only`, or `smart`. |
| `LYNX_MAX_PAYLOAD_LENGTH` | Maximum payload string length. |
| `LYNX_APP_VERSION` | Application version metadata. |
| `LYNX_DEPLOYMENT_ID` | Deployment id metadata. |
| `LYNX_ENVIRONMENT` | Runtime environment metadata. Falls back to `NODE_ENV`. |
| `LYNX_POLICY_VERSION` | Default policy version metadata. |
| `LYNX_DELIVERY_MODE` | `BACKGROUND` or `BLOCKING`. |
| `LYNX_DELIVERY_TIMEOUT_MS` | Delivery timeout in milliseconds. |
| `LYNX_DELIVERY_FLUSH_ON_RUN_END` | `true` or `false`. |
| `LYNX_DELIVERY_FLUSH_INTERVAL_MS` | Flush interval in milliseconds. |
| `LYNX_DELIVERY_BATCH_SIZE` | Batch size. |
| `LYNX_DELIVERY_MAX_QUEUE_SIZE` | Maximum queued event count. |
| `LYNX_DELIVERY_OVERFLOW_STRATEGY` | `DROP_OLDEST` or `DROP_NEWEST`. |
| `LYNX_CIRCUIT_BREAKER_ENABLED` | `true` or `false`. |
| `LYNX_CIRCUIT_BREAKER_FAILURE_THRESHOLD` | Consecutive failure count before opening the breaker. |
| `LYNX_CIRCUIT_BREAKER_COOLDOWN_MS` | Circuit breaker cooldown in milliseconds. |

## Development

```bash
pnpm install
pnpm build
pnpm test
```

The SDK is ESM-first and also publishes a CommonJS build through package
exports.
