import { AsyncLocalStorage } from "async_hooks";
import {
  LynxConfig,
  LynxContext,
  LynxRunOptions,
  LlmInstrumentationRule,
  LynxEventDto,
  LynxGuardToolOptions,
  LynxOutcomeOptions,
  LynxPolicyDecision,
  LynxPolicyAction,
  LynxDecisionOptions,
  LynxToolMetadata,
  LynxShutdownOptions,
  LynxStatus,
} from "./types.js";
import { processPayload } from "../utils/payload.js";
import {
  generateTraceId,
  generateSpanId,
  generateEventId,
} from "../utils/id.js";
import { instrumentLLM, instrumentTool } from "../instrumentation/index.js";

const SDK_VERSION = "1.0.0";
export const DEFAULT_ENDPOINT = "https://api.lynxops.co";
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_BATCH_SIZE = 50;

export class LynxPolicyError extends Error {
  constructor(
    message: string,
    public readonly action: Extract<
      LynxPolicyAction,
      "BLOCK" | "REQUIRE_APPROVAL"
    >,
    public readonly policyId?: string,
    public readonly severity?: LynxToolMetadata["riskLevel"],
    public readonly reason?: string,
    public readonly metadata?: Record<string, any>,
  ) {
    super(message);
    this.name = "LynxPolicyError";
  }
}

function stableHash(data: any): string {
  const str = typeof data === "string" ? data : JSON.stringify(data ?? "");
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Main telemetry collector for Lynx-instrumented AI agent runtimes.
 *
 * `LynxTracer` owns the active async execution context, captures semantic
 * agent events, batches telemetry, retries failed deliveries, and provides
 * helpers for LLM/tool instrumentation. In most applications, use the shared
 * `lynx` instance exported from `@lynxops/sdk`; create a new instance only when
 * you need custom configuration per process or per test.
 *
 * @example
 * ```ts
 * const tracer = new LynxTracer({
 *   clientId: "support-service",
 *   apiKey: process.env.LYNX_API_KEY,
 * });
 *
 * await tracer.run("SupportAgent", async () => {
 *   tracer.userInput("refund my last order");
 *   tracer.decision("selected refund workflow");
 * });
 * ```
 */
export class LynxTracer {
  private static readonly storage = new AsyncLocalStorage<LynxContext>();
  private static readonly instances = new Set<LynxTracer>();
  private static beforeExitHookRegistered = false;
  private readonly config: LynxConfig & { endpoint: string };
  private readonly pendingPromises = new Set<Promise<any>>();
  private readonly eventQueue: LynxEventDto[] = [];
  private readonly retryQueue: LynxEventDto[] = [];
  private lastFailureTime = 0;
  private backoffDelayMs = 1000;
  private flushTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private isFlushInProgress = false;
  private consecutiveFlushFailures = 0;
  private circuitOpenedAt = 0;
  private droppedEventCount = 0;
  private lastDeliveryAt?: string;
  private lastError?: string;

  /**
   * Creates a tracer with the provided Lynx telemetry configuration.
   *
   * The constructor starts a background flush timer. The timer is unref'ed in
   * Node.js so it will not keep the process alive by itself. Call `shutdown()`
   * in tests, short-lived scripts, or server shutdown hooks to flush remaining
   * telemetry and clear the timer.
   *
   * @param config Runtime configuration for telemetry capture and delivery.
   */
  constructor(config: LynxConfig) {
    this.config = {
      ...config,
      endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
    };

    LynxTracer.instances.add(this);

    const interval = this.config.delivery?.flushIntervalMs ?? 3000;
    this.flushTimer = setInterval(() => {
      void this.flushInternal(false);
    }, interval);
    // Do not keep the Node.js process alive only for telemetry flushing.
    if (this.flushTimer && typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }

    // Flush remaining telemetry once when the process is about to exit.
    if (
      typeof process !== "undefined" &&
      !LynxTracer.beforeExitHookRegistered
    ) {
      LynxTracer.beforeExitHookRegistered = true;
      process.once("beforeExit", () => {
        void LynxTracer.shutdownAll();
      });
    }
  }

  private static async shutdownAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(LynxTracer.instances).map((instance) => instance.shutdown()),
    );
  }

  /**
   * Returns the current Lynx async execution context, if one is active.
   *
   * This is mainly useful for advanced instrumentation helpers that need to
   * attach their own telemetry to the currently running `run()` context.
   *
   * @returns The current context, or `undefined` when called outside `run()`.
   */
  static getStore(): LynxContext | undefined {
    return LynxTracer.storage.getStore();
  }

  private getFlushOnRunEnd(): boolean {
    return this.config.delivery?.flushOnRunEnd ?? false;
  }

  private getRequestTimeoutMs(): number {
    return this.config.delivery?.timeoutMs ?? 1000;
  }

  private isBackgroundOnly(): boolean {
    return (this.config.delivery?.mode ?? "BACKGROUND") === "BACKGROUND";
  }

  private getMaxQueueSize(): number {
    return this.config.delivery?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  }

  private getOverflowStrategy(): "DROP_OLDEST" | "DROP_NEWEST" {
    return this.config.delivery?.overflowStrategy ?? "DROP_OLDEST";
  }

  private enqueueEvent(event: LynxEventDto): boolean {
    const maxQueueSize = this.getMaxQueueSize();
    if (maxQueueSize <= 0) {
      this.droppedEventCount += 1;
      return false;
    }

    const totalQueued = this.eventQueue.length + this.retryQueue.length;
    if (totalQueued >= maxQueueSize) {
      this.droppedEventCount += 1;

      if (this.getOverflowStrategy() === "DROP_NEWEST") {
        return false;
      }

      if (this.retryQueue.length > 0) {
        this.retryQueue.shift();
      } else {
        this.eventQueue.shift();
      }
    }

    this.eventQueue.push(event);
    return true;
  }

  private enqueueRetryEvent(event: LynxEventDto): boolean {
    const maxQueueSize = this.getMaxQueueSize();
    if (maxQueueSize <= 0) {
      this.droppedEventCount += 1;
      return false;
    }

    const totalQueued = this.eventQueue.length + this.retryQueue.length;
    if (totalQueued >= maxQueueSize) {
      this.droppedEventCount += 1;

      if (this.getOverflowStrategy() === "DROP_NEWEST") {
        return false;
      }

      if (this.eventQueue.length > 0) {
        this.eventQueue.shift();
      } else {
        this.retryQueue.shift();
      }
    }

    this.retryQueue.push(event);
    return true;
  }

  /**
   * Flushes queued telemetry events to the Lynx ingestion endpoint.
   *
   * Events are sent in a single batch request. If delivery fails, the batch is
   * moved into an in-memory retry queue and future flushes are delayed with
   * exponential backoff. Normal applications usually do not need to call this
   * manually because the tracer flushes on an interval.
   *
   * @returns A promise that resolves after the current flush attempt completes.
   */
  async flush(): Promise<void> {
    await this.flushInternal(true);
  }

  private async flushInternal(waitForDelivery: boolean): Promise<void> {
    if (this.eventQueue.length === 0 && this.retryQueue.length === 0) {
      return;
    }

    if (this.isFlushInProgress) {
      return;
    }
    if (this.isCircuitOpen()) {
      return;
    }

    if (
      this.lastFailureTime > 0 &&
      Date.now() - this.lastFailureTime < this.backoffDelayMs
    ) {
      return;
    }

    const eventsToFlush = [...this.retryQueue, ...this.eventQueue];
    this.retryQueue.length = 0;
    this.eventQueue.length = 0;

    if (eventsToFlush.length === 0) {
      return;
    }

    this.isFlushInProgress = true;
    const url = `${this.config.endpoint}/openapi/v1/events/batch`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["x-api-key"] = this.config.apiKey;
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const promise = fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(eventsToFlush),
      signal: AbortSignal.timeout(this.getRequestTimeoutMs()),
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text();
          console.error(
            `[LynxTracer] telemetry batch flush failed with status ${res.status}: ${text}`,
          );
          this.handleFailedEvents(eventsToFlush, "http_error");
        } else {
          const result = await res.json().catch(() => ({ success: true }));
          if (result && result.success === false) {
            console.error(
              "[LynxTracer] telemetry batch flush returned failed details:",
              result,
            );
            this.handleFailedEvents(eventsToFlush, "batch_failed");
          } else {
            this.handleSuccessfulFlush();
          }
        }
      })
      .catch((err) => {
        console.error("LynxTracer telemetry batch flush failed:", err);
        this.handleFailedEvents(eventsToFlush, "network_error");
      })
      .finally(() => {
        this.pendingPromises.delete(promise);
        this.isFlushInProgress = false;
      });

    this.pendingPromises.add(promise);
    if (waitForDelivery || this.isShuttingDown) {
      await promise;
    }
  }

  /**
   * Returns a lightweight snapshot of SDK delivery health.
   *
   * Use this for readiness diagnostics, operational dashboards, or tests. The
   * status reflects local SDK state only; it does not perform a network request.
   *
   * @returns Current queue, circuit breaker, and delivery state.
   */
  getStatus(): LynxStatus {
    return {
      queueSize: this.eventQueue.length + this.retryQueue.length,
      droppedEvents: this.droppedEventCount,
      circuitState: this.getCircuitState(),
      lastDeliveryAt: this.lastDeliveryAt,
      lastError: this.lastError,
      pendingTransmissions: this.pendingPromises.size,
    };
  }

  /**
   * Flushes queued telemetry and releases SDK timers.
   *
   * Use this for graceful process shutdown, tests, CLI scripts, and serverless
   * handlers where the runtime may terminate before the background interval
   * fires. Calling `shutdown()` more than once is safe.
   *
   * @returns A promise that resolves after pending telemetry transmissions settle.
   */
  async shutdown(options: LynxShutdownOptions = {}): Promise<void> {
    if (this.isShuttingDown) return;

    this.isShuttingDown = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    const shutdownWork = async () => {
      await this.flushInternal(true);
      if (this.pendingPromises.size > 0) {
        await Promise.allSettled(Array.from(this.pendingPromises));
      }
    };

    if (options.timeoutMs !== undefined) {
      await Promise.race([
        shutdownWork(),
        new Promise<void>((resolve) => setTimeout(resolve, options.timeoutMs)),
      ]);
    } else {
      await shutdownWork();
    }
    LynxTracer.instances.delete(this);
  }

  private isCircuitBreakerEnabled(): boolean {
    return this.config.circuitBreaker?.enabled ?? true;
  }

  private isCircuitOpen(): boolean {
    if (!this.isCircuitBreakerEnabled() || this.circuitOpenedAt === 0) {
      return false;
    }

    return (
      Date.now() - this.circuitOpenedAt <
      (this.config.circuitBreaker?.cooldownMs ?? 30000)
    );
  }

  private getCircuitState(): LynxStatus["circuitState"] {
    if (!this.isCircuitBreakerEnabled()) {
      return "DISABLED";
    }
    if (this.circuitOpenedAt === 0) {
      return "CLOSED";
    }
    return this.isCircuitOpen() ? "OPEN" : "HALF_OPEN";
  }

  private handleSuccessfulFlush(): void {
    this.lastFailureTime = 0;
    this.backoffDelayMs = 1000;
    this.consecutiveFlushFailures = 0;
    this.circuitOpenedAt = 0;
    this.lastDeliveryAt = new Date().toISOString();
    this.lastError = undefined;
  }

  private handleFailedEvents(events: LynxEventDto[], reason: string): void {
    this.lastFailureTime = Date.now();
    this.consecutiveFlushFailures += 1;

    if (
      this.isCircuitBreakerEnabled() &&
      this.consecutiveFlushFailures >=
        (this.config.circuitBreaker?.failureThreshold ?? 3)
    ) {
      this.circuitOpenedAt = Date.now();
      console.warn(
        `[LynxTracer] Telemetry circuit breaker opened after ${this.consecutiveFlushFailures} consecutive failures. Reason: ${reason}.`,
      );
    }
    this.lastError = reason;

    for (const event of events) {
      this.enqueueRetryEvent(event);
    }

    this.backoffDelayMs = Math.min(this.backoffDelayMs * 2, 60000);
    console.warn(
      `[LynxTracer] Offline retry buffer saved ${events.length} events. Total size: ${this.retryQueue.length}. Backing off for ${this.backoffDelayMs}ms.`,
    );
  }

  /**
   * Runs code inside a Lynx trace context.
   *
   * Every semantic event, instrumented LLM call, and instrumented tool call made
   * inside `executionBlock` will be associated with the same run/session. Nested
   * `run()` calls automatically inherit the parent run id and create a child
   * span relationship.
   *
   * @typeParam T The value returned by the wrapped execution block.
   * @param optionsOrAgentName Agent name or detailed run options.
   * @param executionBlock Function to execute while the Lynx context is active.
   * @returns The original return value of `executionBlock`.
   *
   * @example
   * ```ts
   * await lynx.run({ agentName: "SupportAgent", sessionId: "s-123" }, async () => {
   *   lynx.userInput("I need a refund");
   *   return await agent.handle();
   * });
   * ```
   */
  async run<T>(
    optionsOrAgentName: string | LynxRunOptions,
    executionBlock: () => Promise<T> | T,
  ): Promise<T> {
    const options =
      typeof optionsOrAgentName === "string"
        ? { agentName: optionsOrAgentName }
        : optionsOrAgentName;

    const agentName = options.agentName;
    const parentContext = LynxTracer.storage.getStore();
    const runId =
      options.runId ??
      (parentContext ? parentContext.runId : generateTraceId());
    const parentSpanId = parentContext ? parentContext.spanId : undefined;
    const spanId = generateSpanId();

    const workspaceId =
      options.workspaceId ??
      parentContext?.workspaceId ??
      this.config.workspaceId ??
      process.env.LYNX_WORKSPACE_ID;
    const agentId =
      options.agentId ??
      parentContext?.agentId ??
      this.config.agentId ??
      process.env.LYNX_AGENT_ID ??
      agentName;
    const sessionId =
      options.sessionId ??
      parentContext?.sessionId ??
      process.env.LYNX_SESSION_ID ??
      `session_${runId}`;

    const sampled = parentContext
      ? (parentContext.sampled ?? true)
      : this.config.sampleRate !== undefined
        ? Math.random() < this.config.sampleRate
        : true;

    const currentContext: LynxContext = {
      runId,
      agentName,
      spanId,
      parentSpanId,
      sampled,
      workspaceId,
      agentId,
      sessionId,
      eventCounts: parentContext?.eventCounts ?? {},
      attributes: { ...parentContext?.attributes },
    };

    this.captureInternal(
      "CONTEXT_ALERT",
      `run.start:${agentName}`,
      {
        message: `Agent execution thread started`,
        phase: "start",
        spanId,
        parentSpanId,
      },
      currentContext,
    );

    const startTime = Date.now();

    return LynxTracer.storage.run(currentContext, async () => {
      try {
        const result = await executionBlock();
        const latency = Date.now() - startTime;

        this.captureInternal(
          "CONTEXT_ALERT",
          `run.end:${agentName}`,
          {
            message: `Agent execution thread succeeded`,
            phase: "end",
            spanId,
            parentSpanId,
            latency,
          },
          currentContext,
        );

        return result;
      } catch (err: any) {
        const latency = Date.now() - startTime;
        this.captureInternal(
          "ERROR",
          `run.error:${agentName}`,
          {
            error: err.message,
            phase: "error",
            spanId,
            parentSpanId,
            latency,
          },
          currentContext,
        );
        throw err;
      } finally {
        if (this.getFlushOnRunEnd()) {
          await this.flushInternal(!this.isBackgroundOnly());
        }
        if (!this.isBackgroundOnly() && this.pendingPromises.size > 0) {
          await Promise.all(Array.from(this.pendingPromises));
        }
      }
    });
  }

  /**
   * Captures a custom context event for the active run.
   *
   * Prefer semantic helpers such as `userInput()`, `decision()`, `context()`,
   * `memory()`, and `outcome()` when the event has a clear meaning. Use `log()`
   * for compatibility or for ad-hoc diagnostic payloads.
   *
   * @param label Human-readable event label.
   * @param payload JSON-serializable diagnostic payload.
   */
  log(label: string, payload: any): void {
    const context = LynxTracer.storage.getStore();
    if (context) {
      this.captureInternal("CONTEXT_ALERT", label, payload, context);
    } else {
      console.warn(
        "[LynxTracer] Log was called outside a running context. Event ignored.",
      );
    }
  }

  /**
   * Captures the user input that started or influenced the current agent run.
   *
   * This event gives root-cause analysis a clear starting point and separates
   * user intent from prompts, tool results, and internal agent state.
   *
   * @param input Raw or structured user input.
   * @param metadata Optional metadata such as `userId`, `channel`, or `locale`.
   */
  userInput(input: any, metadata: Record<string, any> = {}): void {
    this.capture("USER_INPUT", "user.input", { input, ...metadata });
  }

  /**
   * Captures an agent decision and the reason behind it.
   *
   * Use this when the agent chooses a workflow, tool, policy branch, or final
   * action. The `options` object can include candidates, confidence scores, or
   * any domain-specific reasoning metadata.
   *
   * @param reason Short explanation of the selected action.
   * @param options Optional structured metadata about the decision.
   */
  decision(
    reasonOrDecision: string | LynxDecisionOptions,
    options: Record<string, any> = {},
  ): void {
    if (typeof reasonOrDecision === "string") {
      this.capture("AGENT_DECISION", "agent.decision", {
        reason: reasonOrDecision,
        ...options,
      });
      return;
    }

    this.capture("AGENT_DECISION", `agent.decision:${reasonOrDecision.name}`, {
      ...reasonOrDecision,
      ...reasonOrDecision.metadata,
    });
  }

  /**
   * Captures retrieved or constructed context used by the agent.
   *
   * Use this for RAG results, conversation summaries, selected documents,
   * request-scoped state, or any context that may have influenced the next LLM
   * or tool call.
   *
   * @param data Context data or a summary of the context.
   * @param metadata Optional metadata such as source, query, score, or label.
   */
  context(
    labelOrData: string | any,
    dataOrMetadata: any = {},
    metadata: Record<string, any> = {},
  ): void {
    if (typeof labelOrData === "string") {
      this.capture("CONTEXT_RETRIEVAL", labelOrData, {
        data: dataOrMetadata,
        ...metadata,
      });
      return;
    }

    this.capture(
      "CONTEXT_RETRIEVAL",
      dataOrMetadata.label ?? "context.retrieval",
      {
        data: labelOrData,
        ...dataOrMetadata,
      },
    );
  }

  /**
   * Adds attributes to the current run context.
   *
   * Attributes are attached to subsequent events captured in the same async
   * context. Use this for stable request or business identifiers such as
   * `orderId`, `tenantId`, or `workflowId`.
   *
   * @param attributes Key-value attributes to merge into the active context.
   */
  setAttributes(attributes: Record<string, any>): void {
    const context = LynxTracer.storage.getStore();
    if (!context) {
      console.warn("[LynxTracer] setAttributes called outside a run context.");
      return;
    }

    context.attributes = {
      ...context.attributes,
      ...attributes,
    };
  }

  /**
   * Captures access to short-term or long-term agent memory.
   *
   * This helps identify stale memory, missing memory, or memory values that
   * influenced an incorrect action.
   *
   * @param operation Memory operation name, such as `read`, `write`, or `search`.
   * @param data Memory key/value, query result, or a safe summary.
   * @param metadata Optional metadata such as hit/miss, store name, or freshness.
   */
  memory(
    operation: string,
    data: any,
    metadata: Record<string, any> = {},
  ): void {
    this.capture("MEMORY_ACCESS", `memory.${operation}`, {
      operation,
      data,
      ...metadata,
    });
  }

  /**
   * Captures the final technical and business outcome of the current session.
   *
   * Use this to distinguish "the code ran successfully" from "the business task
   * succeeded." That distinction is central for detecting AI failures that do
   * not throw runtime exceptions.
   *
   * @param options Outcome status, business status, reason, impact, and metadata.
   */
  outcome(options: LynxOutcomeOptions): void {
    this.capture("SESSION_OUTCOME", "session.outcome", options);
  }

  /**
   * Captures a human-readable annotation for the active run.
   *
   * `annotate()` is intended for breadcrumbs that help operators understand the
   * trace but do not fit one of the stricter semantic event helpers.
   *
   * @param label Annotation label.
   * @param payload JSON-serializable annotation payload.
   */
  annotate(label: string, payload: any): void {
    this.capture("CONTEXT_ALERT", label, { annotation: true, ...payload });
  }

  /**
   * Captures a semantic event for the active Lynx run context.
   */
  private capture(
    eventType: LynxEventDto["eventType"],
    label: string,
    payload: any,
  ): void {
    const context = LynxTracer.storage.getStore();
    if (!context) {
      console.warn(
        `[LynxTracer] Warning: event ${eventType} was captured outside a LynxTracer context!`,
      );
      return;
    }
    this.captureInternal(eventType, label, payload, context);
  }

  /**
   * Captures an event using an explicit Lynx context.
   *
   * This method is public for low-level instrumentation modules, but application
   * code should usually call the semantic helpers or `instrumentLLM()` /
   * `instrumentTool()` instead. Payloads are processed for PII masking,
   * capture-mode filtering, runtime metadata, and loop detection before they are
   * queued for delivery.
   *
   * @param eventType Lynx event type to record.
   * @param label Human-readable event label.
   * @param payload JSON-serializable event payload.
   * @param context Explicit Lynx trace context.
   */
  captureInternal(
    eventType: LynxEventDto["eventType"],
    label: string,
    payload: any,
    context: LynxContext,
  ): void {
    // Tail-based/adaptive sampling fallback keeps error-related events even
    // when the current context is sampled out, so failures remain debuggable.
    const isError =
      eventType === "ERROR" ||
      (payload && (payload.error || "error" in payload));
    if (context.sampled === false && !isError) {
      return;
    }

    const loopPayload = this.detectLoop(eventType, label, payload, context);
    const processedPayload = processPayload(
      {
        ...context.attributes,
        ...payload,
        ...loopPayload,
        sdkVersion: SDK_VERSION,
        droppedEventCount: this.droppedEventCount || undefined,
        appVersion: payload?.appVersion ?? this.config.appVersion,
        deploymentId: payload?.deploymentId ?? this.config.deploymentId,
        environment: payload?.environment ?? this.config.environment,
        policyVersion: payload?.policyVersion ?? this.config.policyVersion,
      },
      this.config,
    );

    const eventPayload = {
      ...processedPayload,
      spanId: processedPayload.spanId || context.spanId,
      parentSpanId: processedPayload.parentSpanId || context.parentSpanId,
    };

    const eventDto: LynxEventDto = {
      eventId: generateEventId(),
      clientId: this.config.clientId,
      runId: context.runId,
      agentName: context.agentName,
      eventType,
      label,
      payload: eventPayload,
      timestamp: Date.now(),
      workspaceId: context.workspaceId,
      agentId: context.agentId,
      sessionId: context.sessionId,
      schemaVersion: "1",
    };

    const queued = this.enqueueEvent(eventDto);
    if (!queued) {
      return;
    }

    if (loopPayload.loopDetected && eventType !== "LOOP_DETECTED") {
      this.captureInternal(
        "LOOP_DETECTED",
        `loop:${label}`,
        {
          repeatedLabel: label,
          loopCount: loopPayload.loopCount,
          argsHash: loopPayload.argsHash,
        },
        context,
      );
    }

    const maxBatchSize = this.config.delivery?.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!this.isBackgroundOnly() && this.eventQueue.length >= maxBatchSize) {
      void this.flushInternal(false);
    }
  }

  /**
   * Wraps an LLM client with automatic Lynx telemetry.
   *
   * The returned proxy preserves the original client shape while intercepting
   * supported generation methods such as OpenAI `chat.completions.create`,
   * Anthropic `messages.create`, Google `generateContent`, Vercel AI SDK
   * `generateText`, LangChain `invoke`, and similar methods. Captured telemetry
   * includes input/output, provider, model, generation config, latency, token
   * usage, span ids, and errors.
   *
   * @typeParam T LLM client object type.
   * @param instance LLM client instance to wrap.
   * @param optionsOrLabel Event label or custom extraction/interception rules.
   * @returns A proxy with the same public interface as `instance`.
   */
  instrumentLLM<T extends object>(
    instance: T,
    optionsOrLabel:
      | string
      | {
          modelLabel?: string;
          customRule?: Partial<LlmInstrumentationRule>;
        } = "llm.inference",
  ): T {
    return instrumentLLM(this, instance, optionsOrLabel);
  }

  /**
   * Wraps a tool function with automatic Lynx telemetry.
   *
   * The wrapped function emits `TOOL_CALL` before execution and `TOOL_RESULT`
   * after success. Errors are captured as `ERROR` and then rethrown. Use
   * `metadata` to describe side effects, risk level, external targets, or tool
   * version so debugging and governance views can reason about the call.
   *
   * @typeParam T Tool function type.
   * @param toolName Stable tool name shown in traces and analytics.
   * @param fn Tool function to execute.
   * @param metadata Optional tool metadata for governance and RCA.
   * @returns A wrapped function with the same call signature as `fn`.
   */
  instrumentTool<T extends (...args: any[]) => any>(
    toolName: string,
    fn: T,
    metadata: LynxToolMetadata = {},
  ): T {
    return instrumentTool(this, toolName, fn, metadata);
  }

  private getDefaultFailureMode(
    riskLevel: LynxToolMetadata["riskLevel"],
  ): NonNullable<LynxToolMetadata["failureMode"]> {
    if (riskLevel === "HIGH" || riskLevel === "CRITICAL") {
      return "FAIL_CLOSED";
    }
    if (riskLevel === "MEDIUM") {
      return "REQUIRE_APPROVAL";
    }
    return "FAIL_OPEN";
  }

  private normalizePolicyDecision(
    decision: LynxPolicyDecision,
  ): LynxPolicyDecision & { action: LynxPolicyAction; allow: boolean } {
    const action =
      decision.action ?? (decision.allow === false ? "BLOCK" : "ALLOW");
    const allow = action === "ALLOW" || action === "WARN";

    return {
      ...decision,
      action,
      allow,
    };
  }

  private decisionFromPolicyError(
    err: unknown,
    options: LynxToolMetadata,
  ): LynxPolicyDecision & { action: LynxPolicyAction; allow: boolean } {
    const failureMode =
      options.failureMode ?? this.getDefaultFailureMode(options.riskLevel);
    const reason =
      err instanceof Error ? err.message : "Policy evaluation failed";
    const action: LynxPolicyAction =
      failureMode === "FAIL_OPEN"
        ? "ALLOW"
        : failureMode === "REQUIRE_APPROVAL"
          ? "REQUIRE_APPROVAL"
          : "BLOCK";

    return {
      action,
      allow: action === "ALLOW",
      reason,
      severity: options.riskLevel,
      metadata: {
        policyError: true,
        failureMode,
      },
    };
  }

  /**
   * Wraps a tool with a local policy check before execution.
   *
   * `guardTool()` emits a `POLICY_EVALUATION` event before the tool runs. When
   * `beforeCall` returns `{ allow: false }`, Lynx also emits
   * `POLICY_VIOLATION` and `GUARDRAIL_ACTIVATED`, then throws before executing
   * the original tool. This provides the SDK-side hook needed for "observe first,
   * then prevent recurrence" workflows.
   *
   * @typeParam T Tool function type.
   * @param toolName Stable tool name shown in traces and policy events.
   * @param fn Tool function to guard.
   * @param options Tool metadata and an optional `beforeCall` policy callback.
   * @returns A guarded function with the same call signature as `fn`.
   */
  guardTool<T extends (...args: any[]) => any>(
    toolName: string,
    fn: T,
    options: LynxGuardToolOptions<Parameters<T>> = {},
  ): T {
    const guarded = (async (...args: Parameters<T>) => {
      const input = args[0];
      let decision: LynxPolicyDecision & {
        action: LynxPolicyAction;
        allow: boolean;
      };

      try {
        decision = this.normalizePolicyDecision(
          options.beforeCall
            ? await options.beforeCall({
                toolName,
                input,
                args,
                metadata: options,
              })
            : ({ action: "ALLOW" } satisfies LynxPolicyDecision),
        );
      } catch (err) {
        decision = this.decisionFromPolicyError(err, options);
      }

      this.capture("POLICY_EVALUATION", `policy:${toolName}`, {
        toolName,
        input,
        args,
        argsHash: stableHash(input),
        action: decision.action,
        allow: decision.allow,
        policyId: decision.policyId,
        policyVersion:
          decision.policyVersion ??
          options.policyVersion ??
          this.config.policyVersion,
        reason: decision.reason,
        severity: decision.severity,
        metadata: decision.metadata,
      });

      if (!decision.allow) {
        this.capture("POLICY_VIOLATION", `policy.violation:${toolName}`, {
          toolName,
          input,
          args,
          argsHash: stableHash(input),
          action: decision.action,
          policyId: decision.policyId,
          policyVersion:
            decision.policyVersion ??
            options.policyVersion ??
            this.config.policyVersion,
          reason: decision.reason,
          severity: decision.severity ?? options.riskLevel,
        });
        this.capture("GUARDRAIL_ACTIVATED", `guardrail.blocked:${toolName}`, {
          toolName,
          action: decision.action,
          reason: decision.reason,
          riskLevel: decision.severity ?? options.riskLevel,
        });
        throw new LynxPolicyError(
          decision.reason || `Lynx guard blocked tool call: ${toolName}`,
          decision.action === "REQUIRE_APPROVAL" ? "REQUIRE_APPROVAL" : "BLOCK",
          decision.policyId,
          decision.severity ?? options.riskLevel,
          decision.reason,
          decision.metadata,
        );
      }

      const instrumented = this.instrumentTool(toolName, fn, options);
      return instrumented(...args);
    }) as unknown as T;

    return guarded;
  }

  private detectLoop(
    eventType: LynxEventDto["eventType"],
    label: string,
    payload: any,
    context: LynxContext,
  ): Partial<LynxEventDto["payload"]> {
    if (
      eventType !== "TOOL_CALL" &&
      eventType !== "CALL_TOOLS" &&
      eventType !== "LLM_CALL"
    ) {
      return {};
    }

    const phase = payload?.phase;
    if (phase && phase !== "start") {
      return {};
    }

    const argsHash = stableHash(
      payload?.args ?? payload?.input ?? payload?.model ?? label,
    );
    const key = `${eventType}:${label}:${argsHash}`;
    context.eventCounts ??= {};
    const loopCount = (context.eventCounts[key] ?? 0) + 1;
    context.eventCounts[key] = loopCount;

    if (loopCount < 5) {
      return { argsHash };
    }

    return {
      argsHash,
      loopDetected: true,
      loopCount,
      repeatedLabel: label,
    };
  }
}
