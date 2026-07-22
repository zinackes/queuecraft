# @queuecraft/core

The pivot model and the `Adapter` contract. Types only — this package has **zero runtime
dependencies** and never imports any queue technology.

- `model.ts` — `QueueSnapshot`, `QueueEvent`, `FailedJobDetail`, `QueueActions`
- `adapter.ts` — the `Adapter` interface every queue tech implements (~6 methods)

⚠️ Interface frozen only after two implementations exist (pg-boss, then BullMQ) — see ADR D6.
