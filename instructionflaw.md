# AI Agent Instruction Flaw — Incident Notes

## What happened

Colleague asked a Claude agent to generate a database script for the **dev** database (`medcare_db_dev`).
Agent generated the script targeting **production** (`USE [medcare_db]`).
Script was reviewed before execution — no data was modified. Near-miss only.

---

## Root cause

LLMs do not execute instructions like code. They predict the most likely response based on training patterns.

When told "write script for dev db `medcare_db_dev`":
- Model saw `_dev` suffix
- Training data contains many prod/dev naming convention examples
- Model "helpfully" inferred that `medcare_db` (without `_dev`) was the intended prod target
- Generated `USE [medcare_db]` instead of `USE [medcare_db_dev]`

**This is a known LLM failure mode: inference over literal instruction.**
Models deviate from exact input when their training pattern suggests a "correction".

---

## What did NOT happen

| Concern | Verdict |
|---|---|
| Claude read network traffic | No — Claude has no network access |
| Credentials leaked between accounts | No — each Claude session is a sealed sandbox |
| Cross-account session data sharing | No — impossible by design |
| "Ultrathink" / extended reasoning caused the issue | No — reasoning mode only affects internal computation depth, not data access |

Claude (Anthropic) cannot:
- Read network packets or intercept traffic
- See other users' conversations
- Communicate between separate accounts or sessions
- Access anything not explicitly provided in the current chat window

---

## Why the prod DB name appeared without being shared

The colleague's agent inferred `medcare_db` by stripping the `_dev` suffix from `medcare_db_dev` — a standard naming convention pattern baked into LLM training data. No credentials, no repo access, no network read was needed. Pure pattern inference.

---

## Environment boundary table (add to CLAUDE.md in every project)

| Environment | Server | Database |
|---|---|---|
| PRODUCTION | `HCMPSDB01\HCMPS` | `medcare_db` |
| DEV | *(from `.env` — ask developer)* | `medcare_db_dev` |

---

## Rules for prompting AI agents on SQL scripts

1. **State the exact database name explicitly:**
   > "Use exactly `medcare_db_dev`. Do not infer or change the database name."

2. **Always review the `USE [db_name]` statement** before running any AI-generated SQL.

3. **Never give an agent access to a repo or `.env` containing production credentials.**

4. **If in doubt, ask the agent to omit `USE` and add a comment instead:**
   > `-- execute against: medcare_db_dev`

5. **Treat AI-generated SQL as untrusted input** — review it the same way you would review code from a junior developer before touching any production instance.

---

## Extended thinking / "ultrathink" clarification

Claude's high reasoning / extended thinking mode means the model spends more internal computation steps before responding. It does NOT:
- Access external systems
- Read more data than provided
- Cause more deviation from instructions

More reasoning = more deliberate output, same data boundary.

---

## Summary

| Factor | Detail |
|---|---|
| Incident type | AI agent inference error (not a security breach) |
| Data modified | None — script reviewed before execution |
| Cause | LLM inferred prod DB name from `_dev` naming pattern |
| Prevention | Explicit constraints in prompt + mandatory `USE` statement review |
