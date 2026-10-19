# Intelligent Research Knowledge — implementation status

- [x] Map the existing Research Knowledge UI, contracts, read path, cohort isolation, and evidence eligibility.
- [x] Add the evidence/case/finding schema and read-only archive status to canonical Supabase.
- [x] Add bounded point-in-time evidence summaries, case materialization, and idempotent V3-only automatic refresh.
- [x] Preserve the first 2,250 resolved V2 cases already materialized; stop further automatic V2/Legacy duplication.
- [x] Enforce no-lookahead evidence linking: observed/available timestamps must be at or before entry; forward-return fields remain outcome evidence.
- [x] Add two independent production controls: archive capture disabled by default; source deletion disabled by default.
- [x] Verify the retention cron schedule is unchanged (`17 3 * * *`) and that both controls are false.
- [x] Confirm no retention-source rows were deleted; 22,150 eligible source rows remain intact.
- [x] Reclaim research-table index bloat and drop a redundant source index; database size is 464 MB, below the 480 MB warning threshold at the latest verified reading.
- [x] Merge PR #132 with matching safety/batch migrations and updated UI flags.
- [x] Pass SQL integration CI for the full migration chain (paused capture, forced archive failure, archive-only mode, and explicitly gated deletion in ephemeral PostgreSQL).
- [ ] User-controlled Lovable sync/publish; then verify `pipeline_runs.result.research_knowledge_sync.status=ok` and the panel displays archive/deletion controls.
- [ ] Review which historical source categories are worth compact archival before enabling `allow_archive`; current production capture remains paused.
- [ ] Design evidence-backed candidate-finding generation with statistical calibration and out-of-sample checks; no findings are auto-generated or marked validated yet.
- [ ] Audit event-flow decision history and Council Learning idempotency in a separate additive batch.

## Safety boundaries

The archive/case tables are populated with trade/variant entry evidence, but no retention-source snapshots have been archived or deleted. The retention cron remains active but the function returns before capture/deletion while both controls are false. No scoring, entry, execution, or live-order behavior changed. No Lovable publish/deploy was performed.
