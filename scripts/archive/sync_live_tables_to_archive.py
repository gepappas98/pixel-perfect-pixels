#!/usr/bin/env python3
"""Read-only, repeatable-read snapshots of live Research Lab tables into Observatory archive."""
import datetime as dt, decimal, json, os, uuid
import psycopg2, requests
from psycopg2.extras import RealDictCursor

DB=os.environ["PROD_READONLY_DATABASE_URL"]
BASE=os.environ["ARCHIVE_SUPABASE_URL"].rstrip("/")
KEY=os.environ["ARCHIVE_SUPABASE_SERVICE_ROLE_KEY"]
SRC="yckewtpfttvwiptmmrfq"
TABLES=["council_lessons","trades","cmc_listing_snapshots","event_flow_study_snapshots","accumulation_shadow_observations","early_entry_regime_observations","strategy_variant_signals"]
BATCH=500
RUN=dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
NOW=dt.datetime.now(dt.timezone.utc).isoformat()
S=requests.Session()
S.headers.update({"Authorization":f"Bearer {KEY}","apikey":KEY,"Content-Type":"application/json","Prefer":"resolution=merge-duplicates,return=minimal"})

def norm(v):
    if isinstance(v,(dt.datetime,dt.date,dt.time)): return v.isoformat()
    if isinstance(v,decimal.Decimal): return str(v)
    if isinstance(v,uuid.UUID): return str(v)
    if isinstance(v,bytes): return {"__type__":"bytes_hex","value":v.hex()}
    if isinstance(v,(list,tuple)): return [norm(x) for x in v]
    if isinstance(v,dict): return {str(k):norm(x) for k,x in v.items()}
    return v

def main():
    conn=psycopg2.connect(DB,connect_timeout=20,application_name="research-lab-observatory-sync")
    total=0
    try:
        conn.set_session(isolation_level="REPEATABLE READ",readonly=True,autocommit=False)
        with conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")
            existing={r["table_name"] for r in c.fetchall()}
            missing=sorted(set(TABLES)-existing)
            if missing: raise RuntimeError("Missing source tables; aborting all sync: "+", ".join(missing))
            for table in TABLES:
                qt='"public"."'+table.replace('"','""')+'"'
                c.execute("select column_name from information_schema.columns where table_schema='public' and table_name=%s order by ordinal_position",(table,))
                cols=[r["column_name"] for r in c.fetchall()]
                tc=next((x for x in ("observed_at","created_at","updated_at","captured_at","snapshot_at","timestamp","event_time") if x in cols),None)
                order=f'"{tc}" DESC NULLS LAST' if tc else "ctid DESC"
                c.execute(f"select count(*) n from {qt}"); count=c.fetchone()["n"]; got=0
                for off in range(0,count,BATCH):
                    c.execute(f"select * from {qt} order by {order} limit %s offset %s",(BATCH,off))
                    rows=[{k:norm(v) for k,v in r.items()} for r in c.fetchall()]
                    if not rows: continue
                    doc={"document_key":f"research-live-snapshot-{RUN}-{table}-offset-{off}",
                         "title":f"Live Research Lab snapshot {table} offset {off}",
                         "source_project_ref":SRC,"generated_at":NOW,"created_at":NOW,
                         "notes":f"Read-only source snapshot run={RUN}; table={table}; offset={off}; rows={len(rows)}; source_table_count={count}; source_timestamp_column={tc or 'none'}",
                         "payload":{"record_type":table,"record_count":len(rows),"records":rows,
                                    "source_project_ref":SRC,"source_table":table,"source_table_count":count,
                                    "source_timestamp_column":tc,"source_snapshot_run":RUN,
                                    "source_snapshot_generated_at":NOW,"offset":off}}
                    url=f"{BASE}/rest/v1/research_archive_documents?on_conflict=document_key"
                    res=S.post(url,json=[doc],timeout=(20,120))
                    if res.status_code not in (200,201,204):
                        raise RuntimeError(f"Archive upsert failed for {table} offset {off}: HTTP {res.status_code}: {res.text[:400]}")
                    got+=len(rows); total+=len(rows)
                print(f"SYNCED {table}: {got}/{count}",flush=True)
        conn.rollback()
    finally: conn.close()
    print(json.dumps({"status":"SYNC_COMPLETE","run":RUN,"rows":total,"tables":TABLES}))
if __name__=="__main__": main()
