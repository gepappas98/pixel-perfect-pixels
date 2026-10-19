# Intelligent Research Knowledge — implementation status

- [x] Map the existing Research Knowledge UI, contracts, read path, cohort isolation, and evidence eligibility.
- [x] Add an additive migration for `research_evidence`, `research_cases`, and `research_findings`, aligned to the existing app.
- [x] Add bounded point-in-time evidence summaries and idempotent case/evidence refresh.
- [x] Link evidence to cases only when observed/available timestamps are at or before entry; forward returns remain outcome evidence.
- [x] Add read-only retention/archive readiness counts by source table.
- [x] Replace retention cleanup inside the unapplied migration with fail-closed archive-then-delete behavior.
- [x] Add ephemeral PostgreSQL integration tests proving migration application, case maturity rules, successful archive cleanup, and that a forced archive failure leaves source rows intact.
- [x] Integrate a research-only, fail-open refresh RPC after post-mortems; it does not feed the scorer or executor.
- [x] Update the existing dashboard, project state, development history, and test coverage.
- [x] CI passed on `4ef16df1c3cbde95b8173cda005e7d18e10717b2`: production build, strict TypeScript, 123 unit tests, Edge Function type-check, SQL integration.
- [ ] Merge PR #131 after final review.
- [ ] Apply the migration to canonical Supabase only after review; migration application has not happened.
- [ ] Run the refresh RPC once after migration and verify actual evidence/case counts.
- [ ] Verify the next retention dry-run and archive status before allowing a scheduled cleanup to delete any old rows.
- [ ] Design evidence-backed candidate-finding generation with statistical calibration and out-of-sample checks; current findings are not auto-generated or marked validated.
- [ ] Reconcile event-flow decision history and Council Learning idempotency in a separate additive batch.

## Safety boundaries

No production data was copied, updated, archived, or deleted during this branch work. No production migration or cron change has been applied. No scoring, entry, execution, or live-order behavior changed. No Lovable publish/deploy was performed. The archive migration is an unapplied artifact until the explicit apply step.
