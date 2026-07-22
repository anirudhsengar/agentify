---
name: test
description: Run the validation surface (test / lint / typecheck / e2e) for a change type and report a structured TestResult, without modifying code. Use to verify a change before review.
disable-model-invocation: true
tier: core

---
<!-- agentify:managed -->

# Test

Run the project's validation surface for a given change and report what passed and failed.
This is the **verify** primitive — it never modifies code. If a test fails, you report it;
`/fix` decides what to do.

## Workflow

1. Determine the change type (`chore` / `bug` / `feature`); default to `feature` if not
   given.
2. Run the **mandatory** validation commands for that change type (lifted from `AGENTS.md`'s
   validation surface). Run **optional** commands too if quick (< 60s).
3. Parse output for pass/fail per test (or per command if the suite doesn't break down).
4. Emit a `TestResult[]` as the last thing in your response:

   ```
   <output>
   [
     {"test_name": "...", "passed": true, "execution_command": "...", "test_purpose": "...", "error": null},
     {"test_name": "_summary", "passed": true}
   ]
   </output>
   ```

## Rules

- **Do not modify code.** Return failures; `/fix` handles them.
- No `--watch`, no `--update-snapshots`, no destructive flags.
- A command that times out (60s) is a failure with the timeout in `error`.
- Return a row per test that ran, plus a `_summary` row whose `passed` is true only if all
  others passed.
