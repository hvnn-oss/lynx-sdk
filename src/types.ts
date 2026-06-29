// Generated from packages/sdk-types during OSS sync.
/**
 * Execution context stored for the active Lynx trace.
 */
export interface LynxContext {
  runId: string;
  agentName: string;
  spanId?: string;
  parentSpanId?: string;
  sampled?: boolean;
  workspaceId?: string;
  agentId?: string;
  sessionId?: string;
  eventCounts?: Record<string, number>;
  attributes?: Record<string, any>;
}

/**
 * Options used when starting an agent run.
 */
export interface LynxRunOptions {
  agentName: string;
  workspaceId?: string;
  agentId?: string;
  sessionId?: string;
  runId?: string;
}

/**
 * Configuration options for the Lynx SDK runtime.
 */
export interface LynxConfig {
  clientId: string;
  endpoint?: string;
  workspaceId?: string;
  agentId?: string;
  apiKey?: string;
  appVersion?: string;
  deploymentId?: string;
  environment?: string;
  policyVersion?: string;

  /**
   * Telemetry sampling ratio between 0.0 and 1.0.
   *
   * For example, `0.1` captures roughly 10% of traces. When omitted, all traces
   * are captured unless a runtime context overrides sampling.
   */
  sampleRate?: number;

  /**
   * Whether request/input payloads should be captured.
   */
  captureInput?: boolean;

  /**
   * Whether response/output payloads should be captured.
   */
  captureOutput?: boolean;

  /**
   * Maximum serialized payload length for a single event.
   */
  maxPayloadLength?: number;

  /**
   * Telemetry capture and retention mode.
   *
   * - `full`: Capture full input/output payloads.
   * - `metadata-only`: Capture structure, timing, usage, status, and error
   *   metadata without raw content.
   * - `smart`: Prefer metadata for normal events while preserving richer
   *   details for failures, policy violations, and abnormal latency.
   */
  captureMode?: "full" | "metadata-only" | "smart";

  /**
   * Structured telemetry delivery configuration.
   */
  delivery?: {
    mode?: "BLOCKING" | "BACKGROUND";
    timeoutMs?: number;
    flushOnRunEnd?: boolean;
    flushIntervalMs?: number;
    batchSize?: number;
    maxQueueSize?: number;
    overflowStrategy?: "DROP_OLDEST" | "DROP_NEWEST";
  };

  /**
   * Circuit breaker configuration for telemetry export only.
   */
  circuitBreaker?: {
    enabled?: boolean;
    failureThreshold?: number;
    cooldownMs?: number;
  };
}

/**
 * Token usage returned by an LLM provider.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type LynxSessionStatus = "COMPLETED" | "FAILED" | "CANCELLED";
export type LynxBusinessStatus = "SUCCEEDED" | "FAILED" | "PARTIAL" | "UNKNOWN";
export type LynxRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type LynxPolicyAction =
  | "ALLOW"
  | "BLOCK"
  | "WARN"
  | "REQUIRE_APPROVAL"
  | "REDACT"
  | "MODIFY";
export type LynxGuardFailureMode =
  | "FAIL_OPEN"
  | "FAIL_CLOSED"
  | "REQUIRE_APPROVAL";

export interface LynxOutcomeOptions {
  status: LynxSessionStatus;
  businessStatus?: LynxBusinessStatus;
  reason?: string;
  userImpact?: LynxRiskLevel;
  metadata?: Record<string, any>;
}

export interface LynxDecisionOptions {
  name: string;
  description?: string;
  selected?: string;
  alternatives?: string[];
  confidence?: number;
  reason?: string;
  metadata?: Record<string, any>;
}

export interface LynxToolMetadata {
  toolVersion?: string;
  sideEffect?: boolean;
  riskLevel?: LynxRiskLevel;
  externalTarget?: string;
  idempotencyKey?: string;
  failureMode?: LynxGuardFailureMode;
  [key: string]: any;
}

export interface LynxPolicyDecision {
  allow?: boolean;
  action?: LynxPolicyAction;
  policyId?: string;
  policyVersion?: string;
  reason?: string;
  severity?: LynxRiskLevel;
  metadata?: Record<string, any>;
}

export interface LynxGuardToolOptions<
  TArgs extends any[] = any[],
> extends LynxToolMetadata {
  beforeCall?: (context: {
    toolName: string;
    input: TArgs[0];
    args: TArgs;
    metadata?: LynxToolMetadata;
  }) => LynxPolicyDecision | Promise<LynxPolicyDecision>;
}

export interface LynxShutdownOptions {
  timeoutMs?: number;
}

export interface LynxStatus {
  queueSize: number;
  droppedEvents: number;
  circuitState: "CLOSED" | "OPEN" | "HALF_OPEN" | "DISABLED";
  lastDeliveryAt?: string;
  lastError?: string;
  pendingTransmissions: number;
}

/**
 * Custom instrumentation rule for wrapping an LLM client method.
 */
export interface LlmInstrumentationRule {
  /**
   * Returns whether the current method path should be instrumented.
   */
  isTargetMethod: (path: string[]) => boolean;

  /**
   * Extracts prompt or input data from the intercepted method arguments.
   */
  extractInput?: (args: any[]) => any;

  /**
   * Extracts response content or structured output from the method result.
   */
  extractOutput?: (result: any) => any;

  /**
   * Extracts token usage from the method result.
   */
  extractUsage?: (result: any) => TokenUsage | undefined;

  /**
   * Estimates call cost from model and token usage.
   */
  estimateCost?: (
    model: string,
    promptTokens: number,
    completionTokens: number,
  ) => number;
}

/**
 * Event types captured by the Lynx SDK.
 */
export type LynxEventType =
  | "USER_INPUT"
  | "AGENT_DECISION"
  | "LLM_CALL"
  | "LLM_REASONING"
  | "TOOL_CALL"
  | "TOOL_RESULT"
  | "CALL_TOOLS"
  | "MEMORY_ACCESS"
  | "CONTEXT_RETRIEVAL"
  | "POLICY_EVALUATION"
  | "POLICY_VIOLATION"
  | "GUARDRAIL_ACTIVATED"
  | "SESSION_OUTCOME"
  | "LOOP_DETECTED"
  | "ERROR"
  | "CONTEXT_ALERT";

/**
 * Event payload schema used for trace, replay, and root-cause analysis.
 */
export interface LynxEventPayloadDto {
  input?: any;
  output?: any;
  error?: string;
  arguments?: any;

  // Span hierarchy
  spanId?: string;
  parentSpanId?: string;

  // Performance and cost analytics
  latency?: number;
  usage?: TokenUsage;
  cost?: number;

  // Runtime metadata for replay and root-cause analysis
  provider?: string;
  model?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  seed?: number | string;
  promptVersion?: string;
  systemPromptHash?: string;
  userPromptHash?: string;
  messageCount?: number;
  contextLength?: number;
  sdkVersion?: string;
  droppedEventCount?: number;
  appVersion?: string;
  deploymentId?: string;
  environment?: string;
  policyVersion?: string;

  // Tool execution metadata
  toolName?: string;
  toolVersion?: string;
  args?: any;
  argsHash?: string;
  result?: any;
  resultSummary?: string;
  sideEffect?: boolean;
  riskLevel?: LynxRiskLevel;
  externalTarget?: string;
  retryCount?: number;
  idempotencyKey?: string;

  // Loop runaway detection metadata
  loopDetected?: boolean;
  loopCount?: number;
  repeatedLabel?: string;

  // Prompt injection and context pollution metadata
  isPolluted?: boolean;
  pollutionReason?: string;

  [key: string]: any;
}

export interface LynxEventDto {
  eventId?: string;
  clientId: string;
  runId: string;
  agentName: string;
  eventType: LynxEventType;
  label: string;
  payload: LynxEventPayloadDto;
  timestamp: number;
  workspaceId?: string;
  agentId?: string;
  sessionId?: string;
  schemaVersion?: string;
}
