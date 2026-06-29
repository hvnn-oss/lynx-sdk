import { randomBytes, randomUUID } from "crypto";

/**
 * W3C Trace Context 규격에 부합하는 TraceID(32자 Hex)를 생성합니다.
 */
export function generateTraceId(): string {
  try {
    return randomBytes(16).toString("hex");
  } catch {
    return randomUUID().replace(/-/g, "").slice(0, 32);
  }
}

/**
 * W3C Trace Context 규격에 부합하는 SpanID(16자 Hex)를 생성합니다.
 */
export function generateSpanId(): string {
  try {
    return randomBytes(8).toString("hex");
  } catch {
    return randomUUID().replace(/-/g, "").slice(0, 16);
  }
}

/**
 * Creates a stable per-event identifier used by the backend for idempotency.
 */
export function generateEventId(): string {
  try {
    return randomBytes(16).toString("hex");
  } catch {
    return randomUUID().replace(/-/g, "").slice(0, 32);
  }
}
