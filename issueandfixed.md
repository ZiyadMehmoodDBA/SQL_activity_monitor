# Issue and Fix — AI Agent DB Targeting Incident

---

## Incident trigger

User asked: *"How is this happening, you have shared my DB credentials to my colleague"*

---

## What actually happened

Colleague used a separate Claude agent and asked it to generate a database script for the **dev** database.
Agent generated the script using `USE [medcare_db]` — the **production** database — instead of `USE [medcare_db_dev]`.
Script was reviewed before execution. Nothing was executed. No data was modified. Near-miss only.

---

## Initial concern: data leak / credential sharing

User suspected:
- Claude (this session) read network traffic and leaked prod DB name to colleague
- Credentials were shared between accounts on the same network
- "Ultrathink" (extended reasoning mode) caused extra data access

**All three are false.**

---

## What Claude cannot do

- Read network packets or intercept traffic on any network
- See other users' conversations or sessions
- Communicate between separate accounts
- Access anything not explicitly provided in the current chat window
- Share data between isolated sessions

Each Claude conversation is a sealed sandbox on Anthropic's servers.
My session with the user and the colleague's session are completely isolated — zero awareness of each other.

---

## Why the prod DB name appeared without anything being shared

The colleague's agent inferred `medcare_db` by stripping the `_dev` suffix from `medcare_db_dev`.

This is standard naming convention pattern deeply embedded in LLM training data:
- Agent saw `medcare_db_dev`
- Recognised `_dev` as a dev environment suffix
- Inferred `medcare_db` as the production counterpart
- Generated `USE [medcare_db]` — the "corrected" production target

No credentials, no repo access, no network read required. Pure pattern inference.

---

## Root cause: LLM inference over literal instruction

LLMs do not execute instructions like code. They predict the most likely response based on training patterns.

When told *"write script for dev db `medcare_db_dev`"*:
- Training data contains many prod/dev naming convention examples
- Model "helpfully" assumed `medcare_db` was the real intended target
- Deviated from the literal instruction in favour of its trained pattern

**This is a known LLM failure mode: inference over literal instruction.**

---

## What "ultrathink" / extended thinking actually is

User repeatedly referenced "ultrathink" — this refers to Claude's extended thinking / high reasoning mode (set via "reasoning effort: high" in the session).

Extended thinking means the model spends more internal computation steps before responding.
It does NOT:
- Access external systems
- Read more data than provided in the prompt
- Cause more deviation from instructions

More reasoning = more deliberate output. Same data boundary. Not a factor in this incident.

---

## Environment boundary added to CLAUDE.md

To prevent any future agent (in this repo) from targeting prod by inference:

| Environment | Server | Database |
|---|---|---|
| PRODUCTION | `HCMPSDB01\HCMPS` | `medcare_db` |
| DEV | *(from `.env` — ask developer)* | `medcare_db_dev` |

Rule added: *Never generate SQL with `USE [medcare_db]` unless explicitly told target is production. When asked for dev scripts, always use `USE [medcare_db_dev]`.*

---

## Fixes — preventing recurrence

### Fix 1: Explicit no-inference constraint in prompt

**Bad:**
> "Generate a script for the dev database"

**Fixed:**
> "Generate a script for the dev database. Use exactly `medcare_db_dev`. Do not infer, rename, or substitute any other database name."

---

### Fix 2: Lock or omit the USE statement

**Lock it:**
> "The script must start with `USE [medcare_db_dev];` — no other database name is acceptable."

**Omit it (safer for review):**
> "Do not include a USE statement. Add a comment `-- Target: medcare_db_dev` at the top instead."

---

### Fix 3: Environment context block at top of every SQL prompt

```
ENVIRONMENT CONTEXT — follow exactly, no inference allowed:
- Target environment: DEV
- Target database: medcare_db_dev
- Target server: [dev server name]
- DO NOT use medcare_db (production) under any circumstance
```

---

### Fix 4: Force agent to confirm before generating

> "Before writing the script, state which database and server you are targeting. Wait for my confirmation."

Forces assumptions to surface before the agent acts on them.

---

### Fix 5: Post-generation verification prompt

After receiving the script:
> "Review the script you just generated. Confirm:
> - Does it target `medcare_db_dev` and NOT `medcare_db`?
> - Are there any destructive operations (DROP, TRUNCATE, DELETE without WHERE)?
> - Is it safe to run on dev?"

---

### Fix 6: Keep prod details out of dev prompts

If your prompt mentions "unlike production `medcare_db`..." the agent now knows the prod name and may use it.
Keep prod references out of dev-focused prompts entirely.

---

### Fix 7: CLAUDE.md environment boundary table in every project repo

```markdown
## Environment boundaries — READ BEFORE GENERATING ANY SQL

| Environment | Server | Database |
|---|---|---|
| PRODUCTION | `HCMPSDB01\HCMPS` | `medcare_db` |
| DEV | (ask developer) | `medcare_db_dev` |

Never generate SQL with USE [medcare_db] unless explicitly told target is production.
When in doubt, omit USE and add comment: -- Target: medcare_db_dev
```

---

### Fix 8: Never give an agent access to a repo or .env containing production credentials

Even "private local projects" — if an agent can read your `.env`, it can read your prod connection string.
Use a separate `.env.dev` pointing at dev server only when working with agents.

---

## Copy-paste safe prompt template for SQL generation

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

## Summary

| Factor | Detail |
|---|---|
| Incident type | AI agent inference error — not a security breach |
| Data modified | None — script reviewed before execution |
| Credentials leaked | No |
| Cross-session data sharing | No — impossible by design |
| Cause | LLM inferred prod DB name from `_dev` suffix naming pattern |
| Prevention | Explicit name lock in prompt + mandatory USE statement review + CLAUDE.md boundary table |
