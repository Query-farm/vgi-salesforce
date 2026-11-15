"""Offline Salesforce replay server for the vgi-salesforce tests (stdlib only).

Implements, from the documented shapes, the parts of the REST and Bulk API 2.0 the
worker uses, against the fixture org in fixtures.py:

  POST /services/oauth2/token                    JWT bearer (RS256 signature verified), client
                                                 credentials, refresh token
  GET  /services/data/vNN.0/sobjects             describeGlobal
  GET  /services/data/vNN.0/sobjects/X/describe  describe (If-Modified-Since → 304)
  GET  /services/data/vNN.0/limits
  GET  /services/data/vNN.0/query?q= | queryAll  SOQL (strictly parsed and evaluated), paged
  GET  /services/data/vNN.0/query/<cursor>       nextRecordsUrl pages
  GET  /services/data/vNN.0/sobjects/X/updated/  getUpdated   …/deleted/  getDeleted
  POST /services/data/vNN.0/composite/sobjects/X sObject Collections retrieve {ids, fields}
  POST /services/data/vNN.0/jobs/query           Bulk 2.0 query job (UploadComplete → InProgress → JobComplete)
  GET  /services/data/vNN.0/jobs/query[/id[/results?maxRecords&locator]]

Every data response carries `Sforce-Limit-Info: api-usage=N/M`. Test hooks:
  GET  /__requests        JSON request log ({method, path, q, body})
  GET  /__reset           clear the log, jobs, cursors and config (GET so SQL tests can call it)
  GET  /__config?k=<json> or POST JSON: rest_page_size, api_used, api_max, expire_job_after_pages,
                          expire_cursor_after_pages, fail_once {path, status, code},
                          daily_limit_exhausted, synthetic_objects, wide_fields

Run: python server.py [--port N]  (prints PORT:<n> once listening)
"""

import base64
import hashlib
import json
import os
import sys
import threading
import time
import uuid
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fixtures  # noqa: E402
from soql import Org, Query, SoqlError, now_utc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = json.load(open(os.path.join(HERE, "..", "fixtures", "connected-app.pub.json")))

CLIENT_ID = "3MVG9fixture.consumer.key"
CLIENT_SECRET = "fixture-consumer-secret"
USERNAME = "integration@acme.example"
REFRESH_TOKEN = "5Aep861fixture.refresh"
STATIC_TOKEN = "00Dfixture!static.access.token"

LOCK = threading.Lock()
STATE = {}


def reset():
    STATE.clear()
    STATE.update({
        "log": [], "jobs": {}, "cursors": {}, "tokens": {STATIC_TOKEN}, "api_used": 100, "api_max": 15000,
        "rest_page_size": 2000, "expire_job_after_pages": None, "expire_cursor_after_pages": None,
        "fail_once": None, "daily_limit_exhausted": False, "describe_epoch": time.time() - 3600,
    })
    STATE["org"] = Org(dict(fixtures.DESCRIBE_FIELDS), dict(fixtures.RECORDS))


reset()


def describe_global():
    org = STATE["org"]
    out = []
    for name in org.describes:
        custom = name.endswith("__c")
        out.append({
            "name": name, "label": name.replace("__c", "").replace("_", " "), "labelPlural": name.replace("__c", "") + "s",
            "keyPrefix": fixtures.PREFIX.get(name), "custom": custom, "queryable": True, "createable": not name.startswith("Organization"),
            "updateable": True, "deletable": True, "replicateable": name not in ("Organization", "UserLicense"),
            "retrieveable": True, "searchable": not custom or name == "Invoice__c", "customSetting": False,
        })
    return {"encoding": "UTF-8", "maxBatchSize": 200, "sobjects": out}


def describe(name):
    org = STATE["org"]
    obj = org.obj(name)
    rts = [
        {"recordTypeId": r["Id"], "developerName": r["DeveloperName"], "name": r["Name"], "active": r["IsActive"], "available": True, "master": False}
        for r in fixtures.RECORDS["RecordType"] if r["SobjectType"] == obj
    ]
    return {"name": obj, "label": obj.replace("__c", ""), "keyPrefix": fixtures.PREFIX.get(obj), "custom": obj.endswith("__c"),
            "queryable": True, "fields": org.describes[obj], "recordTypeInfos": rts, "childRelationships": []}


# ------------------------------------------------------------------ rendering

def rest_value(f, v):
    if v is None:
        return None
    if f.get("type") == "datetime":
        return v.replace("Z", "+0000")
    return v


def csv_value(f, v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer() and f.get("type") in ("int", "long"):
        return str(int(v))
    s = str(v)
    if any(c in s for c in ',"\n\r'):
        s = '"' + s.replace('"', '""') + '"'
    return s


def compound_value(org, obj, f, rec, rest=True):
    comps = [c for c in org.describes[obj] if c.get("compoundFieldName") == f["name"]]
    if not any(rec.get(c["name"]) is not None for c in comps):
        return None
    out = {}
    for c in comps:
        n = c["name"]
        for suffix, key in (("GeocodeAccuracy", "geocodeAccuracy"), ("PostalCode", "postalCode"), ("Street", "street"),
                            ("City", "city"), ("State", "state"), ("Country", "country"), ("Latitude__s", "latitude"),
                            ("Longitude__s", "longitude"), ("Latitude", "latitude"), ("Longitude", "longitude")):
            if n.endswith(suffix):
                out[key] = rec.get(n)
                break
    return out


def attributes(obj, rec):
    return {"type": obj, "url": f"/services/data/v64.0/sobjects/{obj}/{rec.get('Id')}"}


def render_rest(q, rec):
    org = q.org
    out = {"attributes": attributes(q.obj, rec)}
    for kind, canon, f, get in q.items:
        if kind != "field":
            continue
        segs = canon.split(".")
        if f.get("type") in ("address", "location"):
            if len(segs) > 1:
                raise SoqlError("INVALID_FIELD", "compound fields through relationships are not supported here")
            out[canon] = compound_value(org, q.obj, f, rec)
            continue
        if len(segs) == 1:
            out[canon] = rest_value(f, rec.get(canon))
            continue
        # Nested parent objects.
        cur, cur_rec, cur_obj = out, rec, q.obj
        for seg in segs[:-1]:
            rel = next(x for x in org.describes[cur_obj] if x["type"] == "reference" and x["relationshipName"] == seg)
            hit = org.by_id.get(cur_rec.get(rel["name"])) if cur_rec else None
            if seg not in cur or cur[seg] is None:
                cur[seg] = None if hit is None else {"attributes": attributes(hit[0], hit[1])}
            if hit is None:
                break
            cur, cur_obj, cur_rec = cur[seg], hit[0], hit[1]
        else:
            cur[segs[-1]] = rest_value(f, get(rec))
    return out


def render_csv(q, rows):
    for kind, canon, f, _ in q.items:
        if kind != "field" or f.get("type") in ("address", "location", "base64"):
            raise SoqlError("INVALIDJOB" if kind != "field" else "FEATURENOTENABLED",
                            "Aggregate queries are not supported by Bulk API 2.0" if kind != "field"
                            else f"Compound and base64 fields are not supported by Bulk API 2.0 query: {canon}")
    header = [canon for _, canon, _, _ in q.items]
    lines = [",".join(f'"{h}"' for h in header)]
    for r in rows:
        lines.append(",".join(csv_value(f, get(r)) for _, _, f, get in q.items))
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------- RSA / JWT

def b64d(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


SHA256_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


def verify_rs256(signing_input, sig):
    n, e = int(PUB["n"]), int(PUB["e"])
    k = (n.bit_length() + 7) // 8
    m = pow(int.from_bytes(sig, "big"), e, n).to_bytes(k, "big")
    digest = hashlib.sha256(signing_input).digest()
    expected = b"\x00\x01" + b"\xff" * (k - 3 - len(SHA256_PREFIX) - len(digest)) + b"\x00" + SHA256_PREFIX + digest
    return m == expected


def mint():
    tok = "00Dfixture!" + uuid.uuid4().hex
    STATE["tokens"].add(tok)
    return tok


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    # -- responses
    def send(self, status, body=None, headers=None, ctype="application/json"):
        data = b""
        if body is not None:
            data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if data:
            self.wfile.write(data)

    def err(self, status, code, message, headers=None):
        self.send(status, [{"message": message, "errorCode": code}], headers)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n).decode() if n else ""

    def limit_headers(self):
        return {"Sforce-Limit-Info": f"api-usage={STATE['api_used']}/{STATE['api_max']}"}

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_DELETE(self):
        self.route("DELETE")

    def route(self, method):
        u = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(u.query, keep_blank_values=True).items()}
        raw = self.body() if method != "GET" else ""
        with LOCK:
            try:
                self.dispatch(method, u.path, qs, raw)
            except SoqlError as e:
                self.err(400, e.code, e.message, self.limit_headers())
            except Exception as e:  # noqa: BLE001
                import traceback
                traceback.print_exc()
                self.err(500, "UNKNOWN_EXCEPTION", str(e))

    def dispatch(self, method, path, qs, raw):
        if path == "/__requests":
            return self.send(200, STATE["log"])
        if path == "/__reset":
            reset()
            return self.send(200, [{"ok": True}])
        if path == "/__config":
            cfg = json.loads(raw) if raw else {k: json.loads(v) for k, v in qs.items()}
            if "synthetic_objects" in cfg:
                fields, records = fixtures.synthetic(int(cfg["synthetic_objects"]), int(cfg.get("wide_fields", 900)))
                d = dict(fixtures.DESCRIBE_FIELDS)
                d.update(fields)
                r = dict(fixtures.RECORDS)
                r.update(records)
                STATE["org"] = Org(d, r)
            for k in ("rest_page_size", "api_used", "api_max", "expire_job_after_pages", "expire_cursor_after_pages",
                      "fail_once", "daily_limit_exhausted"):
                if k in cfg:
                    STATE[k] = cfg[k]
            return self.send(200, [{"ok": True}])
        if path == "/health":
            return self.send(200, {"ok": True})

        entry = {"method": method, "path": path, "q": qs.get("q"), "query": qs, "body": raw or None}
        if path == "/services/oauth2/token":
            STATE["log"].append({**entry, "body": None, "grant_type": parse_qs(raw).get("grant_type", [None])[0]})
            return self.token(parse_qs(raw))
        STATE["log"].append(entry)

        if not path.startswith("/services/data/v"):
            return self.err(404, "NOT_FOUND", "The requested resource does not exist")
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer ") or auth[7:] not in STATE["tokens"]:
            return self.err(401, "INVALID_SESSION_ID", "Session expired or invalid")
        if STATE["daily_limit_exhausted"]:
            return self.err(403, "REQUEST_LIMIT_EXCEEDED", "TotalRequests Limit exceeded.")
        fo = STATE["fail_once"]
        if fo and fo.get("path") in path:
            STATE["fail_once"] = None
            hdr = {"Retry-After": "1"} if fo.get("status") in (429, 503) else {}
            return self.err(fo.get("status", 503), fo.get("code", "SERVER_UNAVAILABLE"), "injected failure", hdr)
        STATE["api_used"] += 1
        parts = path.split("/")
        version = parts[3][1:]
        rest = "/".join(parts[4:])
        return self.data(method, version, rest, qs, raw)

    # -- OAuth
    def token(self, form):
        g = lambda k: form.get(k, [None])[0]  # noqa: E731
        grant = g("grant_type")
        ok = {"instance_url": f"http://127.0.0.1:{self.server.server_port}", "id": "https://login.salesforce.com/id/00D/005",
              "token_type": "Bearer", "issued_at": str(int(time.time() * 1000)), "scope": "api"}
        if grant == "urn:ietf:params:oauth:grant-type:jwt-bearer":
            try:
                h, c, s = g("assertion").split(".")
                header = json.loads(b64d(h))
                claims = json.loads(b64d(c))
            except Exception:  # noqa: BLE001
                return self.send(400, {"error": "invalid_grant", "error_description": "malformed assertion"})
            if header.get("alg") != "RS256" or not verify_rs256(f"{h}.{c}".encode(), b64d(s)):
                return self.send(400, {"error": "invalid_grant", "error_description": "invalid assertion signature"})
            if claims.get("iss") != CLIENT_ID:
                return self.send(400, {"error": "invalid_client_id", "error_description": "client identifier invalid"})
            if claims.get("sub") != USERNAME:
                return self.send(400, {"error": "invalid_grant", "error_description": "user hasn't approved this consumer"})
            if not str(claims.get("aud", "")).startswith("http"):
                return self.send(400, {"error": "invalid_grant", "error_description": "audience is invalid"})
            if int(claims.get("exp", 0)) < time.time():
                return self.send(400, {"error": "invalid_grant", "error_description": "expired authorization code"})
            return self.send(200, {**ok, "access_token": mint()})
        if grant == "client_credentials":
            if g("client_id") == CLIENT_ID and g("client_secret") == CLIENT_SECRET:
                return self.send(200, {**ok, "access_token": mint()})
            return self.send(400, {"error": "invalid_client", "error_description": "invalid client credentials"})
        if grant == "refresh_token":
            if g("client_id") == CLIENT_ID and g("refresh_token") == REFRESH_TOKEN:
                return self.send(200, {**ok, "access_token": mint()})
            return self.send(400, {"error": "invalid_grant", "error_description": "expired access/refresh token"})
        return self.send(400, {"error": "unsupported_grant_type", "error_description": "grant type not supported"})

    # -- REST + Bulk
    def data(self, method, version, rest, qs, raw):
        H = self.limit_headers()
        org = STATE["org"]
        if rest == "limits" and method == "GET":
            return self.send(200, {
                "DailyApiRequests": {"Max": STATE["api_max"], "Remaining": STATE["api_max"] - STATE["api_used"]},
                "DailyBulkV2QueryJobs": {"Max": 10000, "Remaining": 10000 - len(STATE["jobs"])},
                "DailyBulkV2QueryFileStorageMB": {"Max": 976562, "Remaining": 976562},
                "DataStorageMB": {"Max": 5, "Remaining": 4},
            }, H)
        if rest == "sobjects" and method == "GET":
            return self.send(200, describe_global(), H)
        p = rest.split("/")
        if p[0] == "sobjects" and len(p) == 3 and p[2] == "describe":
            ims = self.headers.get("If-Modified-Since")
            if ims:
                return self.send(304, None, H)
            return self.send(200, describe(p[1]), {**H, "Last-Modified": formatdate(STATE["describe_epoch"], usegmt=True)})
        if p[0] == "sobjects" and len(p) >= 3 and p[2] in ("updated", "deleted"):
            obj = org.obj(p[1])
            if "start" not in qs or "end" not in qs:
                return self.err(400, "MALFORMED_QUERY", "start and end are required")
            start = qs["start"]
            if " " in start:  # '+' decoded as space: a client that did not URL-encode
                return self.err(400, "INVALID_REPLICATION_DATE", "start date is malformed")
            if p[2] == "updated":
                return self.send(200, {"ids": fixtures.UPDATED.get(obj, []), "latestDateCovered": qs["end"].replace("+00:00", ".000+0000")}, H)
            return self.send(200, {"deletedRecords": fixtures.DELETED.get(obj, []), "earliestDateAvailable": fixtures.EARLIEST_DELETED,
                                   "latestDateCovered": qs["end"].replace("+00:00", ".000+0000")}, H)
        if p[0] in ("query", "queryAll") and len(p) == 1:
            q = Query(org, qs.get("q", ""))
            if q.compound_items() and False:
                pass
            total, rows = q.run(include_deleted=p[0] == "queryAll")
            if q.count_all:
                return self.send(200, {"totalSize": total, "done": True, "records": []}, H)
            recs = rows if q.aggregate else [render_rest(q, r) for r in rows]
            if q.aggregate:
                recs = [{"attributes": {"type": "AggregateResult"}, **r} for r in recs]
            return self.page(recs, total, 0, None, H)
        if p[0] in ("query", "queryAll") and len(p) == 2:
            cur_id, _, off = p[1].rpartition("-")
            cur = STATE["cursors"].get(cur_id)
            exp = STATE["expire_cursor_after_pages"]
            if cur is None or (exp is not None and cur["pages"] >= exp):
                STATE["cursors"].pop(cur_id, None)
                return self.err(400, "INVALID_QUERY_LOCATOR", "invalid query locator")
            cur["pages"] += 1
            return self.page(cur["records"], cur["total"], int(off), cur_id, H)
        if p[0] == "composite" and len(p) == 3 and p[1] == "sobjects" and method == "POST":
            obj = org.obj(p[2])
            body = json.loads(raw)
            ids, fields = body.get("ids") or [], body.get("fields") or []
            if len(ids) > 2000:
                return self.err(400, "INVALID_FIELD", "too many ids")
            for f in fields:
                org.field(obj, f)
            out = []
            for i in ids:
                hit = org.by_id.get(i)
                if not hit or hit[0] != obj or hit[1].get("IsDeleted"):
                    out.append(None)
                    continue
                r = hit[1]
                rec = {"attributes": attributes(obj, r)}
                for f in fields:
                    fd = org.field(obj, f)
                    rec[fd["name"]] = compound_value(org, obj, fd, r) if fd["type"] in ("address", "location") else rest_value(fd, r.get(fd["name"]))
                out.append(rec)
            return self.send(200, out, H)
        if p[0] == "jobs" and len(p) >= 2 and p[1] == "query":
            return self.jobs(method, version, p[2:], qs, raw, H)
        return self.err(404, "NOT_FOUND", "The requested resource does not exist", H)

    def page(self, records, total, offset, cur_id, H):
        size = int(STATE["rest_page_size"])
        chunk = records[offset: offset + size]
        done = offset + size >= len(records)
        body = {"totalSize": total, "done": done, "records": chunk}
        if not done:
            if cur_id is None:
                cur_id = "01g" + uuid.uuid4().hex[:15]
                STATE["cursors"][cur_id] = {"records": records, "total": total, "pages": 0}
            body["nextRecordsUrl"] = f"/services/data/v64.0/query/{cur_id}-{offset + size}"
        return self.send(200, body, H)

    def jobs(self, method, version, p, qs, raw, H):
        org = STATE["org"]
        if not p and method == "POST":
            body = json.loads(raw)
            if body.get("contentType", "CSV") != "CSV" or body.get("operation") not in ("query", "queryAll"):
                return self.err(400, "INVALIDJOB", "unsupported job settings")
            q = Query(org, body["query"])
            if q.aggregate or q.count_all:
                return self.err(400, "API_ERROR", "Aggregate queries are not supported by Bulk API 2.0")
            _, rows = q.run(include_deleted=body["operation"] == "queryAll")
            csv_text = render_csv(q, [])  # validate shape up front
            jid = "750" + uuid.uuid4().hex[:15]
            STATE["jobs"][jid] = {"id": jid, "operation": body["operation"], "object": q.obj, "createdById": fixtures.U1,
                                  "createdDate": now_utc().strftime("%Y-%m-%dT%H:%M:%S.000+0000"), "state": "UploadComplete",
                                  "apiVersion": float(version), "query": q, "rows": rows, "polls": 0, "pages": 0, "header": csv_text}
            return self.send(200, self.job_info(STATE["jobs"][jid]), H)
        if not p and method == "GET":
            recs = [{k: v for k, v in self.job_info(j).items()} for j in STATE["jobs"].values()]
            return self.send(200, {"done": True, "records": recs, "nextRecordsUrl": None}, H)
        jid = p[0]
        job = STATE["jobs"].get(jid)
        if job is None:
            return self.err(404, "NOT_FOUND", "The requested resource does not exist", H)
        if len(p) == 1 and method == "GET":
            if job["state"] == "UploadComplete":
                job["state"] = "InProgress"
            elif job["state"] == "InProgress":
                job["state"] = "JobComplete"
            return self.send(200, self.job_info(job), H)
        if len(p) == 1 and method == "DELETE":
            del STATE["jobs"][jid]
            return self.send(204, None, H)
        if len(p) == 2 and p[1] == "results" and method == "GET":
            if job["state"] != "JobComplete":
                return self.err(400, "INVALIDJOBSTATE", "job is not complete", H)
            if float(version) != job["apiVersion"]:
                return self.err(409, "INVALIDVERSION", "results must be retrieved with the job's API version", H)
            mx = int(qs.get("maxRecords") or 50000)
            loc = qs.get("locator")
            off = int(base64.b64decode(loc).decode()) if loc else 0
            chunk = job["rows"][off: off + mx]
            nxt = off + mx
            locator = base64.b64encode(str(nxt).encode()).decode() if nxt < len(job["rows"]) else "null"
            job["pages"] += 1
            exp = STATE["expire_job_after_pages"]
            if exp is not None and job["pages"] >= exp and locator != "null":
                # The job "expires" (is deleted) right after serving this page.
                del STATE["jobs"][jid]
            text = render_csv(job["query"], chunk)
            return self.send(200, text, {**H, "Sforce-Locator": locator, "Sforce-NumberOfRecords": str(len(chunk))}, "text/csv")
        return self.err(404, "NOT_FOUND", "The requested resource does not exist", H)

    @staticmethod
    def job_info(j):
        return {"id": j["id"], "operation": j["operation"], "object": j["object"], "createdById": j["createdById"],
                "createdDate": j["createdDate"], "systemModstamp": j["createdDate"], "state": j["state"],
                "concurrencyMode": "Parallel", "contentType": "CSV", "apiVersion": j["apiVersion"], "jobType": "V2Query",
                "lineEnding": "LF", "columnDelimiter": "COMMA", "numberRecordsProcessed": len(j["rows"]) if j["state"] == "JobComplete" else 0}


def main():
    port = 0
    args = sys.argv[1:]
    if "--port" in args:
        port = int(args[args.index("--port") + 1])
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"PORT:{srv.server_port}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
