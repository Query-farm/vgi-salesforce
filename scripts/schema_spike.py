"""Gate 0 schema-explosion spike (brief §7.1), against a SYNTHETIC org served by the replay server.

There is no live org: the replay server's `synthetic_objects=N` mode adds N custom objects
(Synth_0001__c …, 24 fields each) plus Wide__c with 900 custom fields, all with describe
payloads in the documented shape. The worker is the real one, over stdio, through Haybarn.

Measures, at 50 / 200 / 1,500 objects named in ATTACH OBJECTS:
  - ATTACH wall time and the worker's API calls during ATTACH
  - SHOW TABLES FROM salesforce.sobjects (wall time, row count)
  - first bind of a 6-column SELECT on Wide__c (includes its describe), and a second (cached) bind
  - the SOQL select list of that 6-column scan (projection pushdown)
  - Wide__c describe payload size and latency (direct HTTP)
  - worker RSS after binding every object (describe cache for all N objects: the
    memory that a per-object generated family would hold)

Usage: uv run --no-project --with haybarn==2.0.1rc3 --with pytz python scripts/schema_spike.py
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER = os.path.join(ROOT, "bin", "vgi-salesforce-worker")
KEY = open(os.path.join(ROOT, "test", "fixtures", "connected-app.key")).read().replace("\n", "\\n")


def start_mock():
    p = subprocess.Popen([sys.executable, os.path.join(ROOT, "test", "mock_api", "server.py")], stdout=subprocess.PIPE, text=True)
    port = int(re.match(r"PORT:(\d+)", p.stdout.readline()).group(1))
    return p, f"http://127.0.0.1:{port}"


def get(url):
    t = time.perf_counter()
    with urllib.request.urlopen(url) as r:
        body = r.read()
    return body, time.perf_counter() - t


def bun_pids(parent_pid):
    out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,rss=,comm="], capture_output=True, text=True).stdout
    procs = [l.split(None, 3) for l in out.strip().splitlines()]
    children = {}
    for pid, ppid, rss, comm in procs:
        children.setdefault(int(ppid), []).append((int(pid), int(rss), comm))
    found, stack = {}, [parent_pid]
    while stack:
        for pid, rss, comm in children.get(stack.pop(), []):
            if "bun" in comm:
                found[pid] = rss
            stack.append(pid)
    return found


def worker_rss_kb(parent_pid, only=None):
    """RSS of the bun worker process(es) under this Python process (optionally only these pids)."""
    found = bun_pids(parent_pid)
    return sum(v for k, v in found.items() if only is None or k in only)


def _unused(parent_pid):
    out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,rss=,comm="], capture_output=True, text=True).stdout
    procs = [l.split(None, 3) for l in out.strip().splitlines()]
    children = {}
    for pid, ppid, rss, comm in procs:
        children.setdefault(int(ppid), []).append((int(pid), int(rss), comm))
    total, stack = 0, [parent_pid]
    while stack:
        for pid, rss, comm in children.get(stack.pop(), []):
            if "bun" in comm:
                total += rss
            stack.append(pid)
    return total


def run(n, mock_url):
    import haybarn

    get(f"{mock_url}/__reset")
    get(f"{mock_url}/__config?synthetic_objects={n}")
    objects = [f"Synth_{i:04d}__c" for i in range(1, n + 1)] + ["Wide__c"]
    con = haybarn.connect()
    con.sql("LOAD vgi")
    t = time.perf_counter()
    con.sql(f"ATTACH 'salesforce' (TYPE vgi, LOCATION '{WORKER}', OBJECTS '{','.join(objects)}')")
    attach_s = time.perf_counter() - t
    calls_at_attach = len(json.loads(get(f"{mock_url}/__requests")[0]))
    con.sql(
        f"CREATE SECRET sf (TYPE salesforce, INSTANCE_URL '{mock_url}', LOGIN_URL '{mock_url}', "
        f"CLIENT_ID '3MVG9fixture.consumer.key', USERNAME 'integration@acme.example', PRIVATE_KEY '{KEY}')"
    )
    t = time.perf_counter()
    tables = con.sql("SHOW TABLES FROM salesforce.sobjects").fetchall()
    show_s = time.perf_counter() - t
    n_before = len(json.loads(get(f"{mock_url}/__requests")[0]))
    t = time.perf_counter()
    con.sql("SHOW ALL TABLES").fetchall()
    show_all_s = time.perf_counter() - t
    show_all_calls = len(json.loads(get(f"{mock_url}/__requests")[0])) - n_before
    six = "SELECT id, name, wide_field_001, wide_field_002, wide_field_003, system_modstamp FROM salesforce.sobjects.Wide__c"
    t = time.perf_counter()
    con.sql(f"DESCRIBE {six}").fetchall()
    bind1 = time.perf_counter() - t
    t = time.perf_counter()
    con.sql(f"DESCRIBE {six}").fetchall()
    bind2 = time.perf_counter() - t
    rows = con.sql(six).fetchall()
    log = json.loads(get(f"{mock_url}/__requests")[0])
    q = [r["q"] for r in log if r.get("q") and "Wide__c" in r["q"]][-1]
    width = len(con.sql("DESCRIBE SELECT * FROM salesforce.sobjects.Wide__c").fetchall())
    rss_before = worker_rss_kb(os.getpid())
    # Bind every object once (forces N describes into the worker's cache).
    t = time.perf_counter()
    for o in objects:
        con.sql(f"DESCRIBE SELECT * FROM salesforce.sobjects.{o}").fetchall()
    bind_all_s = time.perf_counter() - t
    rss_after = worker_rss_kb(os.getpid())
    con.close()
    return {
        "objects": n + 1,
        "attach_s": round(attach_s, 3),
        "api_calls_during_attach": calls_at_attach,
        "show_tables_s": round(show_s, 3),
        "show_tables_rows": len(tables),
        "show_all_tables_s": round(show_all_s, 3),
        "show_all_tables_api_calls": show_all_calls,
        "wide_first_bind_s": round(bind1, 3),
        "wide_cached_bind_s": round(bind2, 3),
        "wide_columns": width,
        "six_col_scan_rows": len(rows),
        "six_col_soql": q,
        "bind_every_object_s": round(bind_all_s, 2),
        "worker_rss_mb_before": round(rss_before / 1024, 1),
        "worker_rss_mb_after_all_describes": round(rss_after / 1024, 1),
    }


def main():
    mock, url = start_mock()
    try:
        get(f"{url}/__config?synthetic_objects=1")
        token = json.loads(
            urllib.request.urlopen(urllib.request.Request(f"{url}/services/oauth2/token", data=b"grant_type=client_credentials&client_id=3MVG9fixture.consumer.key&client_secret=fixture-consumer-secret")).read()
        )["access_token"]
        req = urllib.request.Request(f"{url}/services/data/v64.0/sobjects/Wide__c/describe", headers={"Authorization": f"Bearer {token}"})
        t = time.perf_counter()
        body = urllib.request.urlopen(req).read()
        print(json.dumps({"wide_describe_bytes": len(body), "wide_describe_fields": len(json.loads(body)["fields"]),
                          "wide_describe_local_latency_s": round(time.perf_counter() - t, 4)}))
        # One Python (and so one worker process) per size, so RSS is per attach.
        for n in (50, 200, 1500):
            subprocess.run([sys.executable, __file__, "--one", str(n), url], check=True)
    finally:
        mock.terminate()


if __name__ == "__main__":
    if sys.argv[1:2] == ["--one"]:
        print(json.dumps(run(int(sys.argv[2]), sys.argv[3])), flush=True)
    else:
        main()
