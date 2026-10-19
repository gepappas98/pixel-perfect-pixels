# Research Knowledge — safe first phase

- [x] Audit existing research-learning contracts, cohort separation, evidence eligibility, and dashboard integration already present on main.
- [x] Add an unapplied additive schema draft matching the existing `research_evidence`, `research_cases`, and `research_findings` contracts.
- [x] Propose fail-closed retention archival in the migration: source deletion is gated on evidence capture/verification in the same transaction.
- [x] Record read-only production coverage, storage, V3 maturity, orphan lesson and retention dry-run findings.
- [ ] Run tests, lint and build on the connected Lovable/GitHub CI runtime; results are not yet available.
- [ ] Review SQL migration against a staging copy, including rollback and concurrency behavior, before production application.
- [ ] Add automated evidence capture and finding-generation workflow only after schema validation; do not treat current counts or LLM prose as verified findings.
- [ ] Verify dashboard coverage after schema application and compare source/evidence fingerprints without deleting or rewriting source rows.
- [ ] Reconcile event-flow decision history and Council Learning idempotency in a separate additive batch.

Safety boundaries: no production migration application, no production data mutation/deletion, no pipeline invocation, no scoring/execution changes, and no publishing in this phase.


- [ ] Inspect actual learning, outcome, retention, schema and UI paths.
- [ ] Add evidence eligibility, temporal validation, cohort isolation and archive contracts with tests.
- [ ] Add bounded read-only knowledge panel to existing dashboard and AI Report.
- [ ] Prepare unapplied additive schema and fail-closed archival proposals plus verification SQL.
- [ ] Document duplicate-learning and orphan repair rollout without altering source rows.
- [ ] Run tests, lint and preview checks; record actual results and outstanding blockers.

No production migrations, data mutations, pipeline invocations or publishing are authorized in this phase.