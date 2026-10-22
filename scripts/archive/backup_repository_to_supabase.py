#!/usr/bin/env python3
"""Immutable, idempotent full-repository snapshot into the archive Supabase project.

Every tracked file is stored as base64-encoded byte chunks. The manifest records
commit SHA, path, Git blob SHA, byte length, SHA-256, chunk count, and file mode.
No production/source database credentials are used by this script.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

import requests

REPO = "gepappas98/pixel-perfect-pixels"
SOURCE_PROJECT_REF = "gepappas98/pixel-perfect-pixels"
TABLE = "research_archive_documents"
EXPECTED_ARCHIVE_PROJECT_REF = "ragdznxfozdpxetwisrd"
RAW_CHUNK_BYTES = 24_000
UPSERT_BATCH_SIZE = 4
REQUEST_TIMEOUT = 45
MAX_RETRIES = 5
OUT_DIR = Path("archive-out")
# Do not put credentials, local environment files, or private key material in an archive.
BLOCKED_PARTS = {".env", ".secrets", "secrets", "credentials"}
BLOCKED_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".keystore"}
SAFE_ENV_EXAMPLES = {".env.example", ".env.sample", ".env.template"}


def run_git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True).strip()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def api_headers(key: str) -> dict[str, str]:
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }


def upsert_rows(session: requests.Session, url: str, headers: dict[str, str], rows: list[dict]) -> None:
    endpoint = f"{url.rstrip('/')}/rest/v1/{TABLE}"
    for attempt in range(MAX_RETRIES):
        try:
            response = session.post(
                endpoint,
                params={"on_conflict": "document_key"},
                headers=headers,
                json=rows,
                timeout=REQUEST_TIMEOUT,
            )
            if response.status_code in (200, 201, 204):
                return
            if response.status_code not in (408, 425, 429, 500, 502, 503, 504):
                raise RuntimeError(
                    f"Archive upsert rejected ({response.status_code}): "
                    f"{response.text[:1000]}"
                )
            detail = f"HTTP {response.status_code}: {response.text[:300]}"
        except (requests.RequestException, TimeoutError) as exc:
            detail = str(exc)
        if attempt == MAX_RETRIES - 1:
            raise RuntimeError(f"Archive upsert failed after retries: {detail}")
        time.sleep(min(2 ** attempt, 20))


def is_blocked_path(path: str) -> bool:
    p = PurePosixPath(path)
    name = p.name.lower()
    parts = {part.lower() for part in p.parts}
    if name in SAFE_ENV_EXAMPLES:
        return False
    if name.startswith(".env"):
        return True
    if parts & BLOCKED_PARTS:
        return True
    if p.suffix.lower() in BLOCKED_SUFFIXES:
        return True
    if name in {"id_rsa", "id_ed25519", "known_hosts", "service-account.json"}:
        return True
    return False


def main() -> int:
    supabase_url = os.environ.get("ARCHIVE_SUPABASE_URL", "").strip()
    service_key = os.environ.get("ARCHIVE_SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not supabase_url or not service_key:
        print(
            "Missing GitHub Actions secrets: ARCHIVE_SUPABASE_URL and/or "
            "ARCHIVE_SUPABASE_SERVICE_ROLE_KEY. No files uploaded.",
            file=sys.stderr,
        )
        return 2

    parsed_url = urlparse(supabase_url)
    expected_host = f"{EXPECTED_ARCHIVE_PROJECT_REF}.supabase.co"
    if (
        parsed_url.scheme != "https"
        or parsed_url.hostname != expected_host
        or parsed_url.port not in (None, 443)
        or parsed_url.username is not None
        or parsed_url.password is not None
        or parsed_url.path not in ("", "/")
        or parsed_url.query
        or parsed_url.fragment
    ):
        print(
            "Refusing upload: ARCHIVE_SUPABASE_URL must point only to "
            f"https://{expected_host}/. No files uploaded.",
            file=sys.stderr,
        )
        return 4

    commit = run_git("rev-parse", "HEAD")
    branch = run_git("rev-parse", "--abbrev-ref", "HEAD")
    tree_sha = run_git("rev-parse", "HEAD^{tree}")
    committed_at = run_git("show", "-s", "--format=%cI", "HEAD")
    paths = [p for p in run_git("ls-files", "-z").split("\0") if p]
    paths.sort()

    blocked = [p for p in paths if is_blocked_path(p)]
    if blocked:
        print(
            "Refusing to create an incomplete snapshot because tracked paths look "
            "sensitive. Review/remove them from Git or explicitly handle them first:\n"
            + "\n".join(blocked),
            file=sys.stderr,
        )
        return 3

    session = requests.Session()
    headers = api_headers(service_key)
    manifest_files: list[dict] = []
    pending: list[dict] = []
    total_bytes = 0
    total_chunks = 0
    total_requests = 0

    for path in paths:
        file_path = Path(path)
        if not file_path.is_file() or file_path.is_symlink():
            raise RuntimeError(
                f"Tracked path {path!r} is not a regular file. "
                "Submodules/symlinks must be explicitly represented before backup."
            )
        data = file_path.read_bytes()
        content_sha = sha256(data)
        git_blob_sha = run_git("rev-parse", f"HEAD:{path}")
        path_key = hashlib.sha256(path.encode("utf-8")).hexdigest()[:20]
        chunks = [data[i:i + RAW_CHUNK_BYTES] for i in range(0, len(data), RAW_CHUNK_BYTES)]
        if not chunks:
            chunks = [b""]
        entry = {
            "path": path,
            "git_blob_sha": git_blob_sha,
            "sha256": content_sha,
            "size_bytes": len(data),
            "mode": run_git("ls-files", "--stage", "--", path).split()[0],
            "chunk_count": len(chunks),
            "encoding": "base64",
        }
        manifest_files.append(entry)
        total_bytes += len(data)

        for index, chunk in enumerate(chunks):
            payload = {
                "backup_type": "full_repository_file_chunk",
                "repository": REPO,
                "branch": branch,
                "commit_sha": commit,
                "tree_sha": tree_sha,
                "path": path,
                "path_sha256_prefix": path_key,
                "file_blob_sha": git_blob_sha,
                "file_sha256": content_sha,
                "file_size_bytes": len(data),
                "chunk_index": index,
                "chunk_count": len(chunks),
                "chunk_bytes": len(chunk),
                "encoding": "base64",
                "content_b64": base64.b64encode(chunk).decode("ascii"),
            }
            key = f"code-snapshot-{commit}-{path_key}-{index:05d}"
            pending.append({
                "document_key": key,
                "title": f"Repository source chunk — {path} [{index + 1}/{len(chunks)}]",
                "source_project_ref": SOURCE_PROJECT_REF,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "payload": payload,
                "notes": (
                    f"Immutable repository content chunk; commit={commit}; "
                    f"path={path}; sha256={content_sha}; do not delete source data."
                ),
            })
            total_chunks += 1
            if len(pending) >= UPSERT_BATCH_SIZE:
                upsert_rows(session, supabase_url, headers, pending)
                total_requests += 1
                pending.clear()

    if pending:
        upsert_rows(session, supabase_url, headers, pending)
        total_requests += 1
        pending.clear()

    manifest = {
        "backup_type": "full_repository_snapshot_manifest",
        "repository": REPO,
        "branch": branch,
        "commit_sha": commit,
        "tree_sha": tree_sha,
        "committed_at": committed_at,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "tracked_file_count": len(manifest_files),
        "total_file_bytes": total_bytes,
        "chunk_count": total_chunks,
        "chunk_raw_bytes": RAW_CHUNK_BYTES,
        "all_tracked_files_included": True,
        "content_encoding": "base64 per chunk; concatenate decoded chunks by ascending chunk_index to reconstruct exact bytes",
        "file_manifest": manifest_files,
    }
    manifest_key = f"code-snapshot-manifest-{commit}"
    rows = [{
        "document_key": manifest_key,
        "title": f"Full repository snapshot manifest — {commit[:12]}",
        "source_project_ref": SOURCE_PROJECT_REF,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "payload": manifest,
        "notes": (
            f"Complete tracked-file manifest for {REPO} at immutable commit {commit}. "
            "Contains checksums and chunk references for all tracked files. "
            "No production database is read or modified."
        ),
    }, {
        "document_key": "code-backup-latest",
        "title": "Latest full repository code backup",
        "source_project_ref": SOURCE_PROJECT_REF,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "payload": {
            "backup_type": "latest_code_backup_pointer",
            "repository": REPO,
            "branch": branch,
            "commit_sha": commit,
            "tree_sha": tree_sha,
            "manifest_document_key": manifest_key,
            "tracked_file_count": len(manifest_files),
            "total_file_bytes": total_bytes,
            "chunk_count": total_chunks,
            "all_tracked_files_included": True,
            "committed_at": committed_at,
        },
        "notes": "Mutable pointer to the latest completed full source snapshot; prior commit snapshots remain immutable.",
    }]
    upsert_rows(session, supabase_url, headers, rows)
    total_requests += 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT_DIR / "repository-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    summary = {
        "status": "completed",
        "repository": REPO,
        "branch": branch,
        "commit_sha": commit,
        "tree_sha": tree_sha,
        "tracked_file_count": len(manifest_files),
        "total_file_bytes": total_bytes,
        "chunk_count": total_chunks,
        "all_tracked_files_included": True,
        "upload_batches": total_requests,
        "manifest_document_key": manifest_key,
        "latest_pointer_key": "code-backup-latest",
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }
    (OUT_DIR / "repository-backup-summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
