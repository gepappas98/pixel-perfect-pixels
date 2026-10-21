# Full repository archive backup

The workflow `.github/workflows/research-lab-code-backup.yml` copies the complete tracked repository tree into the **archive Supabase project**. It does not connect to or write to the production trading database.

## Schedule and triggers

- Manual: GitHub Actions → **Research Lab — Full repository archive backup** → Run workflow.
- Scheduled: daily at 02:17 UTC.
- Automatic: changes to the configured source paths on `main`.

## Required GitHub Actions secrets

Set these in the `research-lab-archive` environment:

- `ARCHIVE_SUPABASE_URL`: URL of the dedicated archive Supabase project.
- `ARCHIVE_SUPABASE_SERVICE_ROLE_KEY`: service-role key for that archive project only. Never use the production project's service-role key.

The destination table `public.research_archive_documents` must already exist and allow service-role upserts using the unique `document_key` column. This workflow intentionally does not run migrations or create/alter tables.

## Snapshot format and recovery

- Each tracked file is stored as base64-encoded chunks, keyed by immutable Git commit SHA and a hash of the path.
- The manifest records every tracked path, Git blob SHA, SHA-256, file size, file mode, and chunk count.
- `code-snapshot-manifest-<commit>` is immutable for each commit; `code-backup-latest` is the current pointer.
- Chunks are idempotently upserted. Re-running a backup of the same commit does not create duplicate documents.
- The run uploads a manifest and summary as a GitHub Actions artifact for audit (90-day retention); the durable copy is in the archive database.
- To restore a file, select its manifest entry, fetch all chunk documents for the same commit/path in ascending `chunk_index`, base64-decode each `content_b64`, concatenate the bytes, and verify the SHA-256 from the manifest.
- Empty files are represented by one empty chunk.

## Safety and failure behavior

- The uploader reads only files tracked by Git at the checked-out commit.
- It refuses to run if tracked paths resemble local environment files, credentials, or private keys; inspect such paths rather than archiving secrets.
- It fails on symlinks/submodules that cannot be safely represented as ordinary files, missing secrets, schema/API errors, or incomplete upload requests.
- Existing snapshots are not deleted. No source database rows are modified.
- The uploader uses the archive project only. Do not configure production database credentials in this workflow.

## Important limitation

The job must complete successfully at least once after merge before a full backup is confirmed. A workflow file committed to a branch does not execute the schedule until that branch is merged into `main`. Confirm the run's success and inspect `repository-backup-summary.json` before treating the repository snapshot as a verified recovery point.
