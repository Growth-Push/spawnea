# Antigravity / Gemini CLI Hook Integration

This document details how Google Antigravity / Gemini CLI connects with Spawnea's status tracking engine.

The canonical Spawnea harness identifier is `antigravity`. The provider command
may remain `agy` where that is the installed CLI command; `agy` is accepted only
as a compatibility alias at the adapter registry boundary.

---

## 1. Capabilities & Lifecycle

* **Turn Completion:** Transitions status $\longrightarrow$ `idle` (Confidence: 0.98, Source: `native_hook`).
* **Interactive Questionnaire:** Detected via prompt heuristic pattern matchers (`? Which approach...`, `› 1. Recommended...`) $\longrightarrow$ `waiting_input`.
* **Execution Verbs:** Progress messages (`Planning...`, `Analyzing codebase...`) $\longrightarrow$ `working`.
