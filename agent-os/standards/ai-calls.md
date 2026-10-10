# AI calls

- Two roles, two models: decisions on the cheapest adequate model (`claude-haiku-4-5-20251001` today, Jev later) behind `DecisionModel`; writing on `claude-sonnet-5-5` behind `Writer`. Never call the SDK directly from `run/`.
- Decisions are closed-choice: the model picks from a fixed enum (`must_read | mention | skip`) via a tool / structured output, never free text that is parsed.
- The writer gets a cached system prompt (`cache_control: ephemeral`) placed first, then the day's items; output is validated against a schema before sending.
- Every call records model, input/output tokens, cache read tokens, latency and an estimated cost into the run record.
- Budgets: one writer call per run, at most one decision call per item, hard timeout per call; on failure the brief says which section is missing instead of failing the run.
- Hebrew output, dates in `D.M`, times `HH:MM`, no emojis unless the section template has them.
