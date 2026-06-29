# Changelog

All notable changes to `@lynxops/sdk` will be documented in this file.

## 1.0.2

- Added production-safe background delivery defaults.
- Added delivery timeout, queue overflow, retry, and circuit breaker controls.
- Added `flush()`, `shutdown()`, and `getStatus()` lifecycle APIs.
- Added semantic event helpers for user input, decisions, context, memory, and
  outcomes.
- Added local-first `guardTool()` policy evaluation.
- Added `full`, `metadata-only`, and `smart` capture modes.
- Added sensitive payload masking before delivery.
- Added OpenAI, Anthropic, Google, Vercel AI SDK, LangChain, Ollama, and Cohere
  instrumentation helpers.
