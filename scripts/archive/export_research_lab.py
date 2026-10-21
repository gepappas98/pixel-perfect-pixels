#!/usr/bin/env python3
"""Read-only repeatable-read export of public tables to private Supabase Storage."""
import base64
import datetime as dt
import decimal
import gzip
import hashlib
import json
import os
import pathlib
import uuid

import psycopg2
import requests
from psycopg2.extras import RealDictCursor

DB = os.environ["PROD_READONLY_DATABASE_URL"]
BASE = os.environ["ARCHIVE_SUPABASE_URL"].rstrip("/")
KEY = os.environ["ARCHIVE_SUPABASE_SERVICE_ROLE_KEY"]
BUCKET = "research-lab-archive"
RUN = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
OUT = pathlib.Path("archive-out") / RUN
OUT.mkdir(parents=True, exist_ok=True)
MAX_RAW_BYTES = 16 * 1024 * 1024
session = requests.Session()
session.headers.update({"Authorization": f"Bearer {KEY}", "apikey": KEY})


def normalize(value):
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, bytes):
        return {"__type__": "bytes_base64", "value": base64.b64encode(value).decode()}
    if isinstance(value, (list, tuple)):
        return [normalize(item) for item in value]
    if isinstance(value, dict):
        return {str(key): normalize(item) for key, item in value.items()}
    return value


def upload(path, object_name, content_type):
    url = f"{BASE}/storage/v1/object/{BUCKET}/{object_name}"
    with path.open("rb") as stream:
        response = session.post(
            url, data=stream,
            headers={"Content-Type": content_type, "x-upsert": "false"},
            timeout=(20, 300),
        )
    if response.status_code not in (200, 201):
        raise RuntimeError(f"Storage upload failed ({response.status_code}) for {object_name}: {response.text[:300]}")
    local_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    check = session.get(
        f"{BASE}/storage/v1/object/authenticated/{BUCKET}/{object_name}",
        timeout=(20, 300),
    )
    if check.status_code != 200:
        raise RuntimeError(f"Storage read-back failed ({check.status_code}) for {object_name}: {check.text[:300]}")
    remote_hash = hashlib.sha256(check.content).hexdigest()
    if remote_hash != local_hash or len(check.content) != path.stat().st_size:
        raise RuntimeError(f"Storage checksum/size mismatch for {object_name}")
    return {
        "path": object_name, "bytes": path.stat().st_size,
        "sha256": local_hash, "readback_sha256": remote_hash,
        "readback_verified": True,
    }


def main():
    manifest = {
        "format": "research-lab-table-jsonl-gzip-v1",
        "run_id": RUN, "source_project_ref": "yckewtpfttvwiptmmrfq",
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "snapshot_isolation": "REPEATABLE READ, READ ONLY",
        "tables": [], "files": [],
        "scope_note": "public base-table data and table/column/constraint metadata; not a full pg_dump of routines, triggers, policies, grants, or extensions",
    }
    conn = psycopg2.connect(
        DB, connect_timeout=20,
        application_name="research-lab-readonly-archive-export",
    )
    try:
        conn.set_session(isolation_level="REPEATABLE READ", readonly=True, autocommit=False)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT t.table_name,
                       json_agg(json_build_object(
                         'column', c.column_name, 'ordinal', c.ordinal_position,
                         'type', c.data_type, 'udt', c.udt_name,
                         'nullable', c.is_nullable, 'default', c.column_default
                       ) ORDER BY c.ordinal_position) AS columns
                FROM information_schema.tables t
                JOIN information_schema.columns c USING (table_schema, table_name)
                WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
                GROUP BY t.table_name ORDER BY t.table_name
            """)
            tables = cur.fetchall()
            cur.execute("""
                SELECT tc.table_name, tc.constraint_name, tc.constraint_type,
                       array_agg(kcu.column_name ORDER BY kcu.ordinal_position)
                         FILTER (WHERE kcu.column_name IS NOT NULL) AS columns,
                       ccu.table_name AS foreign_table,
                       array_agg(ccu.column_name ORDER BY kcu.ordinal_position)
                         FILTER (WHERE ccu.column_name IS NOT NULL) AS foreign_columns
                FROM information_schema.table_constraints tc
                LEFT JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_catalog = kcu.constraint_catalog
                 AND tc.constraint_schema = kcu.constraint_schema
                 AND tc.constraint_name = kcu.constraint_name
                 AND tc.table_name = kcu.table_name
                LEFT JOIN information_schema.constraint_column_usage ccu
                  ON tc.constraint_catalog = ccu.constraint_catalog
                 AND tc.constraint_schema = ccu.constraint_schema
                 AND tc.constraint_name = ccu.constraint_name
                WHERE tc.table_schema = 'public'
                GROUP BY tc.table_name, tc.constraint_name, tc.constraint_type, ccu.table_name
                ORDER BY tc.table_name, tc.constraint_name
            """)
            constraints = {}
            for item in cur.fetchall():
                constraints.setdefault(item["table_name"], []).append(dict(item))

            for index, table in enumerate(tables):
                name = table["table_name"]
                quoted = '"public"."' + name.replace('"', '""') + '"'
                cur.execute("""
                    SELECT array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS pk
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu
                      ON tc.constraint_catalog = kcu.constraint_catalog
                     AND tc.constraint_schema = kcu.constraint_schema
                     AND tc.constraint_name = kcu.constraint_name
                     AND tc.table_name = kcu.table_name
                    WHERE tc.table_schema = 'public' AND tc.table_name = %s
                      AND tc.constraint_type = 'PRIMARY KEY'
                """, (name,))
                pk = (cur.fetchone() or {}).get("pk") or []
                order_sql = " ORDER BY " + ", ".join('"' + col.replace('"', '""') + '"' for col in pk) if pk else ""
                cur.execute(f"SELECT count(*) AS n FROM {quoted}")
                expected = cur.fetchone()["n"]
                meta = {
                    "schema": "public", "table": name, "columns": table["columns"],
                    "constraints": constraints.get(name, []), "primary_key": pk,
                    "row_count": expected, "exported_rows": 0, "chunks": [],
                }
                chunk_number = 0
                raw_size = 0
                chunk_rows = 0
                row_count = 0
                raw_file = None
                gzip_file = None
                current_path = None

                def open_chunk():
                    nonlocal chunk_number, raw_size, chunk_rows, raw_file, gzip_file, current_path
                    chunk_number += 1
                    raw_size = 0
                    chunk_rows = 0
                    current_path = OUT / f"{name}.part-{chunk_number:05d}.jsonl.gz"
                    raw_file = current_path.open("wb")
                    gzip_file = gzip.GzipFile(fileobj=raw_file, mode="wb", mtime=0)

                def close_chunk():
                    nonlocal raw_file, gzip_file
                    if gzip_file is None:
                        return
                    gzip_file.close()
                    raw_file.close()
                    object_name = f"{RUN}/data/{name}/part-{chunk_number:05d}.jsonl.gz"
                    info = upload(current_path, object_name, "application/gzip")
                    info.update({"table": name, "chunk": chunk_number, "rows": chunk_rows})
                    manifest["files"].append(info)
                    meta["chunks"].append(info)
                    raw_file = None
                    gzip_file = None

                cursor_name = f"archive_{index}_{uuid.uuid4().hex[:8]}"
                with conn.cursor(name=cursor_name, cursor_factory=RealDictCursor) as data_cur:
                    data_cur.itersize = 500
                    data_cur.execute(f"SELECT * FROM {quoted}{order_sql}")
                    while True:
                        batch = data_cur.fetchmany(500)
                        if not batch:
                            break
                        for row in batch:
                            encoded = (
                                json.dumps(
                                    {key: normalize(value) for key, value in row.items()},
                                    ensure_ascii=False, separators=(",", ":"), allow_nan=False,
                                ) + "\n"
                            ).encode("utf-8")
                            if gzip_file is None:
                                open_chunk()
                            elif raw_size + len(encoded) > MAX_RAW_BYTES and chunk_rows:
                                close_chunk()
                                open_chunk()
                            gzip_file.write(encoded)
                            raw_size += len(encoded)
                            chunk_rows += 1
                            row_count += 1
                close_chunk()
                if row_count != expected:
                    raise RuntimeError(f"Count mismatch for {name}: expected {expected}, exported {row_count}")
                meta["exported_rows"] = row_count
                manifest["tables"].append(meta)
                print(f"EXPORTED {name}: {row_count} rows, {len(meta['chunks'])} chunks", flush=True)
        conn.rollback()
    finally:
        conn.close()

    manifest["total_rows"] = sum(table["exported_rows"] for table in manifest["tables"])
    manifest["table_count"] = len(manifest["tables"])
    manifest["file_count"] = len(manifest["files"])
    manifest_path = OUT / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    result = upload(manifest_path, f"{RUN}/manifest.json", "application/json")
    print(json.dumps({
        "status": "EXPORT_COMPLETE", "run_id": RUN,
        "table_count": manifest["table_count"], "total_rows": manifest["total_rows"],
        "file_count": manifest["file_count"], "manifest": result,
    }, indent=2), flush=True)


if __name__ == "__main__":
    main()
