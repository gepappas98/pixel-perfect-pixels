#!/usr/bin/env python3
"""Read-only, repeatable-read snapshots of live Research Lab tables into Observatory archive.

A run is considered complete only when every allowlisted base table has uploaded exactly
its source row count and a final research_live_sync_manifest document has been written.
A failed/interrupted run leaves its partial batches clearly unmanifested; it never deletes
or overwrites prior run snapshots.
"""
import datetime as dt, decimal, json, os, uuid
import psycopg2, requests
from psycopg2.extras import RealDictCursor

DB = os.environ["PROD_READONLY_DATABASE_URL"]
BASE = os.environ["ARCHIVE_SUPABASE_URL"].rstrip("/")
KEY = os.environ["ARCHIVE_SUPABASE_SERVICE_ROLE_KEY"]
SRC = "yckewtpfttvwiptmmrfq"
TABLES = [
    "council_lessons", "trades", "cmc_listing_snapshots", "cmc_macro_snapshots",
    "event_flow_study_snapshots", "event_flow_paper_decisions", "event_flow_transmissions",
    "accumulation_shadow_observations", "early_entry_regime_observations",
    "early_entry_variant_decisions", "strategy_variant_signals", "dynamic_watchlist_snapshots",
    "market_candles", "market_regime_telemetry", "market_sentiment_snapshots", "strategy_config",
]
DEFAULT_BATCH = 500
BATCH_SIZES = {
    "cmc_listing_snapshots": 250,
    "event_flow_study_snapshots": 250,
    "accumulation_shadow_observations": 250,
    "strategy_variant_signals": 250,
    "market_candles": 100,
}
RUN = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
NOW = dt.datetime.now(dt.timezone.utc).isoformat()
S = requests.Session()
S.headers.update({
    "Authorization": f"Bearer {KEY}", "apikey": KEY, "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates,return=minimal",
})

def norm(v):
    if isinstance(v, (dt.datetime, dt.date, dt.time)): return v.isoformat()
    if isinstance(v, decimal.Decimal): return str(v)
    if isinstance(v, uuid.UUID): return str(v)
    if isinstance(v, bytes): return {"__type__": "bytes_hex", "value": v.hex()}
    if isinstance(v, (list, tuple)): return [norm(x) for x in v]
    if isinstance(v, dict): return {str(k): norm(x) for k, x in v.items()}
    return v

def upsert_document(doc):
    url = f"{BASE}/rest/v1/research_archive_documents?on_conflict=document_key"
    res = S.post(url, json=[doc], timeout=(20, 120))
    if res.status_code not in (200, 201, 204):
        raise RuntimeError(f"Archive upsert failed for {doc['document_key']}: HTTP {res.status_code}: {res.text[:400]}")

def main():
    conn = psycopg2.connect(DB, connect_timeout=20, application_name="research-lab-observatory-sync")
    total = 0
    manifest_tables = {}
    try:
        conn.set_session(isolation_level="REPEATABLE READ", readonly=True, autocommit=False)
        with conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")
            existing = {r["table_name"] for r in c.fetchall()}
            missing = sorted(set(TABLES) - existing)
            if missing: raise RuntimeError("Missing source tables; aborting all sync: " + ", ".join(missing))

            for table in TABLES:
                qt = '"public"."' + table.replace('"', '""') + '"'
                c.execute("select column_name from information_schema.columns where table_schema='public' and table_name=%s order by ordinal_position", (table,))
                cols = [r["column_name"] for r in c.fetchall()]
                time_col = next((x for x in ("observed_at", "created_at", "updated_at", "captured_at", "snapshot_at", "timestamp", "event_time") if x in cols), None)
                c.execute("""
                    select a.attname as column_name
                    from pg_index i
                    join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey)
                    where i.indrelid=%s::regclass and i.indisprimary
                    order by array_position(i.indkey::smallint[], a.attnum)
                """, (f"public.{table}",))
                pk_cols = [r["column_name"] for r in c.fetchall()]
                tie_order = ", ".join('"' + x.replace('"', '""') + '" ASC' for x in pk_cols)
                if time_col and tie_order:
                    order = '"' + time_col.replace('"', '""') + '" DESC NULLS LAST, ' + tie_order
                elif time_col:
                    order = '"' + time_col.replace('"', '""') + '" DESC NULLS LAST, ctid DESC'
                elif tie_order:
                    order = tie_order
                else:
                    order = "ctid DESC"

                c.execute(f"select count(*) n from {qt}")
                count = int(c.fetchone()["n"])
                batch_size = BATCH_SIZES.get(table, DEFAULT_BATCH)
                got = 0
                batches = 0
                for off in range(0, count, batch_size):
                    c.execute(f"select * from {qt} order by {order} limit %s offset %s", (batch_size, off))
                    rows = [{k: norm(v) for k, v in row.items()} for row in c.fetchall()]
                    if not rows:
                        raise RuntimeError(f"Unexpected empty batch for {table} offset {off}; source count was {count}")
                    doc = {
                        "document_key": f"research-live-snapshot-{RUN}-{table}-offset-{off}",
                        "title": f"Live Research Lab snapshot {table} offset {off}",
                        "source_project_ref": SRC, "generated_at": NOW, "created_at": NOW,
                        "notes": f"Read-only snapshot run={RUN}; table={table}; offset={off}; rows={len(rows)}; source_table_count={count}; batch_size={batch_size}; source_timestamp_column={time_col or 'none'}; primary_key_columns={','.join(pk_cols) or 'none'}",
                        "payload": {
                            "record_type": table, "snapshot_version": 2, "record_count": len(rows),
                            "records": rows, "source_project_ref": SRC, "source_table": table,
                            "source_table_count": count, "source_timestamp_column": time_col,
                            "source_primary_key_columns": pk_cols, "source_snapshot_run": RUN,
                            "source_snapshot_generated_at": NOW, "batch_offset": off,
                            "batch_limit": batch_size, "offset": off,
                        },
                    }
                    upsert_document(doc)
                    got += len(rows)
                    total += len(rows)
                    batches += 1
                if got != count:
                    raise RuntimeError(f"Completeness check failed for {table}: uploaded {got}/{count}")
                manifest_tables[table] = {
                    "source_rows": count, "uploaded_rows": got, "batches": batches,
                    "batch_size": batch_size, "status": "complete",
                }
                print(f"SYNCED AND VERIFIED {table}: {got}/{count} rows in {batches} batches", flush=True)
        conn.rollback()
    finally:
        conn.close()

    manifest = {
        "run_id": RUN, "generated_at": NOW, "source_project_ref": SRC,
        "status": "complete", "tables": manifest_tables,
        "table_count": len(manifest_tables), "total_rows_uploaded": total,
        "completeness_rule": "Every allowlisted table matched its repeatable-read source count.",
    }
    upsert_document({
        "document_key": f"research-live-manifest-{RUN}",
        "title": f"Verified live Research Lab sync manifest {RUN}",
        "source_project_ref": SRC, "generated_at": NOW, "created_at": NOW,
        "notes": f"COMPLETE: {len(manifest_tables)} tables, {total} rows; per-table source/upload counts match.",
        "payload": {
            "record_type": "research_live_sync_manifest", "snapshot_version": 2,
            "record_count": 1, "records": [manifest], **manifest,
        },
    })
    print(json.dumps({"status": "SYNC_COMPLETE", **manifest}, sort_keys=True), flush=True)

if __name__ == "__main__":
    main()
