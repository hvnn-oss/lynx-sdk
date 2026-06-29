import { LlmInstrumentationRule, LynxContext, LynxToolMetadata } from "../core/types.js";
import { generateSpanId } from "../utils/id.js";
import { extractTokenUsage } from "../utils/usage.js";
import { LynxTracer } from "../core/tracer.js";

function stableHash(data: any): string {
  const str = typeof data === "string" ? data : JSON.stringify(data ?? "");
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function getProvider(path: string[], model?: string): string {
  const pathStr = path.join(".");
  if (pathStr.includes("messages.create")) return "anthropic";
  if (pathStr.includes("generateContent")) return "google";
  if (pathStr.includes("generateText") || pathStr.includes("streamText")) return "vercel-ai";
  if (pathStr.includes("ollama")) return "ollama";
  if (pathStr.includes("cohere")) return "cohere";
  if (model?.toLowerCase().includes("claude")) return "anthropic";
  if (model?.toLowerCase().includes("gemini")) return "google";
  return "openai";
}

function getMessages(input: any): any[] | undefined {
  if (Array.isArray(input?.messages)) return input.messages;
  if (Array.isArray(input?.contents)) return input.contents;
  if (Array.isArray(input?.prompt)) return input.prompt;
  return undefined;
}

function getTextLength(data: any): number {
  if (data === undefined || data === null) return 0;
  if (typeof data === "string") return data.length;
  try {
    return JSON.stringify(data).length;
  } catch {
    return 0;
  }
}

function extractLlmMetadata(input: any, path: string[]) {
  const messages = getMessages(input);
  const systemMessage = messages?.find((item) => item?.role === "system");
  const userMessage = [...(messages ?? [])].reverse().find((item) => item?.role === "user");
  const model = input?.model ?? input?.modelName;
  const maxTokens = input?.max_tokens ?? input?.maxTokens ?? input?.maxOutputTokens;

  return {
    provider: getProvider(path, model),
    model,
    temperature: input?.temperature,
    topP: input?.top_p ?? input?.topP,
    maxTokens,
    seed: input?.seed,
    promptVersion: input?.promptVersion,
    systemPromptHash: systemMessage ? stableHash(systemMessage) : undefined,
    userPromptHash: userMessage ? stableHash(userMessage) : undefined,
    messageCount: messages?.length,
    contextLength: getTextLength(input),
  };
}

function summarizeResult(result: any): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result.slice(0, 240);
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  try {
    return JSON.stringify(result).slice(0, 240);
  } catch {
    return "[Unserializable Result]";
  }
}

/**
 * Wraps an LLM client object with Lynx telemetry instrumentation.
 *
 * This low-level helper is used by `LynxTracer.instrumentLLM()`. It returns a
 * recursive proxy that preserves the original client API and intercepts known
 * generation methods. Each intercepted call emits start/end `LLM_CALL` events,
 * token usage when available, model configuration metadata, latency, span ids,
 * and errors.
 *
 * Most application code should call `lynx.instrumentLLM(client, options)`
 * instead of importing this helper directly.
 *
 * @typeParam T LLM client object type.
 * @param tracer Tracer that receives captured telemetry.
 * @param instance LLM client instance to wrap.
 * @param optionsOrLabel Event label or custom extraction/interception rules.
 * @returns A proxy with the same public shape as `instance`.
 */
export function instrumentLLM<T extends object>(
  tracer: LynxTracer,
  instance: T,
  optionsOrLabel: string | {
    modelLabel?: string;
    customRule?: Partial<LlmInstrumentationRule>;
  } = "llm.inference"
): T {
  const options = typeof optionsOrLabel === "string"
    ? { modelLabel: optionsOrLabel }
    : optionsOrLabel;

  const modelLabel = options.modelLabel ?? "llm.inference";
  const customRule = options.customRule;

  const isTargetLLMMethod = (path: string[]): boolean => {
    if (customRule?.isTargetMethod) {
      return customRule.isTargetMethod(path);
    }

    const pathStr = path.join(".");
    return (
      pathStr === "chat.completions.create" || // OpenAI
      pathStr === "responses.create" ||        // OpenAI Responses API
      pathStr === "messages.create" ||         // Anthropic (Claude)
      pathStr === "models.generateContent" ||  // Google Gen AI 신규
      pathStr === "generateContent" ||         // Google Generative AI 기존
      pathStr === "generateText" ||            // Vercel AI SDK
      pathStr === "streamText" ||             // Vercel AI SDK
      pathStr === "generateObject" ||          // Vercel AI SDK
      pathStr === "streamObject" ||            // Vercel AI SDK
      pathStr === "ollama.chat" ||             // Ollama Chat
      pathStr === "ollama.generate" ||         // Ollama Generate
      pathStr === "cohere.chat" ||             // Cohere Chat
      pathStr === "cohere.generate" ||         // Cohere Generate
      pathStr === "chat" ||                    // Ollama/Cohere direct
      pathStr === "invoke" ||                  // LangChain
      pathStr === "predict"                    // LangChain
    );
  };

  const createRecursiveProxy = (target: any, path: string[] = []): any => {
    if (target == null || (typeof target !== "object" && typeof target !== "function")) {
      return target;
    }

    return new Proxy(target, {
      get(obj, prop) {
        if (typeof prop === "symbol") {
          return Reflect.get(obj, prop);
        }

        const val = obj[prop];
        const newPath = [...path, prop];

        if (typeof val === "function" && isTargetLLMMethod(newPath)) {
          return async function (this: any, ...args: any[]) {
            const context = LynxTracer.getStore();
            const spanId = generateSpanId();
            const parentSpanId = context?.spanId;
            const startTime = Date.now();

            const rawInput = customRule?.extractInput
              ? customRule.extractInput(args)
              : args[0];
            const llmMetadata = extractLlmMetadata(rawInput, newPath);

            if (context) {
              tracer.captureInternal("LLM_CALL", modelLabel, {
                input: rawInput,
                path: newPath.join("."),
                phase: "start",
                spanId,
                parentSpanId,
                ...llmMetadata
              }, context);
            }

            try {
              const result = Reflect.apply(val, obj, args);
              const resolvedResult = result instanceof Promise ? await result : result;
              const latency = Date.now() - startTime;
              
              const rawOutput = customRule?.extractOutput
                ? customRule.extractOutput(resolvedResult)
                : resolvedResult;

              const usage = customRule?.extractUsage
                ? customRule.extractUsage(resolvedResult)
                : extractTokenUsage(resolvedResult);

              if (context) {
                tracer.captureInternal("LLM_CALL", modelLabel, {
                  output: rawOutput,
                  phase: "end",
                  spanId,
                  parentSpanId,
                  latency,
                  usage,
                  ...llmMetadata
                }, context);
              }
              return resolvedResult;
            } catch (err: unknown) {
              const error = err as Error;
              const latency = Date.now() - startTime;
              if (context) {
                tracer.captureInternal("ERROR", modelLabel, {
                  error: error.message,
                  phase: "error",
                  spanId,
                  parentSpanId,
                  latency
                }, context);
              }
              throw err;
            }
          };
        }

        if (val && (typeof val === "object" || typeof val === "function")) {
          return createRecursiveProxy(val, newPath);
        }

        return val;
      },
    });
  };

  return createRecursiveProxy(instance);
}

/**
 * Wraps a tool function with Lynx telemetry instrumentation.
 *
 * This low-level helper is used by `LynxTracer.instrumentTool()`. The wrapped
 * function emits `TOOL_CALL` before execution and `TOOL_RESULT` after success.
 * If the tool throws, an `ERROR` event is captured and the original error is
 * rethrown.
 *
 * Most application code should call `lynx.instrumentTool(name, fn, metadata)`
 * instead of importing this helper directly.
 *
 * @typeParam T Tool function type.
 * @param tracer Tracer that receives captured telemetry.
 * @param toolName Stable tool name shown in traces and analytics.
 * @param fn Tool function to execute.
 * @param metadata Optional tool metadata such as risk level or side effects.
 * @returns A wrapped function with the same call signature as `fn`.
 */
export function instrumentTool<T extends (...args: any[]) => any>(
  tracer: LynxTracer,
  toolName: string,
  fn: T,
  metadata: LynxToolMetadata = {},
): T {
  return (async (...args: any[]) => {
    const context = LynxTracer.getStore();
    const spanId = generateSpanId();
    const parentSpanId = context?.spanId;
    const startTime = Date.now();

    if (context) {
      tracer.captureInternal("TOOL_CALL", toolName, {
        toolName,
        toolVersion: metadata.toolVersion,
        sideEffect: metadata.sideEffect,
        riskLevel: metadata.riskLevel,
        externalTarget: metadata.externalTarget,
        idempotencyKey: metadata.idempotencyKey,
        args: args[0],
        argsHash: stableHash(args[0]),
        input: args[0],
        phase: "start",
        spanId,
        parentSpanId
      }, context);
    }

    try {
      const result = fn(...args);
      const resolvedResult = result instanceof Promise ? await result : result;
      const latency = Date.now() - startTime;
      
      if (context) {
        tracer.captureInternal("TOOL_RESULT", toolName, {
          toolName,
          toolVersion: metadata.toolVersion,
          result: resolvedResult,
          resultSummary: summarizeResult(resolvedResult),
          output: resolvedResult,
          phase: "end",
          spanId,
          parentSpanId,
          latency
        }, context);
      }
      return resolvedResult;
    } catch (err: unknown) {
      const error = err as Error;
      const latency = Date.now() - startTime;
      if (context) {
        tracer.captureInternal("ERROR", toolName, {
          error: error.message,
          phase: "error",
          spanId,
          parentSpanId,
          latency
        }, context);
      }
      throw err;
    }
  }) as unknown as T;
}
