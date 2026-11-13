# Configuration

Charter needs no configuration. With no file present it runs an implementer and an auditor on your session's model, with no project checks and no refiner.

## Where the configuration lives

| File | Scope |
| --- | --- |
| `~/.pi/agent/charter.json` | All your projects. |
| `<project>/.pi/charter.json` | One project. Read only when Pi trusts the project. |

Settings are layered: built-in defaults, then the user file, then the project file. A layer overrides only the fields it names, with one exception: `checks` is replaced as a whole. The project root is the directory Pi was started in.

`/charter setup` writes the project file interactively. `/charter doctor` shows which files are in effect and verifies them.

For editor completion, point `$schema` at the schema shipped with the package:

```json
{ "$schema": "./node_modules/pi-charter/schemas/charter.schema.json", "version": 1 }
```

## Complete example

Every field with its default value:

```json
{
  "version": 1,
  "directory": ".charter",
  "roles": {
    "implementer": { "enabled": true, "model": null, "thinking": "high", "timeoutMinutes": 60 },
    "auditor": { "enabled": true, "model": null, "thinking": "medium", "timeoutMinutes": 30, "shards": 1 },
    "refiner": { "enabled": false, "model": null, "thinking": "medium", "timeoutMinutes": 30 }
  },
  "checks": [],
  "limits": { "cycles": 3, "gateRetries": 2, "reportNudges": 1 },
  "git": { "checkpoints": true }
}
```

## Fields

| Field | Default | Rules |
| --- | --- | --- |
| `version` | none | Required in every file. Must be `1`. |
| `directory` | `.charter` | Relative path below the project root. Not the root itself, not inside `.git`, not outside the project. |
| `roles.<role>.enabled` | see above | Whether the phase runs. Disabling the implementer disables everything after approval (specification-only mode). |
| `roles.<role>.model` | `null` | `provider/model-id` exactly as Pi lists it (further slashes in the id are fine), or `null` / `"inherit"` to use the model of the main session. |
| `roles.<role>.thinking` | `high` / `medium` / `medium` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Pi clamps it to what the model supports. |
| `roles.<role>.timeoutMinutes` | `60` / `30` / `30` | 0 to 1440. Wall-clock limit of one run; `0` means no limit. |
| `roles.auditor.shards` | `1` | 1 to 8. Upper bound of auditors working in parallel on disjoint criteria. Never more shards than criteria. |
| `checks[].name` | none | 1 to 40 characters: letters, digits, space, `_ . : -`. Unique. |
| `checks[].run` | none | Shell command, run from the project root. Exit code 0 means pass. |
| `checks[].timeoutSeconds` | `600` | 1 to 21600. |
| `limits.cycles` | `3` | 1 to 50. Implementation cycles per approval before you must grant more. |
| `limits.gateRetries` | `2` | 0 to 10. Automatic implementer repairs after failing checks, per cycle. `0` escalates the first failure to you. |
| `limits.reportNudges` | `1` | 0 to 5. Reminders for an agent that stopped without reporting. |
| `git.checkpoints` | `true` | Snapshot the work tree before each run. See below. |

Unknown fields are errors, and every problem in a file is reported at once with its path, for example `roles.auditor.shards: must be a whole number between 1 and 8`. While the configuration is invalid, Charter mode does not turn on.

## Choosing models

- Use your strongest coding model for the implementer.
- Give the auditor a model from a **different family** when you can. Two models with the same training tend to share blind spots; a second family is a more independent check.
- The refiner does well with a mid-tier model: the task is narrow and guarded by your checks.
- Small models with low thinking levels tend to struggle with multi-step protocols. If an agent repeatedly ends without reporting, raise its model or thinking level before anything else.

`/charter` refuses to turn on when a configured model is not available in Pi, and names it. Authenticate the provider in Pi (`pi auth`) or fix the id.

## Project checks

Checks are the cheapest and most reliable verification you have: they cost no tokens and cannot be argued with. Configure every command a reviewer would run before merging.

```json
"checks": [
  { "name": "typecheck", "run": "npm run typecheck" },
  { "name": "lint", "run": "npm run lint" },
  { "name": "test", "run": "npm test", "timeoutSeconds": 900 }
]
```

`/charter setup` detects common ones: `typecheck`, `lint` and `test` scripts in `package.json` (using npm, pnpm, yarn or bun according to the lockfile), `cargo check` and `cargo test`, `go vet` and `go test`, and `pytest`.

Checks run:

- after every implementer report, as a gate before the audit;
- after a refinement that changed files, to decide whether it is kept.

Keep checks deterministic and free of side effects outside the project. A check that is already failing before the change will send the implementer into repair attempts; either fix it first or leave it out.

## Git checkpoints

With `git.checkpoints: true` and a repository present, Charter snapshots the work tree before each implementer and refiner run and at approval. Snapshots are built through a private index file and stored as commits under `refs/charter/<charter-id>/`. Your HEAD, index, stash and branches are never touched, and `.gitignore` is honored. The charter directory itself is excluded, so restoring files never rewinds the workflow.

Checkpoints are small (git stores only what changed) but they accumulate. `/charter prune [id]` deletes those of a finished charter. To remove all of them at once:

```bash
git for-each-ref --format='%(refname)' refs/charter/ | xargs -n 1 git update-ref -d
```

Set `git.checkpoints` to `false` to run without any git interaction. You then lose change lists, detection of auditor changes, rollback, and the refiner (which is skipped).

## Changing configuration mid-flight

Configuration is read each time a tool or command runs, so a change takes effect at the next step. A phase you disable after approval is passed over and reported as "disabled in the configuration after approval". Avoid changing `directory` while charters are in progress: existing charters are not moved.

## Examples

Specification only: draft and approve here, implement elsewhere.

```json
{ "version": 1, "roles": { "implementer": { "enabled": false } } }
```

Fast loop for small changes: no audit, checks as the only gate.

```json
{
  "version": 1,
  "roles": { "auditor": { "enabled": false } },
  "checks": [{ "name": "test", "run": "npm test" }]
}
```

Thorough: cross-family audit in three parallel shards, refinement, generous budgets.

```json
{
  "version": 1,
  "roles": {
    "implementer": { "model": "anthropic/claude-opus-5", "thinking": "high", "timeoutMinutes": 120 },
    "auditor": { "model": "openai/gpt-6", "thinking": "high", "shards": 3 },
    "refiner": { "enabled": true, "model": "anthropic/claude-sonnet-5" }
  },
  "checks": [
    { "name": "typecheck", "run": "npm run typecheck" },
    { "name": "test", "run": "npm test", "timeoutSeconds": 1800 }
  ],
  "limits": { "cycles": 5 }
}
```

The model ids above are placeholders; use the ids `pi --list-models` shows for your account.
