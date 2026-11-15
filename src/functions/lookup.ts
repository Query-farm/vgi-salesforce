/**
 * Blended (per-row, LATERAL-capable) functions: `record()`, `lookup()` and
 * `picklist_values()`. DuckDB hands each call a batch of input rows; ids are
 * de-duplicated per object and fetched 200 at a time with the sObject Collections
 * retrieve (`POST composite/sobjects/{object}` with `ids` + `fields`), so a LATERAL over
 * 10,000 rows costs ~50 API calls, not 10,000. Results are cached in-process for 300 s
 * keyed by (instance_url, object, id).
 *
 * Use the inner LATERAL / comma form: `FROM t, LATERAL salesforce.main.lookup(t.what_id, object_name := 'Opportunity')`.
 */

import {
  batchFromColumns,
  bool,
  defineRowTransformFunction,
  list,
  parentRowsMetadata,
  schema,
  utf8,
  type VgiBatch,
  type VgiFunction,
} from "@query-farm/vgi";
import { column } from "../meta.ts";
import { SalesforceError, SECRET_TYPE, type SfConfig, sfJson } from "../sf/client.ts";
import { objectColumns, selectList } from "../sf/columns.ts";
import { callContext } from "../sf/context.ts";
import { describeObject, fieldOf } from "../sf/describe.ts";
import { id18 } from "../sf/ids.ts";
import { atPath, type ColumnSpec, kindOf, readColumn } from "../sf/types.ts";
import { docTags, jsonField, Q, specSchema } from "./common.ts";

export const RECORD_TTL_MS = 300_000;
const CHUNK = 200;
const cache = new Map<string, { rec: Record<string, unknown> | null; at: number }>();
export const lookupStats = { calls: 0, ids: 0 };

export function clearRecordCache(): void {
  cache.clear();
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Fetch records by id (deduplicated, chunked, cached). Missing ids map to null. */
export async function fetchRecords(
  cfg: SfConfig,
  object: string,
  ids: string[],
  fields: string[],
): Promise<Map<string, Record<string, unknown> | null>> {
  const out = new Map<string, Record<string, unknown> | null>();
  const fkey = fields.join(",");
  const todo: string[] = [];
  for (const id of new Set(ids)) {
    const hit = cache.get(`${cfg.instanceUrl}|${object}|${fkey}|${id}`);
    if (hit && Date.now() - hit.at < RECORD_TTL_MS) out.set(id, hit.rec);
    else todo.push(id);
  }
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    lookupStats.calls++;
    lookupStats.ids += chunk.length;
    const res = await sfJson<(Record<string, unknown> | null)[]>(cfg, `composite/sobjects/${object}`, {
      method: "POST",
      body: { ids: chunk, fields },
    });
    chunk.forEach((id, j) => {
      const rec = res?.[j] ?? null;
      out.set(id, rec);
      cache.set(`${cfg.instanceUrl}|${object}|${fkey}|${id}`, { rec, at: Date.now() });
    });
  }
  return out;
}

const strings = (b: VgiBatch, name: string): (string | null)[] =>
  Array.from({ length: b.numRows }, (_, i) => {
    const v = b.getChild(name)?.get(i);
    return v == null ? null : String(v);
  });

/** Normalize an input id for the API: 18-character form, or null if not an id. */
const normId = (v: string | null) => (v == null ? null : id18(v));

// ------------------------------------------------------------------------- record

export const record: VgiFunction = defineRowTransformFunction<Record<string, never>>({
  name: "record",
  description: "Fetch whole records as JSON by (object, id), batched 200 ids per API call",
  args: { object_name: utf8(), sf_id: utf8() },
  argDocs: {
    object_name: "Object API name of the record, e.g. the result of object_of(what_id).",
    sf_id: "Record id (15 or 18 characters).",
  },
  requiredSecrets: [SECRET_TYPE],
  onBind: () => ({
    outputSchema: schema([
      column("object_name", utf8(), "The object API name passed in."),
      column("sf_id", utf8(), "The 18-character record id."),
      jsonField("doc", "Every readable field of the record as JSON (NULL when no such record is visible)."),
    ]),
  }),
  process: async (params, batch, out) => {
    const ctx = callContext(params.secrets, params.initCall.bind_call.attach_opaque_data);
    const objs = strings(batch, "object_name");
    const ids = strings(batch, "sf_id").map(normId);
    const byObject = new Map<string, string[]>();
    objs.forEach((o, i) => {
      const id = ids[i];
      if (o && id) byObject.set(o, [...(byObject.get(o) ?? []), id]);
    });
    const recs = new Map<string, Map<string, Record<string, unknown> | null>>();
    for (const [o, list] of byObject) {
      const d = await describeObject(ctx.cfg, o);
      const fields = d.fields.filter(
        (f) => kindOf(f) && !f.compoundFieldName && f.type !== "address" && f.type !== "location",
      );
      recs.set(
        o,
        await fetchRecords(
          ctx.cfg,
          d.name,
          list,
          fields.map((f) => f.name),
        ),
      );
    }
    const rows: number[] = [];
    const cols: Record<string, unknown[]> = { object_name: [], sf_id: [], doc: [] };
    objs.forEach((o, i) => {
      const id = ids[i];
      if (!o || !id) return;
      const rec = recs.get(o)?.get(id) ?? null;
      let doc: string | null = null;
      if (rec) {
        const { attributes: _a, ...rest } = rec;
        doc = JSON.stringify(rest);
      }
      rows.push(i);
      cols.object_name?.push(o);
      cols.sf_id?.push(id);
      cols.doc?.push(doc);
    });
    out.emit(batchFromColumns(cols, params.outputSchema), parentRowsMetadata(rows, rows.length));
  },
  tags: docTags({
    columns: [
      { name: "object_name", type: "VARCHAR", description: "The object API name passed in." },
      { name: "sf_id", type: "VARCHAR", description: "The 18-character record id." },
      {
        name: "doc",
        type: "JSON",
        description: "Every readable field of the record (NULL when no such record is visible).",
      },
    ],
    title: "Fetch Records as JSON",
    category: "lookup",
    keywords: "salesforce, record, lateral, enrichment, polymorphic, whatid, json, batch",
    docLlm:
      "record(object_name, sf_id) is a per-row (LATERAL) function returning object_name, sf_id and doc (JSON of every " +
      "readable field) for each input row. The object is a column, so it suits polymorphic ids: " +
      "FROM tasks t, LATERAL salesforce.main.record(salesforce.main.object_of(t.what_id), t.what_id) r. Ids are deduplicated " +
      "and fetched 200 per API call, cached 300 s. For typed columns of a known object use lookup(sf_id, object_name := '…').",
    docMd:
      "## record(object_name, sf_id)\n\nPer-row record fetch as JSON (the object is a runtime column, so the result cannot be typed). " +
      "Use the inner LATERAL / comma form.",
  }),
  examples: [
    {
      sql: `SELECT r.doc->>'StageName' AS stage FROM (VALUES ('006Dn000001aBcD')) t(what_id), LATERAL ${Q}.record(${Q}.object_of(t.what_id), t.what_id) r`,
      description: "Resolve a polymorphic WhatId to its record",
    },
  ],
});

// ------------------------------------------------------------------------- lookup

interface LookupArgs {
  object_name: string;
  fields: string[] | null;
}

interface LookupBind {
  object: string;
  columns: ColumnSpec[];
}

export const lookup: VgiFunction = defineRowTransformFunction<LookupArgs>({
  name: "lookup",
  description: "Typed per-row record lookup by id for one object (fixed at bind), batched 200 ids per API call",
  args: { sf_id: utf8() },
  namedArgs: { object_name: utf8(), fields: list(utf8()) as never },
  argDefaults: { fields: null },
  argDocs: {
    sf_id: "Record id (15 or 18 characters); rows whose id is not a visible record produce no output.",
    object_name: "Object API name; fixes the typed output columns at bind (required).",
    fields: "Fields to return (direct fields only, no relationship paths); NULL returns every field.",
  },
  requiredSecrets: [SECRET_TYPE],
  onBind: async (params) => {
    const o = params.args.object_name;
    if (!o) throw new SalesforceError("salesforce: lookup needs object_name := '<Object>'");
    const ctx = callContext(params.secrets, params.bindCall.attach_opaque_data);
    const d = await describeObject(ctx.cfg, o);
    if (params.args.fields?.some((f) => f.includes("."))) {
      throw new SalesforceError(
        "salesforce: lookup fields must be direct fields of the object (no relationship paths)",
      );
    }
    const { columns } = await objectColumns(ctx.cfg, d, params.args.fields);
    const bind: LookupBind = { object: d.name, columns };
    return { outputSchema: specSchema(columns), opaqueData: enc.encode(JSON.stringify(bind)) };
  },
  process: async (params, batch, out) => {
    const bind = JSON.parse(dec.decode(params.initCall.bind_opaque_data ?? new Uint8Array())) as LookupBind;
    const ctx = callContext(params.secrets, params.initCall.bind_call.attach_opaque_data);
    const ids = strings(batch, "sf_id").map(normId);
    const projected = new Set(params.outputSchema.fields.map((f) => f.name));
    const cols = bind.columns.filter((c) => projected.has(c.column));
    const fields = selectList(cols, ["Id"]);
    const recs = await fetchRecords(
      ctx.cfg,
      bind.object,
      ids.filter((x): x is string => !!x),
      fields,
    );
    const rows: number[] = [];
    const found: Record<string, unknown>[] = [];
    ids.forEach((id, i) => {
      const rec = id ? recs.get(id) : null;
      if (rec) {
        rows.push(i);
        found.push(rec);
      }
    });
    const data: Record<string, unknown[]> = {};
    for (const f of params.outputSchema.fields) {
      const c = cols.find((x) => x.column === f.name);
      data[f.name] = found.map((r) => (c ? readColumn(c, (p) => atPath(r, p)) : null));
    }
    out.emit(batchFromColumns(data, params.outputSchema), parentRowsMetadata(rows, rows.length));
  },
  tags: docTags({
    dynamicColumns: true,
    title: "Typed Record Lookup",
    category: "lookup",
    keywords: "salesforce, lookup, lateral, enrichment, join, typed, batch, cache",
    docLlm:
      "lookup(sf_id, object_name := 'Opportunity', fields := NULL) is a per-row (LATERAL) function: for each input id " +
      "it returns that record's typed columns (same names and types as query_object / sobjects views). The object is a " +
      "bind-time named argument, so the schema is fixed: FROM tasks t, LATERAL salesforce.main.lookup(t.what_id, " +
      "object_name := 'Opportunity') o. Ids that are not records of that object produce no row (inner semantics; " +
      "UNION ALL the rest back if you need them). 200 ids per API call, cached 300 s.",
    docMd:
      "## lookup(sf_id, object_name := …, fields := NULL)\n\nThe typed sibling of `record()`: the object is fixed at bind, " +
      "so columns are real types. Inner LATERAL form only.",
  }),
  examples: [
    {
      sql: `SELECT t.subject, o.name, o.amount FROM (VALUES ('Call', '006Dn000001aBcD')) t(subject, what_id), LATERAL ${Q}.lookup(t.what_id, object_name := 'Opportunity', fields := ['Name', 'Amount']) o`,
      description: "Enrich tasks with their opportunity's name and amount",
    },
  ],
});

// ---------------------------------------------------------------- picklist_values

export const picklistValues: VgiFunction = defineRowTransformFunction<Record<string, never>>({
  name: "picklist_values",
  description: "The picklist values of (object, field) pairs, one row per value, from describe",
  args: { object_name: utf8(), field_name: utf8() },
  argDocs: { object_name: "Object API name.", field_name: "Picklist or multi-select picklist field API name." },
  requiredSecrets: [SECRET_TYPE],
  onBind: () => ({
    outputSchema: schema([
      column("value", utf8(), "API value stored on records.", false),
      column("label", utf8(), "Display label."),
      column("active", bool as never, "Whether the value can be chosen."),
      column("default_value", bool as never, "Whether it is the field's default."),
    ]),
  }),
  process: async (params, batch, out) => {
    const ctx = callContext(params.secrets, params.initCall.bind_call.attach_opaque_data);
    const objs = strings(batch, "object_name");
    const flds = strings(batch, "field_name");
    const rows: number[] = [];
    const cols: Record<string, unknown[]> = { value: [], label: [], active: [], default_value: [] };
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      const f = flds[i];
      if (!o || !f) continue;
      const d = await describeObject(ctx.cfg, o);
      const field = fieldOf(d, f);
      if (!field) throw new SalesforceError(`salesforce: ${d.name} has no field '${f}'`);
      for (const p of field.picklistValues ?? []) {
        rows.push(i);
        cols.value?.push(p.value);
        cols.label?.push(p.label);
        cols.active?.push(p.active);
        cols.default_value?.push(p.defaultValue);
      }
    }
    out.emit(batchFromColumns(cols, params.outputSchema), parentRowsMetadata(rows, rows.length));
  },
  tags: docTags({
    columns: [
      { name: "value", type: "VARCHAR", description: "API value stored on records." },
      { name: "label", type: "VARCHAR", description: "Display label." },
      { name: "active", type: "BOOLEAN", description: "Whether the value can be chosen." },
      { name: "default_value", type: "BOOLEAN", description: "Whether it is the field's default." },
    ],
    title: "Field Picklist Values",
    category: "metadata",
    keywords: "salesforce, picklist, values, labels, stage, status, lateral",
    docLlm:
      "picklist_values(object_name, field_name) returns value, label, active and default_value for each picklist " +
      "value of the field (from describe, cached 1 h). Pass literals for one field, or columns of a table of " +
      "(object, field) pairs to list many at once.",
    docMd: "## picklist_values(object_name, field_name)\n\nPicklist values from describe; 1 → N per input row.",
  }),
  examples: [
    {
      sql: `SELECT value, label FROM ${Q}.picklist_values('Opportunity', 'StageName') WHERE active ORDER BY value`,
      description: "The active opportunity stages",
    },
  ],
});
