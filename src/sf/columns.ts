/**
 * Describe-driven column specs: which DuckDB columns an object (or a SOQL select list)
 * produces, with their types, names and SOQL select fields.
 */

import type { SfConfig } from "./client.ts";
import { describeObject, fieldOf, relationshipOf, type SfDescribe, type SfField } from "./describe.ts";
import { assignColumns } from "./naming.ts";
import { type ColumnSpec, compoundComponents, kindOf } from "./types.ts";

export const MAX_PATH_DEPTH = 5;

/** The fields every polymorphic relationship (WhatId, WhoId, OwnerId) exposes. */
const POLYMORPHIC: SfField[] = [
  { name: "Id", type: "id" },
  { name: "Name", type: "string" },
  { name: "Type", type: "string" },
].map((f) => ({
  ...f,
  label: f.name,
  soapType: "xsd:string",
  length: 0,
  precision: 0,
  scale: 0,
  nillable: true,
  createable: false,
  updateable: false,
  filterable: true,
  sortable: true,
  custom: false,
  referenceTo: [],
  relationshipName: null,
}));

export interface ResolvedPath {
  field: SfField;
  /** The path with every segment in its describe spelling. */
  sfPath: string;
  /** The describe that owns the final field (synthetic for polymorphic targets). */
  owner: SfDescribe;
  depth: number;
}

/** Resolve `Account.Owner.Name` from a root object through parent relationships. */
export async function resolvePath(cfg: SfConfig, root: SfDescribe, path: string): Promise<ResolvedPath> {
  const segs = path.split(".");
  if (segs.length - 1 > MAX_PATH_DEPTH) {
    throw new Error(`salesforce: '${path}' is deeper than ${MAX_PATH_DEPTH} relationship levels`);
  }
  let d = root;
  const canon: string[] = [];
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i] as string;
    const rel = relationshipOf(d, seg);
    if (!rel) throw new Error(`salesforce: '${seg}' is not a parent relationship of ${d.name} (in '${path}')`);
    canon.push(rel.relationshipName as string);
    if (rel.referenceTo.length === 1) d = await describeObject(cfg, rel.referenceTo[0] as string);
    else
      d = { name: "Name", label: "Polymorphic", keyPrefix: null, custom: false, queryable: true, fields: POLYMORPHIC };
  }
  const last = segs[segs.length - 1] as string;
  const f = fieldOf(d, last);
  if (!f) {
    throw new Error(
      d.name === "Name"
        ? `salesforce: '${path}' crosses a polymorphic relationship; only Id, Name and Type are available there`
        : `salesforce: ${d.name} has no field '${last}' (in '${path}'); see salesforce.main.describe_fields('${d.name}')`,
    );
  }
  canon.push(f.name);
  return { field: f, sfPath: canon.join("."), owner: d, depth: segs.length - 1 };
}

/** Build the spec of a column backed by a resolved field (null for unexposed types such as base64). */
export function specOf(r: ResolvedPath, column: string): ColumnSpec | null {
  const kind = kindOf(r.field);
  if (!kind) return null;
  const prefix = r.sfPath.includes(".") ? `${r.sfPath.slice(0, r.sfPath.lastIndexOf(".") + 1)}` : "";
  let components: Record<string, string> | undefined;
  let select = [r.sfPath];
  if (kind === "address" || kind === "location") {
    const comps = compoundComponents(r.owner, r.field, kind);
    components = Object.fromEntries(Object.entries(comps).map(([k, v]) => [k, prefix + v]));
    select = Object.values(components);
  }
  return {
    column,
    sfPath: r.sfPath,
    kind,
    precision: r.field.precision,
    scale: r.field.scale,
    select,
    components,
    sfType: r.field.type,
    filterable: r.field.filterable && kind !== "address" && kind !== "location" && kind !== "json",
    nillable: r.field.nillable,
    label: r.field.label,
  };
}

/** Columns for an object: every exposed field in describe order, or the listed fields/paths. */
export async function objectColumns(
  cfg: SfConfig,
  d: SfDescribe,
  fields?: string[] | null,
): Promise<{ columns: ColumnSpec[]; warnings: string[] }> {
  const resolved: ResolvedPath[] = [];
  if (fields?.length) {
    for (const p of fields) resolved.push(await resolvePath(cfg, d, p.trim()));
  } else {
    for (const f of d.fields) if (kindOf(f)) resolved.push({ field: f, sfPath: f.name, owner: d, depth: 0 });
  }
  const { columns: names, warnings } = assignColumns(resolved.map((r) => r.sfPath));
  const columns: ColumnSpec[] = [];
  resolved.forEach((r, i) => {
    const spec = specOf(r, (names[i] as { column: string }).column);
    if (spec) columns.push(spec);
  });
  return { columns, warnings };
}

/** The distinct SOQL select fields for a set of columns, plus any extras (Id, SystemModstamp). */
export function selectList(columns: ColumnSpec[], extra: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of [...columns.flatMap((c) => c.select), ...extra]) {
    const k = s.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}
