<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>A Query.Farm VGI worker for DuckDB.</em></p>

# Query Salesforce CRM With SOQL Pushdown in DuckDB

> **vgi-salesforce** · a [Query.Farm](https://query.farm) VGI worker · written in TypeScript

[![CI](https://github.com/Query-farm/vgi-salesforce/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-salesforce/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

Join Salesforce to the data Salesforce reports cannot reach — product usage, billing,
support tickets in local Parquet — from plain DuckDB SQL. DuckDB filters, projections and
`ORDER BY … LIMIT` become SOQL, so a six-column query against a 900-field object fetches
six fields; large scans move to Bulk API 2.0 jobs whose `Sforce-Locator` is a resumable
cursor; column types come from the org's own describe metadata. Read-only.

## Fix your Salesforce ID joins — no org, no credentials

DuckDB joins are case-sensitive, and Salesforce hands out the same record id in two
forms: 15 case-sensitive characters (reports, exports) and 18 case-safe characters (the
API). The ID toolkit works on any downloaded export with no secret and no network:

```sql
ATTACH 'salesforce' (TYPE vgi, LOCATION '/abs/path/to/vgi-salesforce/bin/vgi-salesforce-worker');

SELECT e.opportunity_id,
       salesforce.main.id18(e.opportunity_id)      AS join_key,     -- 15 → 18, and repairs Excel-mangled case
       salesforce.main.object_of(e.opportunity_id) AS sobject       -- '006…' → 'Opportunity'
FROM read_csv('~/Downloads/report1234567.csv') e
WHERE salesforce.main.is_valid_id(e.opportunity_id);
```

| function | returns |
|---|---|
| `id18(sf_id)` | the 18-character case-safe id; an 18-character id whose letters were up/lower-cased is restored from its checksum; NULL for non-ids |
| `id15(sf_id)` | the 15-character form |
| `key_prefix(sf_id)` | the 3-character object-type prefix (`'006'`) |
| `object_of(sf_id)` | the standard object for that prefix (bundled table; custom objects → NULL, join `key_prefix` to `meta.objects`) |
| `is_valid_id(sf_id)` | checksum validation |
| `soql_literal(v)` | injection-safe SOQL string quoting, for building `where_clause` strings |

## Quick start: a connected org

1. Create a `salesforce` secret (see [Connect an org](#connect-an-org) for the connected app):

   ```sql
   CREATE SECRET crm (TYPE salesforce,
     INSTANCE_URL 'https://acme.my.salesforce.com',
     CLIENT_ID '3MVG9…', USERNAME 'integration@acme.com',
     PRIVATE_KEY getenv('SF_JWT_KEY'));
   ```

2. Attach with a small object list and browse the org:

   ```sql
   ATTACH 'salesforce' (TYPE vgi, LOCATION '…/bin/vgi-salesforce-worker', OBJECTS 'Account');
   SELECT name, label, key_prefix FROM salesforce.meta.objects WHERE queryable AND custom ORDER BY name;
   ```

3. Re-attach with the objects you want; each becomes a view in `salesforce.sobjects`:

   ```sql
   DETACH salesforce;
   ATTACH 'salesforce' (TYPE vgi, LOCATION '…/bin/vgi-salesforce-worker',
                        OBJECTS 'Account,Contact,Opportunity,Invoice__c');

   SELECT a.name, sum(o.amount) AS won
   FROM salesforce.sobjects.Opportunity o
   JOIN salesforce.sobjects.Account a ON a.id = o.account_id
   WHERE o.is_won AND o.close_date >= DATE '2026-01-01'
   GROUP BY a.name ORDER BY won DESC;
   ```

Referencing an object outside `OBJECTS` fails with a pointer, not "table does not exist":
`salesforce: object 'Campaign' is not in the ATTACH OBJECTS scope. Re-attach with OBJECTS '…,Campaign' (see salesforce.meta.objects for the full list), or query it directly with salesforce.main.query_object('Campaign').`

ATTACH options: `OBJECTS` (explicit comma-separated list — wildcards are not supported in
v1), `QUOTA_GUARD_PCT` (default 80), `STATE_DIR` (scan journal; default
`$XDG_STATE_HOME/vgi-salesforce`).

## Functions and tables

| object | what it is |
|---|---|
| `main.query_object(object_name, fields := NULL, where_clause := NULL, modified_after := NULL, modified_before := NULL, order_by := NULL, max_rows := NULL, api := 'auto', include_deleted := false, bulk_threshold := 10000, bulk_page_size := 50000, resume := false)` | one object as typed rows; the scan behind every `sobjects` view |
| `main.soql(query, api := 'auto', include_deleted := false, bulk_threshold := 10000, bulk_page_size := 50000, resume := false)` | a SOQL query with a bind-time typed result (closed grammar, below) |
| `sobjects.<Object>` | one view per `OBJECTS` entry: `query_object('<Object>')` |
| `main.lookup(sf_id, object_name := '…', fields := NULL)` | typed per-row record lookup (LATERAL), 200 ids per API call |
| `main.record(object_name, sf_id)` | per-row record as JSON (the object is a column — polymorphic `WhatId`) |
| `main.picklist_values(object_name, field_name)` | picklist values, per row or with literals |
| `main.describe_fields(object_name)` | the describe, one row per field, with the DuckDB column and type |
| `main.updated_ids(object_name, start_date, end_date)` / `main.deleted_ids(…)` | REST getUpdated / getDeleted, chunked into 30-day windows |
| `meta.objects` | describeGlobal |
| `meta.columns`, `meta.picklist_values` | the field → column map and picklists of the attached objects |
| `meta.record_types`, `meta.users`, `meta.profiles`, `meta.permission_sets`, `meta.organizations` | org metadata and access summaries |
| `meta.limits` | `/limits` plus the latest `Sforce-Limit-Info` reading |
| `meta.jobs` | Bulk API 2.0 query jobs joined with this worker's scan journal |

```sql
-- Delete-aware incremental refresh of a local replica (explicit columns: a describe-derived
-- schema gains a column the moment an admin adds a field).
DELETE FROM local_opps WHERE id IN (
  SELECT sf_id FROM salesforce.main.deleted_ids('Opportunity', now() - INTERVAL 7 DAY, now()));
INSERT INTO local_opps (id, name, amount, stage_name, close_date, system_modstamp)
SELECT id, name, amount, stage_name, close_date, system_modstamp
FROM salesforce.main.query_object('Opportunity',
       fields := ['Id', 'Name', 'Amount', 'StageName', 'CloseDate', 'SystemModstamp'],
       modified_after := (SELECT max(system_modstamp) FROM local_opps));

-- Polymorphic Task.WhatId, inner LATERAL form; non-opportunity tasks come back via UNION ALL.
WITH t AS (SELECT subject, what_id, salesforce.main.object_of(what_id) AS target
           FROM salesforce.main.soql('SELECT Subject, WhatId FROM Task'))
SELECT t.subject, o.name FROM t, LATERAL salesforce.main.lookup(t.what_id, object_name := 'Opportunity') o
UNION ALL
SELECT t.subject, NULL FROM t WHERE t.target IS DISTINCT FROM 'Opportunity';
```

The brief's `sfdc.lookup.<Object>` per-object functions are provided as the single typed
`lookup(sf_id, object_name := '<Object>')`: the object is a bind-time named argument, so the
schema is fixed at bind exactly as a per-object function's would be.

## What pushes down

Every scan re-applies the pushed predicates exactly (`autoApplyFilters`), so the SOQL only
has to return a superset; anything that cannot be expressed safely stays in DuckDB.

| SQL on a `query_object` / `sobjects` column | SOQL |
|---|---|
| projection | the SELECT list (plus `Id`, `SystemModstamp`); compound address / geolocation fields expand to their components |
| `=`, `IN` (strings, ids, picklists) | `Field = 'x'`, `Field IN (…)` — strings quoted and escaped |
| `=`, `!=`, `<`, `<=`, `>`, `>=`, `IN`, `NOT IN` on numbers, dates, datetimes, booleans | the same operator; dates `YYYY-MM-DD` and datetimes `YYYY-MM-DDThh:mm:ssZ` unquoted, booleans `TRUE`/`FALSE`; a sub-second datetime bound widens to whole seconds |
| `IS NULL` / `IS NOT NULL` | `= null` / `!= null` |
| `LIKE 'ab%'`, `starts_with`, `ends_with`, `contains` | `LIKE` with `%`/`_` escaped |
| `list_contains(multipicklist, 'x')` | `INCLUDES ('x')` |
| a bare boolean column / `NOT col` | `= TRUE` / `= FALSE` |
| `OR` of translatable predicates on one column | `( … OR … )` |
| `ORDER BY col LIMIT n` (when DuckDB passes the Top-N hint: no remaining WHERE) | `ORDER BY … NULLS … LIMIT n` |

**Not pushed, on purpose:** string `!=`, `NOT IN` and `<`/`>` ranges — SOQL compares strings
case-insensitively, so it would drop rows SQL keeps (`=` / `IN` / `LIKE` are pushed because
case-insensitive matching is a superset, and the exact comparison runs in DuckDB).
`soql()` sends your query as written; use `query_object` when you want DuckDB filters pushed.

## Types and column names

| Salesforce | DuckDB |
|---|---|
| id, reference, string, textarea, picklist, email, phone, url | `VARCHAR` |
| boolean | `BOOLEAN` · int `INTEGER` · long `BIGINT` |
| double, currency, percent | `DECIMAL(precision, scale)` from describe (`DOUBLE` when precision is 0) |
| date `DATE` · datetime `TIMESTAMPTZ` · time `TIME` | |
| multipicklist | `VARCHAR[]` |
| address | `STRUCT(street, city, state, postal_code, country, state_code, country_code, latitude DOUBLE, longitude DOUBLE, geocode_accuracy)` |
| location (geolocation) | `STRUCT(latitude DOUBLE, longitude DOUBLE)` |
| anyType, complexvalue | `JSON` |
| base64 | not exposed (blob bodies cannot be read in multi-record queries) |

Names: a trailing `__c`/`__r`/`__x`/`__b` is dropped, a managed-package namespace stays a
leading segment, camelCase and `_` split into lower snake case, relationship paths join with
`_`: `StageName` → `stage_name`, `Acme__Score__c` → `acme_score`, `Account.Owner.Name` →
`account_owner_name`. Unaliased aggregates in `soql()` are `expr0`, `expr1`, … as the API
names them; a lone `COUNT()` returns one `count` column. Collisions get `_2`, `_3` and a
warning; `meta.columns` shows the full mapping.

**`soql()` grammar (closed).** Fields; parent paths up to 5 levels; `COUNT()`, `COUNT(f)`,
`COUNT_DISTINCT(f)`, `SUM/AVG/MIN/MAX(f)`; `CALENDAR_*`, `FISCAL_*`, `DAY_ONLY`, `DAY_IN_*`,
`HOUR_IN_DAY`, `WEEK_IN_*`; `GROUPING(f)`; `FIELDS(STANDARD)`. Subqueries, `TYPEOF`,
`toLabel()`, `convertCurrency()`, `format()`, `FIELDS(ALL|CUSTOM)` are a bind error naming
the item — never a silent JSON column (use `record()` for those).

## Bulk API 2.0, cursors and resume

`api := 'auto'` runs the REST query first; when its first page reports a `totalSize` above
`bulk_threshold` (default 10,000) it discards that page and moves the scan to a Bulk API 2.0
job — so `LIMIT 5` never waits for a Bulk poll. The job is polled (1 s → 20 s backoff) until
`JobComplete`, then read `bulk_page_size` records at a time following `Sforce-Locator`.
Aggregates are REST-only.

The cursor (`nextRecordsUrl`, or job id + locator) lives in serializable scan state, so a
scan continues on any process over the HTTP transport, and is journalled per query hash in
`STATE_DIR`. `resume := true` on the same query continues an unfinished scan from its saved
locator (`meta.jobs` shows the journal).

**Expiry.** Bulk results are retrievable for 7 days after the job completes and a locator
is stable for the job's lifetime, so an expired locator is a vanished job (404); an idle
REST cursor expires with `INVALID_QUERY_LOCATOR`. `query_object` scans are ordered by
`SystemModstamp, Id`, so the worker re-submits with `SystemModstamp >= <last second>` and
drops the rows whose Id it already emitted in that second — correct under ties (tested with
a tie straddling a page boundary). A `soql()` query is resumable only when it selects `Id`
and `SystemModstamp` and orders by `SystemModstamp`; otherwise an expired cursor is a clear
error, never a silent re-read. A record modified mid-scan can appear twice (at-least-once).

## Quota safety

Every REST response's `Sforce-Limit-Info: api-usage=N/M` is recorded per org. Once usage
reaches `QUOTA_GUARD_PCT` (default 80) of the daily allowance a scan fails loudly before its
next call, instead of spending the quota the org's integrations depend on (readings older
than a minute are re-measured). The daily `REQUEST_LIMIT_EXCEEDED` is never retried;
429, 5xx and concurrent-request limits retry with backoff and `Retry-After`.

## Connect an org

**JWT bearer (recommended, no user interaction).** A 30–60 minute admin task:

1. Make a key pair and self-signed certificate:
   `openssl req -x509 -newkey rsa:2048 -nodes -keyout sf.key -out sf.crt -days 730 -subj "/CN=vgi-salesforce"`.
2. Setup → App Manager → **New Connected App** (or External Client App): enable OAuth,
   callback `http://localhost:1717/OauthRedirect`, scopes **api** and
   **refresh_token, offline_access**, tick **Use digital signatures** and upload `sf.crt`.
3. Manage → **Edit Policies**: Permitted Users = *Admin approved users are pre-authorized*;
   then add the integration user's profile or a permission set under **Manage Profiles /
   Permission Sets**.
4. Copy the **Consumer Key** (CLIENT_ID). Use a read-only integration user.
5. `CREATE SECRET (TYPE salesforce, INSTANCE_URL 'https://<domain>.my.salesforce.com', CLIENT_ID '…', USERNAME '<integration user>', PRIVATE_KEY getenv('SF_JWT_KEY'))`.
   Sandboxes add `LOGIN_URL 'https://test.salesforce.com'`.

Salesforce's own error comes back verbatim (`user hasn't approved this consumer` = step 3).
Other flows: client credentials (`CLIENT_ID` + `CLIENT_SECRET`, exchanged at the
instance URL), refresh token (`CLIENT_ID` + `REFRESH_TOKEN` [+ `CLIENT_SECRET`]), or a
pre-issued `ACCESS_TOKEN`. Username + password + security token is not supported.
`API_VERSION` pins the REST version (default `64.0`). Tokens are cached in memory and
never written to scan state or logs; a 401 re-authenticates once.

## Scale (Gate 0)

The brief made a schema-explosion spike a precondition. There is no live org here, so it was
run against a **synthetic org** served by the replay server (`synthetic_objects=N`: N custom
objects of 24 fields plus `Wide__c` with 907 fields, describe payloads in the documented
shape), with the real worker over stdio through Haybarn 2.0.1rc3 on an M-series Mac.
Re-run: `uv run --no-project --with haybarn==2.0.1rc3 --with pytz python scripts/schema_spike.py`.

| objects in `OBJECTS` | 51 | 201 | 1,501 |
|---|---|---|---|
| ATTACH wall time | 0.25 s | 0.15 s | 0.24 s |
| API calls during ATTACH | 0 | 0 | 0 |
| `SHOW TABLES FROM salesforce.sobjects` | 0.08 s | 0.07 s | 0.53 s |
| `SHOW ALL TABLES` (binds every view) | 0.51 s, 52 describes | 0.53 s, 202 describes | 12.3 s, 1,502 describes |
| first bind of a 6-column SELECT on the 907-field object | 0.040 s | 0.023 s | 0.068 s |
| cached bind of the same | 0.028 s | 0.022 s | 0.040 s |
| binding every object once (cached describes) | 0.37 s | 1.3 s | 49.7 s |
| worker RSS after every describe | 178 MB | 205 MB | 183 MB¹ |

907-field describe: 414 KB. The 6-column query sent
`SELECT Id, SystemModstamp, Name, Wide_Field_001__c, Wide_Field_002__c, Wide_Field_003__c FROM Wide__c …`.
¹ GC between samples; the 1,501 run peaked at 289 MB.

Result: the design passes at ~200 objects, so `sobjects.*` ships. Because the object views
are bound lazily (an object's describe is fetched on first use and cached for an hour),
ATTACH and `SHOW TABLES` make no API calls at any size. Two caveats, measured: anything
that lists columns of every view (`SHOW ALL TABLES`, `information_schema.columns`) costs one
describe API call per object — against a real org that is N calls and N × describe latency
(unmeasured here; the replay server answers in milliseconds); and per-bind cost grows with
the number of views (≈6 ms at 200, ≈33 ms at 1,500), which supports the brief's call that
1,000+-object orgs are not a v1 configuration.

## Install

**Prerequisites:** [Bun](https://bun.sh) 1.3+ (for a source checkout).

```bash
git clone https://github.com/Query-farm/vgi-salesforce.git && cd vgi-salesforce
bun install --frozen-lockfile
```

**DuckDB 2.0:**

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;
ATTACH 'salesforce' (TYPE vgi, LOCATION '/abs/path/to/vgi-salesforce/bin/vgi-salesforce-worker');
```

**Haybarn 2.0.1+** (`uvx haybarn-cli`; Haybarn 2.0.0 serves an older vgi extension that cannot attach this worker):

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'salesforce' (TYPE vgi, LOCATION '/abs/path/to/vgi-salesforce/bin/vgi-salesforce-worker');
```

`LOCATION` is the command DuckDB runs, so use an absolute path. `ATTACH … AS sfdc` gives the
catalog a shorter alias. Tagged releases ship signed standalone executables (no Bun needed);
point `LOCATION` at the downloaded binary. The same binary serves HTTP with
`--http --port 8000` (see the `Dockerfile`).

## Testing

```bash
make test-unit                 # bun: ID checksums (property), naming, types, SOQL grammar (fuzz), JWT, CSV
make test-sql                  # test/sql/*.test through Haybarn 2.0 (stdio)
make test-sql TRANSPORT=http   # …over HTTP (also: launch)
make check                     # everything CI runs
```

No test touches the network or a real org. `test/mock_api/server.py` is a stdlib-only
replay server of the REST and Bulk API 2.0 endpoints the worker uses, over a fixture org
(Account, Contact, Opportunity, Case, Lead, User, Task, the custom `Invoice__c` with a
namespaced field, plus metadata objects) built from documented shapes. It verifies the JWT
bearer assertion's RS256 signature, **parses and evaluates the SOQL it receives** (strictly:
a quoted date or an unknown field is an error, string comparisons are case-insensitive), so a
wrong pushdown returns wrong rows; it runs the Bulk job state machine with locator paging,
expires jobs and REST cursors on demand, injects 429/503/400 faults, reports
`Sforce-Limit-Info`, and logs every request at `/__requests` so the SQL tests assert the
exact SOQL sent. The connected-app key in `test/fixtures` is a test-only key.

The metadata check runs with `execute: false` (and `make lint-explain` with `--no-execute`):
every connected object needs a `salesforce` secret for a real org.

## Authorship & License

Written by [Query.Farm](https://query.farm). Released under the
[BSD Zero Clause License](LICENSE) (0BSD).

Copyright 2026 Query Farm LLC - https://query.farm
