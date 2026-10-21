#!/usr/bin/env python3
"""Read-only, repeatable-read export of public tables to private Supabase Storage."""
import base64, datetime, decimal, gzip, hashlib, json, os, pathlib, sys, uuid
import psycopg2
import requests
from psycopg2.extras import RealDictCursor, Json

DB = os.environ["PROD_READONLY_DATABASE_URL"]
BASE = os.environ["ARCHIVE_SUPABASE_URL"].rstrip("/")
KEY = os.environ["ARCHIVE_SUPABASE_SERVICE_ROLE_KEY"]
BUCKET = "research-lab-archive"
RUN = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
OUT = pathlib.Path("archive-out") / RUN
OUT.mkdir(parents=True, exist_ok=True)
MAX_RAW_BYTES = 16 * 1024 * 1024  # conservative chunk size before gzip
session = requests.Session()
session.headers.update({"Authorization": f"Bearer {KEY}", "apikey": KEY, "Content-Type": "application/octet-stream", "x-upsert": "false"})

def normalize(v):
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)): return v.isoformat()
    if isinstance(v, decimal.Decimal): return str(v)
    if isinstance(v, uuid.UUID): return str(v)
    if isinstance(v, bytes): return {"__type__":"bytes_base64","value":base64.b64encode(v).decode()}
    if isinstance(v, (list, tuple)): return [normalize(x) for x in v]
    if isinstance(v, dict): return {str(k): normalize(x) for k,x in v.items()}
    return v

def upload(path, object_name, content_type="application/gzip"):
    url = f"{BASE}/storage/v1/object/{BUCKET}/{object_name}"
    with open(path, "rb") as f:
        resp = session.post(url, data=f, headers={"Content-Type":content_type})
    if resp.status_code not in (200, 201): raise RuntimeError(f"Storage upload failed ({resp.status_code}) for {object_name}: {resp.text[:300]}")
    return {"path":object_name,"bytes":path.stat().st_size,"sha256":hashlib.sha256(path.read_bytes()).hexdigest(),"storage_status":resp.status_code}

def main():
    manifest = {"format":"research-lab-table-jsonl-gzip-v1","run_id":RUN,"source_project_ref":"yckewtpfttvwiptmmrfq","created_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"snapshot_isolation":"REPEATABLE READ, READ ONLY","tables":[],"files":[]}
    conn = psycopg2.connect(DB, connect_timeout=20, application_name="research-lab-readonly-archive-export")
    try:
        conn.set_session(isolation_level="REPEATABLE READ", readonly=True, autocommit=False)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""SELECT t.table_schema,t.table_name,
                json_agg(json_build_object('column',c.column_name,'ordinal',c.ordinal_position,'type',c.data_type,'udt',c.udt_name,'nullable',c.is_nullable,'default',c.column_default) ORDER BY c.ordinal_position) AS columns
                FROM information_schema.tables t JOIN information_schema.columns c USING(table_schema,table_name)
                WHERE t.table_schema='public' AND t.table_type='BASE TABLE'
                GROUP BY t.table_schema,t.table_name ORDER BY t.table_name""")
            tables = cur.fetchall()
            cur.execute("""SELECT tc.table_name,tc.constraint_name,tc.constraint_type,
                json_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS columns,
                ccu.table_name AS foreign_table,
                json_agg(ccu.column_name ORDER BY kcu.ordinal_position) FILTER (WHERE ccu.column_name IS NOT NULL) AS foreign_columns
                FROM information_schema.table_constraints tc
                LEFT JOIN information_schema.key_column_usage kcu ON tc.constraint_catalog=kcu.constraint_catalog AND tc.constraint_schema=kcu.constraint_schema AND tc.constraint_name=kcu.constraint_name AND tc.table_name=kcu.table_name
                LEFT JOIN information_schema.constraint_column_usage ccu ON tc.constraint_catalog=ccu.constraint_catalog AND tc.constraint_schema=ccu.constraint_schema AND tc.constraint_name=ccu.constraint_name
                WHERE tc.table_schema='public' GROUP BY tc.table_name,tc.constraint_name,tc.constraint_type,ccu.table_name ORDER BY tc.table_name,tc.constraint_name""")
            constraints = {}
            for row in cur.fetchall(): constraints.setdefault(row["table_name"],[]).append(row)
            for table in tables:
                name=table["table_name"]
                cols=[c["column"] for c in table["columns"]]
                # Explicit column list and stable primary-key ordering where available.
                cur.execute("""SELECT array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS pk
                    FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu
                    USING (constraint_catalog,constraint_schema,constraint_name,table_name)
                    WHERE tc.table_schema='public' AND tc.table_name=%s AND tc.constraint_type='PRIMARY KEY'""",(name,))
                pkrow=cur.fetchone(); pk=(pkrow or {}).get("pk") or []
                order_sql = " ORDER BY " + ", ".join('"'+x.replace('"','""')+'"' for x in pk) if pk else ""
                safe_table='"public"."'+name.replace('"','""')+'"'
                cur.execute(f"SELECT count(*) AS n FROM {safe_table}")
                expected_count=cur.fetchone()["n"]
                table_meta={"schema":"public","table":name,"columns":table["columns"],"constraints":constraints.get(name,[]),"primary_key":pk,"row_count":expected_count,"chunks":[]}
                chunk_no=0; raw_size=0; row_count=0; fh=None; gz=None; current_path=None
                def open_chunk():
                    nonlocal chunk_no,raw_size,fh,gz,current_path
                    chunk_no+=1; raw_size=0
                    current_path=OUT/f"{name}.part-{chunk_no:05d}.jsonl.gz"
                    fh=open(current_path,"wb"); gz=gzip.GzipFile(fileobj=fh,mode="wb",mtime=0)
                def close_chunk():
                    nonlocal fh,gz
                    if gz:
                        gz.close(); fh.close()
                        obj=f"{RUN}/data/{name}/part-{chunk_no:05d}.jsonl.gz"
                        info=upload(current_path,obj)
                        info.update({"table":name,"chunk":chunk_no,"rows":chunk_rows})
                        manifest["files"].append(info); table_meta["chunks"].append(info)
                        fh=None; gz=None
                cur.execute(f"SELECT * FROM {safe_table}{order_sql}")
                while True:
                    rows=cur.fetchmany(500)
                    if not rows: break
                    for row in rows:
                        encoded=(json.dumps({k:normalize(v) for k,v in row.items()},ensure_ascii=False,separators=(",",":"),allow_nan=False)+"\n").encode()
                        if gz is None or (raw_size+len(encoded)>MAX_RAW_BYTES and chunk_rows>0):
                            if gz: close_chunk()
                            open_chunk(); chunk_rows=0
                        gz.write(encoded); raw_size+=len(encoded); row_count+=1; chunk_rows+=1
                if gz: close_chunk()
                if row_count != expected_count: raise RuntimeError(f"Count mismatch for {name}: expected {expected_count}, exported {row_count}")
                table_meta["exported_rows"]=row_count
                manifest["tables"].append(table_meta)
                print(f"EXPORTED {name}: {row_count} rows, {len(table_meta['chunks'])} chunks",flush=True)
        conn.rollback()  # read-only snapshot only; no source mutations
    finally:
        conn.close()
    manifest_path=OUT/"manifest.json"
    manifest["total_rows"]=sum(t["exported_rows"] for t in manifest["tables"])
    manifest["table_count"]=len(manifest["tables"])
    manifest["file_count"]=len(manifest["files"])
    manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding="utf-8")
    # Upload manifest last so its presence marks a completed export.
    result=upload(manifest_path,f"{RUN}/manifest.json","application/json")
    print(json.dumps({"status":"EXPORT_COMPLETE","run_id":RUN,"table_count":manifest["table_count"],"total_rows":manifest["total_rows"],"file_count":manifest["file_count"],"manifest":result},indent=2),flush=True)

if __name__=="__main__":
    main()
