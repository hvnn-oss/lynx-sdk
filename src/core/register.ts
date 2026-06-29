import { DEFAULT_ENDPOINT, LynxTracer } from "./tracer.js";

const parseBool = (val: string | undefined): boolean | undefined => {
  if (val === undefined) return undefined;
  return val.toLowerCase() === "true";
};

const parseNum = (val: string | undefined): number | undefined => {
  if (val === undefined) return undefined;
  const num = parseFloat(val);
  return isNaN(num) ? undefined : num;
};

/**
 * Default Lynx tracer instance configured from environment variables.
 *
 * This is the recommended entry point for most applications. Configure it with
 * `LYNX_CLIENT_ID`, `LYNX_API_KEY`, and optional endpoint, capture,
 * delivery, and deployment metadata variables before importing the SDK.
 *
 * @example
 * ```ts
 * import { lynx } from "@lynxops/sdk";
 *
 * await lynx.run("SupportAgent", async () => {
 *   lynx.userInput("Where is my order?");
 * });
 * ```
 */
export const lynx = new LynxTracer({
  clientId: process.env.LYNX_CLIENT_ID || "local_dev_env",
  endpoint: process.env.LYNX_ENDPOINT || DEFAULT_ENDPOINT,
  sampleRate: parseNum(process.env.LYNX_SAMPLE_RATE),
  captureInput: parseBool(process.env.LYNX_CAPTURE_INPUT),
  captureOutput: parseBool(process.env.LYNX_CAPTURE_OUTPUT),
  maxPayloadLength: parseNum(process.env.LYNX_MAX_PAYLOAD_LENGTH),
  captureMode: (process.env.LYNX_CAPTURE_MODE as any) || "smart",
  workspaceId: process.env.LYNX_WORKSPACE_ID,
  agentId: process.env.LYNX_AGENT_ID,
  apiKey: process.env.LYNX_API_KEY,
  appVersion: process.env.LYNX_APP_VERSION,
  deploymentId: process.env.LYNX_DEPLOYMENT_ID,
  environment: process.env.LYNX_ENVIRONMENT || process.env.NODE_ENV,
  policyVersion: process.env.LYNX_POLICY_VERSION,

  delivery: {
    mode: process.env.LYNX_DELIVERY_MODE as any,
    timeoutMs: parseNum(process.env.LYNX_DELIVERY_TIMEOUT_MS),
    flushOnRunEnd: parseBool(process.env.LYNX_DELIVERY_FLUSH_ON_RUN_END),
    flushIntervalMs: parseNum(process.env.LYNX_DELIVERY_FLUSH_INTERVAL_MS),
    batchSize: parseNum(process.env.LYNX_DELIVERY_BATCH_SIZE),
    maxQueueSize: parseNum(process.env.LYNX_DELIVERY_MAX_QUEUE_SIZE),
    overflowStrategy: process.env.LYNX_DELIVERY_OVERFLOW_STRATEGY as any,
  },
  circuitBreaker: {
    enabled: parseBool(process.env.LYNX_CIRCUIT_BREAKER_ENABLED),
    failureThreshold: parseNum(
      process.env.LYNX_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    ),
    cooldownMs: parseNum(process.env.LYNX_CIRCUIT_BREAKER_COOLDOWN_MS),
  },
});
