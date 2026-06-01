# Claude Prompt Fixes — Preventing AI Inference Errors

## The core problem

LLMs infer. When your instruction has any ambiguity, the model fills gaps using training patterns.
For SQL scripts this is dangerous — a "helpful" inference can target the wrong database.

---

## Fix 1: Explicit no-inference constraint

**Bad prompt:**
> "Generate a script for the dev database"

**Fixed prompt:**
> "Generate a script for the dev database. Use exactly `medcare_db_dev` as the database name. Do not infer, rename, or substitute any other database name."

---

## Fix 2: Lock the USE statement

Always tell the agent what to put in `USE` — or tell it to omit it.

**Option A — lock it:**
> "The script must start with `USE [medcare_db_dev];` — no other database name is acceptable."

**Option B — omit it (safer for review):**
> "Do not include a USE statement. Add a comment `-- Target: medcare_db_dev` at the top instead."

---

## Fix 3: Add environment context block to every SQL prompt

Paste this block at the start of any SQL generation request:

```
ENVIRONMENT CONTEXT — follow exactly, no inference allowed:
- Target environment: DEV
- Target database: medcare_db_dev
- Target server: [dev server name]
- DO NOT use medcare_db (production) under any circumstance
```

---

## Fix 4: Instruct the agent to confirm before generating

> "Before writing the script, state which database and server you are targeting. Wait for my confirmation."

Forces the agent to surface its assumptions before acting on them.

---

## Fix 5: Add a review checklist to the prompt

> "After generating the script, list:
> 1. Database targeted (USE statement)
> 2. Any table DROP or TRUNCATE operations
> 3. Any data DELETE or UPDATE without WHERE clause
> Mark each as DEV-SAFE or REVIEW-REQUIRED."

---

## Fix 6: Never mention prod details in a dev-focused prompt

If your prompt says "unlike production `medcare_db`..." the agent now knows the prod name and may use it.
Keep prod references out of dev prompts entirely.

---

## Fix 7: CLAUDE.md environment boundary table

Every project repo must have this in `CLAUDE.md`:

```markdown
## Environment boundaries — READ BEFORE GENERATING ANY SQL

| Environment | Server | Database |
|---|---|---|
| PRODUCTION | `HCMPSDB01\HCMPS` | `medcare_db` |
| DEV | (ask developer) | `medcare_db_dev` |

Never generate SQL with USE [medcare_db] unless explicitly told target is production.
When asked for dev scripts, always use USE [medcare_db_dev].
When in doubt, omit USE and add comment: -- Target: medcare_db_dev
```

---

## Fix 8: Post-generation verification prompt

After receiving a generated script, run a second prompt:

> "Review the script you just generated. Confirm:
> - Does it target `medcare_db_dev` and NOT `medcare_db`?
> - Are there any destructive operations (DROP, TRUNCATE, DELETE without WHERE)?
> - Is it safe to run on dev?"

---

## Quick reference — prompt template for SQL scripts

```
TARGET: medcare_db_dev (DEV environment only)
SERVER: [dev server]
RULE: Use exactly the database name above. No inference. No substitution.

Task: [your actual request here]

Output requirements:
- Start with USE [medcare_db_dev];
- Flag any destructive operations with -- REVIEW: before that line
- Do not reference or target medcare_db (production) in any part of the script
```

---

## Summary table

| Risk | Fix |
|---|---|
| Agent infers prod DB from `_dev` suffix | Fix 1 + Fix 3 — explicit name lock |
| Agent uses wrong `USE` statement | Fix 2 — lock or omit `USE` |
| Agent has no environment context | Fix 7 — CLAUDE.md boundary table |
| Assumptions go unverified | Fix 4 — force confirmation before generating |
| Destructive ops go unnoticed | Fix 5 + Fix 8 — post-generation checklist |
| Prod name leaks into dev prompt | Fix 6 — keep prod details out of dev prompts |
