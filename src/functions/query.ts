/**
 * `soql(query)` and `query_object(object_name, …)`: the two scans everything else is
 * built on (`sobjects.<Object>` views are `query_object` with the object bound).
 */

import {
  batchFromColumns,
  bool,
  defineTableFunction,
  formatPushedFilters,
  int64,
  list,
  timestampMicros,
  utf8,
  type VgiFunction,
} from "@query-farm/vgi";
import { log } from "../log.ts";
import { SalesforceError, SECRET_TYPE } from "../sf/client.ts";
import { objectColumns, resolvePath, selectList, specOf } from "../sf/columns.ts";
import { callContext } from "../sf/context.ts";
import { describeObject, fieldOf } from "../sf/describe.ts";
import { assignColumns, mangle } from "../sf/naming.ts";
import { soqlDateTime, toSoql } from "../sf/pushdown.ts";
import { initialScanState, pageColumns, Scan, type ScanPlan, type ScanState } from "../sf/scan.ts";
import { type Clause, findClauses, parseSoql, type SelectItem } from "../sf/soql_parse.ts";
import { type ColumnSpec, kindOf } from "../sf/types.ts";
import { docTags, Q, specSchema } from "./common.ts";

const API_CHOICES = ["auto", "rest", "bulk"];
const enc = new TextEncoder();
const dec = new TextDecoder();

interface BindData {
  object: string;
  columns: ColumnSpec[];
  /** soql(): the rewritten query; query_object(): unused. */
  soql?: string;
  aggregate?: boolean;
  countOnly?: boolean;
  resumable?: boolean;
  clauses?: Clause[];
  restStart?: number;
  hasModstamp?: boolean;
}

const encodeBind = (b: BindData) => enc.encode(JSON.stringify(b));
const decodeBind = (u: Uint8Array | null | undefined): BindData => {
  if (!u?.length) throw new SalesforceError("salesforce: missing bind data (re-run the query)");
  return JSON.parse(dec.decode(u)) as BindData;
};

/** Run the scan loop shared by both functions. */
async function runScan(
  plan: ScanPlan,
  ctx: ReturnType<typeof callContext>,
  state: ScanState,
  columns: ColumnSpec[],
  // biome-ignore lint/suspicious/noExplicitAny: SDK output collector / schema types.
  out: any,
  // biome-ignore lint/suspicious/noExplicitAny: SDK output schema type.
  outputSchema: any,
): Promise<void> {
  const scan = new Scan(ctx.cfg, plan, state);
  const byColumn = new Map(columns.map((c) => [c.column, c]));
  const names: string[] = outputSchema.fields.map((f: { name: string }) => f.name);
  try {
    for (;;) {
      const page = await scan.step();
      if (!page) {
        out.finish();
        return;
      }
      if (page.rows.length) {
        out.emit(batchFromColumns(pageColumns(page, names, byColumn), outputSchema));
        return;
      }
    }
  } catch (err) {
    scan.fail(err);
    throw err;
  }
}

// ------------------------------------------------------------------- query_object

interface QueryObjectArgs {
  object_name: string;
  fields: string[] | null;
  where_clause: string | null;
  modified_after: bigint | null;
  modified_before: bigint | null;
  order_by: string | null;
  max_rows: bigint | null;
  api: string;
  include_deleted: boolean;
  bulk_threshold: bigint;
  resume: boolean;
}

/** The SOQL for one query_object scan. */
export function buildObjectSoql(opts: {
  object: string;
  select: string[];
  conditions: string[];
  orderBy: string | null;
  limit: number | null;
}): string {
  let q = `SELECT ${opts.select.join(", ")} FROM ${opts.object}`;
  if (opts.conditions.length) q += ` WHERE ${opts.conditions.join(" AND ")}`;
  if (opts.orderBy) q += ` ORDER BY ${opts.orderBy}`;
  if (opts.limit !== null) q += ` LIMIT ${opts.limit}`;
  return q;
}

export const queryObject: VgiFunction = defineTableFunction<QueryObjectArgs, ScanState>({
  name: "query_object",
  description:
    "Rows of one Salesforce object, typed from its describe, with SQL filters, projection and LIMIT pushed into SOQL",
  args: {
    object_name: utf8(),
    fields: list(utf8()),
    where_clause: utf8(),
    modified_after: timestampMicros("UTC"),
    modified_before: timestampMicros("UTC"),
    order_by: utf8(),
    max_rows: int64(),
    api: utf8(),
    include_deleted: bool,
    bulk_threshold: int64(),
    resume: bool,
  } as never,
  argDefaults: {
    fields: null,
    where_clause: null,
    modified_after: null,
    modified_before: null,
    order_by: null,
    max_rows: null,
    api: "auto",
    include_deleted: false,
    bulk_threshold: 10000,
    resume: false,
  },
  argDocs: {
    object_name: "Object API name, e.g. 'Opportunity' or 'Invoice__c'.",
    fields:
      "Fields or parent paths to return (e.g. ['Id','Name','Account.Name']); NULL returns every field. Columns are named by the mangling rule (see meta.columns).",
    where_clause: "Optional raw SOQL condition ANDed into the WHERE clause, e.g. 'IsWon = TRUE'.",
    modified_after: "Only rows with SystemModstamp >= this instant (incremental extracts).",
    modified_before: "Only rows with SystemModstamp < this instant.",
    order_by:
      "Optional SOQL ORDER BY text, e.g. 'CloseDate DESC'. Disables locator-expiry resume (which needs SystemModstamp order).",
    max_rows: "Optional SOQL LIMIT.",
    api: "'auto' (REST, switching to Bulk API 2.0 above bulk_threshold rows), 'rest' or 'bulk'.",
    include_deleted: "Include soft-deleted and archived rows (queryAll / Bulk queryAll).",
    bulk_threshold: "In api 'auto', the totalSize above which the scan moves to a Bulk API 2.0 job.",
    resume: "Continue an unfinished journalled scan of the same query from its saved Bulk job + locator.",
  },
  argConstraints: {
    api: { choices: API_CHOICES },
    bulk_threshold: { ge: 0 },
    max_rows: { ge: 0 },
  } as never,
  requiredSecrets: [SECRET_TYPE],
  projectionPushdown: true,
  filterPushdown: true,
  autoApplyFilters: true,
  onBind: async (params) => {
    const ctx = callContext(params.secrets, params.bindCall.attach_opaque_data);
    const d = await describeObject(ctx.cfg, params.args.object_name);
    const { columns, warnings } = await objectColumns(ctx.cfg, d, params.args.fields);
    for (const w of warnings) log.warn(w);
    return {
      outputSchema: specSchema(columns),
      opaqueData: encodeBind({ object: d.name, columns, hasModstamp: !!fieldOf(d, "SystemModstamp") }),
    };
  },
  initialState: () => initialScanState(),
  process: async (params, state, out) => {
    const bind = decodeBind(params.initCall.bind_opaque_data);
    const ctx = callContext(params.secrets, params.initCall.bind_call.attach_opaque_data);
    const a = params.args;
    const projected = new Set(params.outputSchema.fields.map((f) => f.name));
    const cols = bind.columns.filter((c) => projected.has(c.column));
    const tr = toSoql(params.pushdownFilters, bind.columns);
    log.debug(
      `query_object(${bind.object}): pushed ${formatPushedFilters(params.pushdownFilters)} → ${tr.conditions.join(" AND ")}`,
    );
    const conditions: string[] = [];
    if (a.where_clause?.trim()) conditions.push(`(${a.where_clause.trim()})`);
    conditions.push(...tr.conditions);
    if (a.modified_after != null) conditions.push(`SystemModstamp >= ${soqlDateTime(BigInt(a.modified_after))}`);
    if (a.modified_before != null) conditions.push(`SystemModstamp < ${soqlDateTime(BigInt(a.modified_before))}`);

    // ORDER BY / LIMIT: the explicit arguments, else DuckDB's Top-N hint when every
    // pushed predicate translated exactly (so the SOQL LIMIT cannot drop a matching row).
    let orderBy = a.order_by?.trim() || null;
    let limit = a.max_rows != null ? Number(a.max_rows) : null;
    const hintCol = params.initCall.order_by_column_name;
    const hintLimit = params.initCall.order_by_limit;
    if (!orderBy && limit === null && hintCol && hintLimit != null && tr.exact && !a.where_clause) {
      const c = bind.columns.find((x) => x.column === hintCol);
      if (c?.filterable && c.kind !== "multipicklist") {
        const dir = params.initCall.order_by_direction === "DESC" ? "DESC" : "ASC";
        const nulls = params.initCall.order_by_null_order === "NULLS_FIRST" ? "NULLS FIRST" : "NULLS LAST";
        orderBy = `${c.sfPath} ${dir} ${nulls}`;
        limit = Number(hintLimit);
      }
    }
    const resumable = !orderBy && limit === null && bind.hasModstamp === true;
    const extras = ["Id", ...(bind.hasModstamp ? ["SystemModstamp"] : [])];
    const select = selectList(cols, extras);
    const build = (extra: string[]) =>
      buildObjectSoql({
        object: bind.object,
        select,
        conditions: [...conditions, ...extra],
        orderBy: orderBy ?? (resumable ? "SystemModstamp ASC, Id ASC" : null),
        limit,
      });
    const plan: ScanPlan = {
      soql: build([]),
      object: bind.object,
      columns: cols,
      api: a.api as ScanPlan["api"],
      includeDeleted: !!a.include_deleted,
      aggregate: false,
      countOnly: false,
      resumeQuery: resumable ? (since) => build([`SystemModstamp >= ${since}`]) : null,
      bulkThreshold: Number(a.bulk_threshold ?? 10000),
      bulkPageSize: 50_000,
      stateDir: ctx.stateDir,
      resume: !!a.resume,
    };
    if (state.phase === "start") log.debug(`query_object: ${plan.soql}`);
    await runScan(plan, ctx, state, cols, out, params.outputSchema);
  },
  tags: docTags({
    title: "Query a Salesforce Object",
    category: "query",
    keywords: "salesforce, soql, sobject, query, crm, records, bulk api, pushdown, incremental, systemmodstamp",
    docLlm:
      "query_object(object_name, fields := NULL, where_clause := NULL, modified_after := NULL, modified_before := NULL, " +
      "order_by := NULL, max_rows := NULL, api := 'auto', include_deleted := false, bulk_threshold := 10000, resume := false) " +
      "returns the rows of one Salesforce object (Account, Opportunity, Invoice__c …) with one typed column per field, " +
      "named lower snake case (StageName → stage_name, Acme__Score__c → acme_score, Account.Name → account_name). " +
      "Types come from describe: ids/strings VARCHAR, currency/percent/double DECIMAL(p,s), date DATE, datetime TIMESTAMPTZ, " +
      "boolean BOOLEAN, multipicklist VARCHAR[], address/geolocation STRUCT. WHERE filters on columns become SOQL WHERE " +
      "(=, IN, IS NULL, numeric/date/datetime ranges, LIKE prefixes/contains); only the selected columns are fetched; " +
      "modified_after/modified_before bound SystemModstamp for incremental loads. Use the sobjects.<Object> views for the same thing " +
      "as a table. Needs a salesforce secret.",
    docMd:
      "## query_object(object_name, …)\n\nOne Salesforce object as typed rows. See the README for the full pushdown table.\n\n" +
      "**Pushdown:** projection → SOQL SELECT list; `=`/`IN`/`IS [NOT] NULL` on any filterable field, numeric/date/datetime " +
      "ranges, `LIKE 'x%'`/`starts_with`/`contains` → SOQL WHERE (string `!=`/ranges are re-applied locally because SOQL " +
      "compares strings case-insensitively); `ORDER BY … LIMIT n` → SOQL when every filter translated exactly.\n\n" +
      "**Resume:** scans are ordered by SystemModstamp, Id, so an expired Bulk job or REST cursor is recovered with " +
      "`SystemModstamp >= last` plus Id de-duplication.",
  }),
  examples: [
    {
      sql: `SELECT stage_name, count(*) AS deals, sum(amount) AS pipeline FROM ${Q}.query_object('Opportunity', fields := ['StageName', 'Amount']) WHERE NOT is_closed GROUP BY stage_name ORDER BY pipeline DESC`,
      description: "Open pipeline by stage (only StageName and Amount are fetched)",
    },
    {
      sql: `SELECT id, name, system_modstamp FROM ${Q}.query_object('Account', fields := ['Id', 'Name', 'SystemModstamp'], modified_after := TIMESTAMPTZ '2026-01-01 00:00:00+00') ORDER BY system_modstamp`,
      description: "Incremental extract: accounts changed since a watermark",
    },
  ],
});

// --------------------------------------------------------------------------- soql

interface SoqlArgs {
  query: string;
  api: string;
  include_deleted: boolean;
  bulk_threshold: bigint;
  resume: boolean;
}

/** Bind a SOQL query against the closed grammar: typed columns + the query to send. */
export async function bindSoql(
  cfg: Parameters<typeof describeObject>[0],
  query: string,
): Promise<{ bind: BindData; warnings: string[] }> {
  const parsed = parseSoql(query);
  const root = await describeObject(cfg, parsed.object);
  const specs: (ColumnSpec & { explicit?: string })[] = [];
  const selectParts: string[] = [];
  let expr = 0;
  const addField = async (path: string) => {
    const r = await resolvePath(cfg, root, path);
    const s = specOf(r, "");
    if (!s)
      throw new SalesforceError(`soql: field '${path}' (${r.field.type}) cannot be selected in a multi-record query`);
    if (parsed.aggregate) {
      if (s.kind === "address" || s.kind === "location")
        throw new SalesforceError(`soql: compound field '${path}' cannot be grouped`);
      // Aggregate results key a grouped field by its last segment.
      specs.push({ ...s, sfPath: r.field.name, select: [s.sfPath], explicit: mangle(r.sfPath) });
    } else specs.push(s);
    selectParts.push(...s.select);
  };
  const keyOf = (item: { alias?: string }) => item.alias ?? `expr${expr++}`;
  const aggSpec = (item: SelectItem, kind: ColumnSpec["kind"], base: Partial<ColumnSpec>, key: string): ColumnSpec => ({
    column: "",
    sfPath: key,
    kind,
    precision: 0,
    scale: 0,
    select: [],
    sfType: "aggregate",
    filterable: false,
    nillable: true,
    label: item.text,
    ...base,
  });
  for (const item of parsed.items) {
    switch (item.kind) {
      case "field":
        await addField(item.path);
        break;
      case "fields_standard":
        for (const f of root.fields) if (!f.custom && kindOf(f)) await addField(f.name);
        break;
      case "count_all":
        specs.push({ ...aggSpec(item, "long", {}, "__count"), explicit: item.alias ?? "count" });
        selectParts.push("COUNT()");
        break;
      case "agg": {
        const r = await resolvePath(cfg, root, item.path);
        const k = kindOf(r.field);
        const key = keyOf(item);
        let spec: ColumnSpec;
        if (item.fn === "COUNT" || item.fn === "COUNT_DISTINCT") spec = aggSpec(item, "long", {}, key);
        else if (item.fn === "SUM" || item.fn === "AVG") spec = aggSpec(item, "double", {}, key);
        else if (k && k !== "address" && k !== "location") {
          spec = aggSpec(item, k, { precision: r.field.precision, scale: r.field.scale, sfType: r.field.type }, key);
        } else throw new SalesforceError(`soql: ${item.fn}(${item.path}) is not supported for a ${r.field.type} field`);
        specs.push({ ...spec, explicit: item.alias ?? key });
        selectParts.push(`${item.fn}(${r.sfPath})${item.alias ? ` ${item.alias}` : ""}`);
        break;
      }
      case "datefn": {
        const r = await resolvePath(cfg, root, item.path);
        if (r.field.type !== "date" && r.field.type !== "datetime") {
          throw new SalesforceError(
            `soql: ${item.fn}() needs a date or datetime field; ${item.path} is ${r.field.type}`,
          );
        }
        const key = keyOf(item);
        specs.push({ ...aggSpec(item, item.fn === "DAY_ONLY" ? "date" : "int", {}, key), explicit: item.alias ?? key });
        selectParts.push(`${item.fn}(${r.sfPath})${item.alias ? ` ${item.alias}` : ""}`);
        break;
      }
      case "grouping": {
        const r = await resolvePath(cfg, root, item.path);
        const key = keyOf(item);
        specs.push({ ...aggSpec(item, "int", {}, key), explicit: item.alias ?? key });
        selectParts.push(`GROUPING(${r.sfPath})${item.alias ? ` ${item.alias}` : ""}`);
        break;
      }
    }
  }
  const { columns: names, warnings } = assignColumns(
    specs.map((s) => s.sfPath),
    specs.map((s) => s.explicit),
  );
  const columns: ColumnSpec[] = specs.map(({ explicit: _e, ...s }, i) => ({
    ...s,
    column: (names[i] as { column: string }).column,
  }));
  const seen = new Set<string>();
  const select = selectParts.filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const rest = parsed.rest.trim();
  const soql = `SELECT ${select.join(", ")} FROM ${root.name}${rest ? ` ${rest}` : ""}`;
  // Resumable = selects Id + SystemModstamp at the top level and orders by SystemModstamp first.
  const top = new Set(columns.filter((c) => !c.sfPath.includes(".")).map((c) => c.sfPath.toLowerCase()));
  const clauses = findClauses(rest);
  const order = clauses.find((c) => c.keyword === "ORDER BY");
  const orderText = order ? rest.slice(order.start + 8).trim() : "";
  const resumable =
    !parsed.aggregate &&
    top.has("id") &&
    top.has("systemmodstamp") &&
    /^SystemModstamp(\s+ASC)?\s*(,\s*Id(\s+ASC)?)?\s*($|LIMIT\b|OFFSET\b|FOR\b|$)/i.test(orderText) &&
    !clauses.some((c) => c.keyword === "LIMIT" || c.keyword === "OFFSET");
  return {
    bind: {
      object: root.name,
      columns,
      soql,
      aggregate: parsed.aggregate,
      countOnly: parsed.items.length === 1 && parsed.items[0]?.kind === "count_all",
      resumable,
      clauses,
      restStart: soql.length - rest.length,
    },
    warnings,
  };
}

/** Insert `cond` into a bound query's WHERE clause (for locator-expiry resume). */
export function withCondition(bind: BindData, cond: string): string {
  const q = bind.soql as string;
  const start = bind.restStart ?? q.length;
  const rest = q.slice(start);
  const clauses = bind.clauses ?? [];
  const where = clauses.find((c) => c.keyword === "WHERE");
  if (where) {
    const next = clauses.find((c) => c.start > where.start);
    const body = rest.slice(where.start + 5, next ? next.start : rest.length).trim();
    const tail = next ? rest.slice(next.start) : "";
    return `${q.slice(0, start)}WHERE (${cond}) AND (${body})${tail ? ` ${tail}` : ""}`;
  }
  const first = clauses[0];
  if (!first) return `${q} WHERE ${cond}`;
  return `${q.slice(0, start)}WHERE ${cond} ${rest.slice(first.start)}`;
}

export const soql: VgiFunction = defineTableFunction<SoqlArgs, ScanState>({
  name: "soql",
  description:
    "Run a SOQL query; the result is typed at bind time from the select list and the org's describe metadata",
  args: { query: utf8(), api: utf8(), include_deleted: bool, bulk_threshold: int64(), resume: bool } as never,
  argDefaults: { api: "auto", include_deleted: false, bulk_threshold: 10000, resume: false },
  argDocs: {
    query:
      "A SOQL query. Select items: fields, parent paths (Account.Owner.Name), COUNT(), COUNT/COUNT_DISTINCT/SUM/AVG/MIN/MAX(f), " +
      "date functions (CALENDAR_YEAR(f) …), GROUPING(f), FIELDS(STANDARD). Anything else is a bind error.",
    api: "'auto' (REST, switching to Bulk API 2.0 above bulk_threshold rows), 'rest' or 'bulk'. Aggregates are REST-only.",
    include_deleted: "Include soft-deleted and archived rows (queryAll).",
    bulk_threshold: "In api 'auto', the totalSize above which the scan moves to a Bulk API 2.0 job.",
    resume: "Continue an unfinished journalled scan of the same query from its saved Bulk job + locator.",
  },
  argConstraints: { api: { choices: API_CHOICES }, bulk_threshold: { ge: 0 } } as never,
  requiredSecrets: [SECRET_TYPE],
  onBind: async (params) => {
    const ctx = callContext(params.secrets, params.bindCall.attach_opaque_data);
    const { bind, warnings } = await bindSoql(ctx.cfg, params.args.query);
    if (bind.aggregate && params.args.api === "bulk") {
      throw new SalesforceError("soql: aggregate queries cannot run as Bulk API 2.0 jobs; use api := 'rest' or 'auto'");
    }
    for (const w of warnings) log.warn(w);
    return { outputSchema: specSchema(bind.columns), opaqueData: encodeBind(bind) };
  },
  initialState: () => initialScanState(),
  process: async (params, state, out) => {
    const bind = decodeBind(params.initCall.bind_opaque_data);
    const ctx = callContext(params.secrets, params.initCall.bind_call.attach_opaque_data);
    const a = params.args;
    const plan: ScanPlan = {
      soql: bind.soql as string,
      object: bind.object,
      columns: bind.columns,
      api: a.api as ScanPlan["api"],
      includeDeleted: !!a.include_deleted,
      aggregate: !!bind.aggregate,
      countOnly: !!bind.countOnly,
      resumeQuery: bind.resumable ? (since) => withCondition(bind, `SystemModstamp >= ${since}`) : null,
      bulkThreshold: Number(a.bulk_threshold ?? 10000),
      bulkPageSize: 50_000,
      stateDir: ctx.stateDir,
      resume: !!a.resume,
    };
    await runScan(plan, ctx, state, bind.columns, out, params.outputSchema);
  },
  tags: docTags({
    title: "Run a SOQL Query",
    category: "query",
    keywords: "salesforce, soql, query, aggregate, group by, relationship, bulk api 2.0, typed",
    docLlm:
      "soql(query, api := 'auto', include_deleted := false, bulk_threshold := 10000, resume := false) runs SOQL and returns " +
      "typed columns derived at bind time from the SELECT list and describe metadata. Columns: fields mangled to snake case " +
      "(Account.Owner.Name → account_owner_name); aggregates by alias (SUM(Amount) total → total) or expr0, expr1 …; " +
      "COUNT() alone → one row with column count. Supported select items: fields, parent paths up to 5 levels, COUNT(), " +
      "COUNT/COUNT_DISTINCT/SUM/AVG/MIN/MAX, CALENDAR_/FISCAL_/DAY_ date functions, GROUPING, FIELDS(STANDARD). " +
      "Subqueries, TYPEOF, toLabel(), convertCurrency() and FIELDS(ALL) are rejected at bind. Use query_object or the " +
      "sobjects views when you want DuckDB filters pushed down; soql() sends your query as written. Needs a salesforce secret.",
    docMd:
      "## soql(query, …)\n\nRuns a SOQL query with a typed result. The select list is parsed against a closed grammar " +
      "(fields, parent paths, aggregates, date functions, `FIELDS(STANDARD)`); anything else is a bind error naming the item.",
  }),
  examples: [
    {
      sql: `SELECT * FROM ${Q}.soql('SELECT StageName, COUNT(Id) deals, SUM(Amount) total FROM Opportunity GROUP BY StageName') ORDER BY total DESC`,
      description: "Pipeline by stage, aggregated by Salesforce",
    },
    {
      sql: `SELECT name, account_name, account_owner_name FROM ${Q}.soql('SELECT Name, Account.Name, Account.Owner.Name FROM Contact WHERE Email != null') ORDER BY name`,
      description: "Contacts with their account and the account owner (relationship paths flatten to columns)",
    },
  ],
});
