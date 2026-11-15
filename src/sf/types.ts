/**
 * Salesforce field types → DuckDB column types, and value conversion from both wire
 * formats (REST JSON records and Bulk API 2.0 CSV).
 *
 * | Salesforce type | DuckDB |
 * |---|---|
 * | id, reference, string, textarea, picklist, combobox, email, phone, url, encryptedstring | VARCHAR |
 * | boolean | BOOLEAN |
 * | int | INTEGER · long | BIGINT |
 * | double, currency, percent with a declared precision | DECIMAL(precision, scale) (DOUBLE when precision is 0) |
 * | date | DATE · datetime | TIMESTAMPTZ · time | TIME |
 * | multipicklist | VARCHAR[] (split on `;`) |
 * | address | STRUCT(street, city, state, postal_code, country, state_code, country_code, latitude, longitude, geocode_accuracy) |
 * | location (geolocation) | STRUCT(latitude DOUBLE, longitude DOUBLE) |
 * | anyType, complexvalue | JSON |
 * | base64 | not exposed (blob bodies cannot be read in a multi-record query) |
 */

import {
  bool,
  dateDay,
  decimal128,
  field,
  float64,
  int32,
  int64,
  list,
  struct,
  timeMicrosecond,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiField,
} from "@query-farm/vgi";
import type { SfDescribe, SfField } from "./describe.ts";

export type Kind =
  | "string"
  | "bool"
  | "int"
  | "long"
  | "double"
  | "decimal"
  | "date"
  | "datetime"
  | "time"
  | "multipicklist"
  | "address"
  | "location"
  | "json";

export interface ColumnSpec {
  /** DuckDB column name. */
  column: string;
  /** Salesforce field or relationship path as it appears in SOQL, e.g. `Account.Owner.Name`. */
  sfPath: string;
  kind: Kind;
  precision: number;
  scale: number;
  /** Fields to SELECT for this column (compound fields expand to their components). */
  select: string[];
  /** For address / location: struct field → component field path. */
  components?: Record<string, string>;
  /** Salesforce type name (`currency`, `reference`, …). */
  sfType: string;
  /** Whether a pushed SQL predicate on this column may become SOQL (filterable, non-compound). */
  filterable: boolean;
  nillable: boolean;
  label: string;
  /** Path relative to the record for reading REST JSON (defaults to sfPath). */
  aggregateAlias?: string;
}

const STRING_TYPES = new Set([
  "id",
  "reference",
  "string",
  "textarea",
  "picklist",
  "combobox",
  "email",
  "phone",
  "url",
  "encryptedstring",
]);

/** The column kind of a Salesforce field type (null = not exposed). */
export function kindOf(f: Pick<SfField, "type" | "precision">): Kind | null {
  const t = f.type.toLowerCase();
  if (STRING_TYPES.has(t)) return "string";
  switch (t) {
    case "boolean":
      return "bool";
    case "int":
      return "int";
    case "long":
      return "long";
    case "double":
    case "currency":
    case "percent":
      return f.precision > 0 && f.precision <= 38 ? "decimal" : "double";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    case "time":
      return "time";
    case "multipicklist":
      return "multipicklist";
    case "address":
      return "address";
    case "location":
      return "location";
    case "anytype":
    case "complexvalue":
    case "json":
      return "json";
    case "base64":
      return null;
    default:
      return "string";
  }
}

const ADDRESS_PARTS: [string, RegExp][] = [
  ["street", /Street$/i],
  ["city", /City$/i],
  ["state_code", /StateCode$/i],
  ["state", /State$/i],
  ["postal_code", /PostalCode$/i],
  ["country_code", /CountryCode$/i],
  ["country", /Country$/i],
  ["latitude", /Latitude(__s)?$/i],
  ["longitude", /Longitude(__s)?$/i],
  ["geocode_accuracy", /GeocodeAccuracy$/i],
];
const ADDRESS_STRUCT_FIELDS = [
  "street",
  "city",
  "state",
  "postal_code",
  "country",
  "state_code",
  "country_code",
  "latitude",
  "longitude",
  "geocode_accuracy",
];
const NUMERIC_PARTS = new Set(["latitude", "longitude"]);

/** Struct field → component field name for a compound field. */
export function compoundComponents(d: SfDescribe, compound: SfField, kind: Kind): Record<string, string> {
  const parts = d.fields.filter((f) => f.compoundFieldName === compound.name);
  const out: Record<string, string> = {};
  for (const p of parts) {
    const hit = ADDRESS_PARTS.find(([, re]) => re.test(p.name));
    if (hit && (kind === "address" || NUMERIC_PARTS.has(hit[0])) && !out[hit[0]]) out[hit[0]] = p.name;
  }
  return out;
}

export function arrowTypeOf(kind: Kind, precision = 0, scale = 0): VgiDataType {
  switch (kind) {
    case "string":
    case "json":
      return utf8();
    case "bool":
      return bool as unknown as VgiDataType;
    case "int":
      return int32 as unknown as VgiDataType;
    case "long":
      return int64();
    case "double":
      return float64();
    case "decimal":
      return decimal128(precision, scale);
    case "date":
      return dateDay();
    case "datetime":
      return timestampMicros("UTC");
    case "time":
      return timeMicrosecond();
    case "multipicklist":
      return list(field("item", utf8(), true)) as unknown as VgiDataType;
    case "address":
      return struct(
        ADDRESS_STRUCT_FIELDS.map((n) => field(n, NUMERIC_PARTS.has(n) ? float64() : utf8(), true)) as never,
      ) as unknown as VgiDataType;
    case "location":
      return struct([
        field("latitude", float64(), true),
        field("longitude", float64(), true),
      ] as never) as unknown as VgiDataType;
  }
}

/** DuckDB spelling of a kind, for metadata tables. */
export function sqlTypeOf(kind: Kind, precision = 0, scale = 0): string {
  switch (kind) {
    case "string":
      return "VARCHAR";
    case "json":
      return "JSON";
    case "bool":
      return "BOOLEAN";
    case "int":
      return "INTEGER";
    case "long":
      return "BIGINT";
    case "double":
      return "DOUBLE";
    case "decimal":
      return `DECIMAL(${precision},${scale})`;
    case "date":
      return "DATE";
    case "datetime":
      return "TIMESTAMP WITH TIME ZONE";
    case "time":
      return "TIME";
    case "multipicklist":
      return "VARCHAR[]";
    case "address":
      return "STRUCT(street VARCHAR, city VARCHAR, state VARCHAR, postal_code VARCHAR, country VARCHAR, state_code VARCHAR, country_code VARCHAR, latitude DOUBLE, longitude DOUBLE, geocode_accuracy VARCHAR)";
    case "location":
      return "STRUCT(latitude DOUBLE, longitude DOUBLE)";
  }
}

const JSON_META: [string, string] = ["ARROW:extension:name", "arrow.json"];

/** The Arrow output field for a column, carrying its Salesforce path as metadata. */
export function arrowField(c: ColumnSpec, comment: string): VgiField {
  const meta = new Map<string, string>([
    ["comment", comment],
    ["sf.path", c.sfPath],
  ]);
  if (c.kind === "json") meta.set(...JSON_META);
  return field(c.column, arrowTypeOf(c.kind, c.precision, c.scale), true, meta);
}

// --------------------------------------------------------------------- conversion

/** A decimal string (or number) → unscaled bigint at `scale`, rounding half away from zero. */
export function toUnscaled(v: unknown, scale: number): bigint | null {
  if (v == null || v === "") return null;
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v).trim();
  const m = s.match(/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return null;
  const neg = m[1] === "-";
  let intPart = m[2] ?? "";
  let frac = m[3] ?? "";
  const exp = Number(m[4] ?? 0);
  if (exp > 0) {
    const shift = frac.slice(0, exp).padEnd(exp, "0");
    intPart += shift;
    frac = frac.slice(exp);
  } else if (exp < 0) {
    const pad = intPart.padStart(-exp, "0");
    frac = pad.slice(pad.length + exp) + frac;
    intPart = pad.slice(0, pad.length + exp);
  }
  const kept = frac.slice(0, scale).padEnd(scale, "0");
  let n = BigInt((intPart || "0") + kept);
  if ((frac[scale] ?? "0") >= "5") n += 1n;
  return neg ? -n : n;
}

const DT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

/** ISO 8601 datetime (`…Z`, `…+0000`, `…+00:00`) → epoch microseconds. */
export function toMicros(v: unknown): bigint | null {
  if (typeof v !== "string" || v === "") return null;
  const m = v.trim().match(DT);
  if (!m) return null;
  const ms = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
  );
  let us = BigInt(ms) * 1000n + BigInt((m[7] ?? "").padEnd(6, "0") || "0");
  const tz = m[8];
  if (tz && tz !== "Z") {
    const sign = tz[0] === "-" ? -1n : 1n;
    const digits = tz.slice(1).replace(":", "");
    const offMin = BigInt(Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
    us -= sign * offMin * 60_000_000n;
  }
  return us;
}

export function toDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
}

export function toTimeMicros(v: unknown): bigint | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?/);
  if (!m) return null;
  const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
  return BigInt(s) * 1_000_000n + BigInt((m[4] ?? "").padEnd(6, "0") || "0");
}

function toBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const l = v.toLowerCase();
    if (l === "true") return true;
    if (l === "false") return false;
  }
  return null;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Convert one scalar wire value (JSON value or CSV string) to the column's JS value. */
export function convert(kind: Kind, v: unknown, scale = 0): unknown {
  if (v === undefined || v === null) return null;
  switch (kind) {
    case "string":
      return typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
    case "json":
      return typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
    case "bool":
      return toBool(v);
    case "int": {
      const n = toNum(v);
      return n === null ? null : Math.trunc(n);
    }
    case "long": {
      if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
      const n = toNum(v);
      return n === null ? null : BigInt(Math.trunc(n));
    }
    case "double":
      return toNum(v);
    case "decimal":
      return toUnscaled(v, scale);
    case "date":
      return toDate(v);
    case "datetime":
      return toMicros(v);
    case "time":
      return toTimeMicros(v);
    case "multipicklist":
      return typeof v === "string" ? (v === "" ? [] : v.split(";")) : null;
    default:
      return null;
  }
}

/** Walk a dotted path through a REST record (`Account.Owner.Name`). */
export function atPath(rec: unknown, path: string): unknown {
  let cur: unknown = rec;
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return null;
    const obj = cur as Record<string, unknown>;
    if (p in obj) cur = obj[p];
    else {
      // SOQL is case-insensitive; JSON keys use the describe spelling.
      const k = Object.keys(obj).find((x) => x.toLowerCase() === p.toLowerCase());
      cur = k === undefined ? null : obj[k];
    }
  }
  return cur;
}

/**
 * Read a column's value from a record. `get(path)` returns the raw wire value of a
 * SOQL path: from a REST record (nested JSON) or a Bulk CSV row (flat header names).
 */
export function readColumn(c: ColumnSpec, get: (path: string) => unknown): unknown {
  if (c.kind === "address" || c.kind === "location") {
    const comps = c.components ?? {};
    const names = c.kind === "address" ? ADDRESS_STRUCT_FIELDS : ["latitude", "longitude"];
    const out: Record<string, unknown> = {};
    let any = false;
    for (const n of names) {
      const path = comps[n];
      const raw = path ? get(path) : null;
      const v = raw == null || raw === "" ? null : NUMERIC_PARTS.has(n) ? toNum(raw) : String(raw);
      if (v !== null) any = true;
      out[n] = v;
    }
    return any ? out : null;
  }
  return convert(c.kind, get(c.sfPath), c.scale);
}
