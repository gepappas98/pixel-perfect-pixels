#!/usr/bin/env python3
"""Build a portable, checksummed snapshot of every tracked repository file.

This is an independent fallback to the Supabase uploader: it requires no
Supabase credentials and never archives untracked files or the .git directory.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

OUT = Path("archive-out")
ARCHIVE = OUT / "repository-source.tar.gz"
MANIFEST = OUT / "repository-manifest.json"
SUMMARY = OUT / "repository-backup-summary.json"
BLOCKED_PARTS = {".env", ".secrets", "secrets", "credentials"}
BLOCKED_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".keystore"}
SAFE_ENV_EXAMPLES = {".env.example", ".env.sample", ".env.template"}

def git(*args: str) -> str:
    return subprocess.check_output(["git", *args]).decode("utf-8").strip()

def blocked(path: str) -> bool:
    p = PurePosixPath(path)
    name = p.name.lower()
    parts = {part.lower() for part in p.parts}
    if name in SAFE_ENV_EXAMPLES:
        return False
    if name.startswith(".env") or parts & BLOCKED_PARTS or p.suffix.lower() in BLOCKED_SUFFIXES:
        return True
    return name in {"id_rsa", "id_ed25519", "known_hosts", "service-account.json"}

def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    commit = git("rev-parse", "HEAD")
    tree = git("rev-parse", "HEAD^{tree}")
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    committed_at = git("show", "-s", "--format=%cI", "HEAD")
    raw = subprocess.check_output(["git", "ls-files", "-z"])
    paths = sorted(p.decode("utf-8") for p in raw.split(b"\0") if p)
    blocked_paths = [p for p in paths if blocked(p)]
    if blocked_paths:
        print("Refusing incomplete backup; review sensitive-looking tracked paths:\n" + "\n".join(blocked_paths), file=sys.stderr)
        return 3

    entries = []
    with tarfile.open(ARCHIVE, "w:gz", format=tarfile.PAX_FORMAT) as archive:
        for path in paths:
            p = Path(path)
            stage = git("ls-files", "--stage", "--", path).split()
            if not stage or stage[0] != "100644" and stage[0] != "100755":
                raise RuntimeError(f"Unsupported tracked mode for {path}: {stage[0] if stage else 'missing'}")
            if not p.is_file() or p.is_symlink():
                raise RuntimeError(f"Tracked path is missing, not a regular file, or a symlink: {path}")
            data = p.read_bytes()
            blob = git("rev-parse", f"HEAD:{path}")
            entry = {
                "path": path,
                "git_blob_sha": blob,
                "sha256": hashlib.sha256(data).hexdigest(),
                "size_bytes": len(data),
                "mode": stage[0],
            }
            entries.append(entry)
            archive.add(p, arcname=path, recursive=False)

    manifest = {
        "backup_type": "full_tracked_repository_snapshot",
        "repository": "gepappas98/pixel-perfect-pixels",
        "branch": branch,
        "commit_sha": commit,
        "tree_sha": tree,
        "committed_at": committed_at,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "tracked_file_count": len(entries),
        "total_file_bytes": sum(x["size_bytes"] for x in entries),
        "all_tracked_files_included": True,
        "history_included": False,
        "archive_file": ARCHIVE.name,
        "archive_sha256": hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(),
        "files": entries,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    summary = {
        "status": "completed",
        "destination": "GitHub Actions artifact",
        "repository": manifest["repository"],
        "branch": branch,
        "commit_sha": commit,
        "tree_sha": tree,
        "tracked_file_count": len(entries),
        "total_file_bytes": manifest["total_file_bytes"],
        "archive_sha256": manifest["archive_sha256"],
        "all_tracked_files_included": True,
        "git_history_included": False,
        "supabase_upload_status": "separate optional step; see workflow logs",
        "created_at": manifest["created_at"],
    }
    SUMMARY.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
