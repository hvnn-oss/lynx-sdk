import { createHash } from "crypto";
import { LynxConfig } from "../core/types.js";
import patternsConfig from "../config/patterns.json" with { type: "json" };

const RISK_PATTERNS = patternsConfig.riskPatterns.map(
  (item) => new RegExp(item.pattern, item.flags),
);

function getHash(data: any): string {
  const str = typeof data === "string" ? data : JSON.stringify(data);
  return createHash("sha256")
    .update(str || "")
    .digest("hex")
    .slice(0, 16);
}

function extractRiskFlags(text: string): string[] {
  const flags: string[] = [];
  for (const pattern of RISK_PATTERNS) {
    if (pattern.test(text)) {
      const cleanPattern = pattern.source.replace(/\\/g, "");
      flags.push(cleanPattern);
    }
  }
  return flags;
}

function headTailTruncate(text: string, maxLen: number = 1000): string {
  if (text.length <= maxLen) return text;
  const reserve = 80; // space for indicator
  const half = Math.floor((maxLen - reserve) / 2);
  if (half <= 0) return "... [TRUNCATED] ...";
  const head = text.substring(0, half);
  const tail = text.substring(text.length - half);
  const truncatedCount = text.length - (head.length + tail.length);
  return `${head}... [TRUNCATED ${truncatedCount} CHARS] ...${tail}`;
}

const PII_RULES = patternsConfig.piiRules.map((rule) => ({
  name: rule.name,
  regex: new RegExp(rule.pattern, rule.flags),
  replacement: rule.replacement,
}));

const SENSITIVE_KEY_PATTERN =
  /(?:api[-_]?key|authorization|auth[-_]?token|bearer|client[-_]?secret|cookie|credential|jwt|password|private[-_]?key|refresh[-_]?token|secret|session[-_]?token|token)/i;

export function maskPIIString(text: string): string {
  let masked = text;
  for (const rule of PII_RULES) {
    masked = masked.replace(rule.regex, rule.replacement);
  }
  return masked;
}

export function recursiveMaskPII(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    return maskPIIString(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => recursiveMaskPII(item));
  }
  if (typeof obj === "object") {
    const res: any = {};
    for (const key of Object.keys(obj)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        res[key] = "[MASKED_SECRET]";
      } else {
        res[key] = recursiveMaskPII(obj[key]);
      }
    }
    return res;
  }
  return obj;
}

export function processPayload(payload: any, config: LynxConfig): any {
  if (!payload || typeof payload !== "object") return payload;

  let copy: any;
  try {
    copy = JSON.parse(JSON.stringify(payload));
  } catch {
    return { error: "[Unserializable Payload]" };
  }

  // Apply PII masking to the copied payload before other operations
  copy = recursiveMaskPII(copy);

  if (config.captureInput === false && "input" in copy) {
    delete copy.input;
  }
  if (config.captureOutput === false && "output" in copy) {
    delete copy.output;
  }

  const mode = config.captureMode || "smart";

  let textToAnalyze = "";
  if (copy.input) {
    textToAnalyze +=
      typeof copy.input === "string" ? copy.input : JSON.stringify(copy.input);
  }
  if (copy.output) {
    textToAnalyze +=
      typeof copy.output === "string"
        ? copy.output
        : JSON.stringify(copy.output);
  }

  const riskFlags = textToAnalyze ? extractRiskFlags(textToAnalyze) : [];
  if (riskFlags.length > 0) {
    copy.riskFlags = riskFlags;
  }

  if (mode === "metadata-only") {
    if ("input" in copy) {
      const inputStr =
        typeof copy.input === "string"
          ? copy.input
          : JSON.stringify(copy.input);
      copy.promptHash = getHash(copy.input);
      copy.promptLength = inputStr.length;
      delete copy.input;
    }
    if ("output" in copy) {
      const outputStr =
        typeof copy.output === "string"
          ? copy.output
          : JSON.stringify(copy.output);
      copy.responseHash = getHash(copy.output);
      copy.responseLength = outputStr.length;
      delete copy.output;
    }
    return copy;
  }

  if (mode === "smart") {
    const maxLen = config.maxPayloadLength ?? 1000;

    const walkAndSmartTruncate = (obj: any): any => {
      if (!obj || typeof obj !== "object") return obj;

      if (Array.isArray(obj)) {
        return obj.map((item) => walkAndSmartTruncate(item));
      }

      const res: any = {};
      for (const key of Object.keys(obj)) {
        const priorityKeys = [
          "spanid",
          "parentspanid",
          "latency",
          "usage",
          "cost",
          "error",
          "path",
          "riskflags",
        ];
        if (priorityKeys.includes(key.toLowerCase())) {
          res[key] = obj[key];
        } else if (typeof obj[key] === "object") {
          res[key] = walkAndSmartTruncate(obj[key]);
        } else if (typeof obj[key] === "string") {
          res[key] = headTailTruncate(obj[key], maxLen);
        } else {
          res[key] = obj[key];
        }
      }
      return res;
    };

    return walkAndSmartTruncate(copy);
  }

  return copy;
}
