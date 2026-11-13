# Changelog

## 0.1.0

First release.

- Charter documents (`brief.md`, `spec.md`, optional `design.md` and `attachments/`) with a deterministic linter.
- Developer-only approval and decisions, by dialog or by `/charter approve` and `/charter decide`.
- Pipeline engine: implementer, project checks with bounded automatic repair, auditor (optionally sharded and parallel, with reuse of finished shards on retry), refiner with scope enforcement and automatic rollback.
- Frozen documents: hashes, archived copies per approval, guarded file tools, automatic restore.
- Git checkpoints through a private index: change lists, read-only enforcement for auditors, undoable `/charter rollback`, `/charter prune`. Work is saved to a checkpoint before any automatic restore.
- Resumable state, journal, per-run usage accounting, generated final report.
- Layered optional configuration, interactive setup with check detection, `/charter doctor`.
