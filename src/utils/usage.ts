import { TokenUsage } from "../core/types.js";

export function estimateLlmCost(model: string, promptTokens: number, completionTokens: number): number {
  const modelLower = model.toLowerCase();
  let inputRate = 1.0;  // 1M tokens input rate
  let outputRate = 2.0; // 1M tokens output rate

  if (modelLower.includes("gpt-4o")) {
    inputRate = 2.50;
    outputRate = 10.00;
  } else if (modelLower.includes("gpt-4")) {
    inputRate = 30.00;
    outputRate = 60.00;
  } else if (modelLower.includes("gpt-3.5")) {
    inputRate = 0.50;
    outputRate = 1.50;
  } else if (modelLower.includes("claude-3-5-sonnet") || modelLower.includes("sonnet")) {
    inputRate = 3.00;
    outputRate = 15.00;
  } else if (modelLower.includes("claude-3-opus") || modelLower.includes("opus")) {
    inputRate = 15.00;
    outputRate = 75.00;
  } else if (modelLower.includes("gemini")) {
    inputRate = 0.075;
    outputRate = 0.30;
  }

  return (promptTokens * inputRate + completionTokens * outputRate) / 1_000_000;
}

export function extractTokenUsage(result: any): TokenUsage | undefined {
  if (!result || typeof result !== "object") return undefined;

  const usage = result.usage ?? result.llmOutput?.tokenUsage ?? result.generationInfo?.tokenUsage ?? result.response_metadata?.tokenUsage ?? result.response_metadata?.usage;
  if (usage) {
    const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.inputTokens ?? 0;
    const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.outputTokens ?? 0;
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    };
  }

  const usageMetadata = result.usageMetadata;
  if (usageMetadata) {
    const promptTokens = usageMetadata.promptTokenCount ?? 0;
    const completionTokens = usageMetadata.candidatesTokenCount ?? usageMetadata.completionTokenCount ?? 0;
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    };
  }

  return undefined;
}
