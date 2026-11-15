/**
 * Fixed-schema tables and functions (metadata, limits, jobs …): a column list with a
 * getter each, and a `page(ctx, cursor)` that returns rows plus the next cursor.
 * The cursor is a string in serializable scan state, so paging resumes on any process.
 */

import {
  batchFromColumns,
  bool,
  constraintRecord,
  dateDay,
  defineTableFunction,
  float64,
  int32,
  int64,
  list,
  schema,
  type TableDescriptor,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiField,
  type VgiFunction,
} from "@query-farm/vgi";
import { column } from "../meta.ts";
import { SECRET_TYPE } from "../sf/client.ts";
import { type CallContext, callContext } from "../sf/context.ts";
import { toDate, toMicros } from "../sf/types.ts";
import { type DocSpec, docTags, type FnExample, jsonField } from "./common.ts";

// biome-ignore lint/suspicious/noExplicitAny: Salesforce JSON is untyped.
export type Row = Record<string, any>;

export interface Col {
  name: string;
  type: VgiDataType;
  sqlType: string;
  doc: string;
  nullable?: boolean;
  json?: boolean;
  get: (r: Row) => unknown;
}

const g = (path: string | ((r: Row) => unknown)) =>
  typeof path === "function"
    ? path
    : (r: Row) =>
        path.split(".").reduce<unknown>((cur, p) => (cur && typeof cur === "object" ? (cur as Row)[p] : null), r);

const str = (v: unknown) => (v == null ? null : typeof v === "string" ? v : String(v));
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : null;

export const C = {
  str: (name: string, doc: string, path: string | ((r: Row) => unknown), nullable = true): Col => ({
    name,
    type: utf8(),
    sqlType: "VARCHAR",
    doc,
    nullable,
    get: (r) => str(g(path)(r)),
  }),
  bool: (name: string, doc: string, path: string | ((r: Row) => unknown)): Col => ({
    name,
    type: bool as unknown as VgiDataType,
    sqlType: "BOOLEAN",
    doc,
    get: (r) => {
      const v = g(path)(r);
      return typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : null;
    },
  }),
  int: (name: string, doc: string, path: string | ((r: Row) => unknown)): Col => ({
    name,
    type: int32 as unknown as VgiDataType,
    sqlType: "INTEGER",
    doc,
    get: (r) => {
      const n = num(g(path)(r));
      return n === null ? null : Math.trunc(n);
    },
  }),
  big: (name: string, doc: string, path: string | ((r: Row) => unknown)): Col => ({
    name,
    type: int64(),
    sqlType: "BIGINT",
    doc,
    get: (r) => {
      const n = num(g(path)(r));
      return n === null ? null : BigInt(Math.trunc(n));
    },
  }),
  dbl: (name: string, doc: string, path: string | ((r: Row) => unknown)): Col => ({
    name,
    type: float64(),
    sqlType: "DOUBLE",
    doc,
    get: (r) => num(g(path)(r)),
  }),
  time: (name: string, doc: string, path: string | ((r: Row) => unknown)): Col => ({
    name,
    type: timestampMicros("UTC"),
    sqlType: "TIMESTAMP WITH TIME ZONE",
    doc,
    get: (r) => toMicros(g(path)(r)),
  }),
  date: (name: string, doc: string, path: string | ((r: Row) => unknown)): Col => ({
    name,
    type: dateDay(),
    sqlType: "DATE",
    doc,
    get: (r) => toDate(g(path)(r)),
  }),
  strList: (name: string, doc: string, path: string | ((r: Row) => unknown)): Col => ({
    name,
    type: list(utf8()) as unknown as VgiDataType,
    sqlType: "VARCHAR[]",
    doc,
    get: (r) => {
      const v = g(path)(r);
      return Array.isArray(v) ? v.map((x) => String(x)) : null;
    },
  }),
  json: (name: string, doc: string, path: string | ((r: Row) => unknown)): Col => ({
    name,
    type: utf8(),
    sqlType: "JSON",
    doc,
    json: true,
    get: (r) => {
      const v = g(path)(r);
      return v == null ? null : JSON.stringify(v);
    },
  }),
};

export function colSchema(cols: Col[]) {
  return schema(
    cols.map(
      (c): VgiField =>
        c.json ? jsonField(c.name, c.doc, c.nullable ?? true) : column(c.name, c.type, c.doc, c.nullable ?? true),
    ),
  );
}

export function colDocs(cols: Col[]) {
  return cols.map((c) => ({ name: c.name, type: c.sqlType, description: c.doc }));
}

export interface PageResult {
  rows: Row[];
  /** Next cursor, or null when finished. */
  next: string | null;
}

export interface FixedSpec<A> extends DocSpec {
  name: string;
  description: string;
  args?: Record<string, VgiDataType>;
  argDefaults?: Record<string, unknown>;
  argDocs?: Record<string, string>;
  argConstraints?: Record<string, Record<string, unknown>>;
  cols: Col[];
  /** Fetch one page. `cursor` is "" on the first call. */
  page: (ctx: CallContext, args: A, cursor: string, attach: Uint8Array | null) => Promise<PageResult>;
  examples: FnExample[];
  /** Tier 0 functions need no secret. */
  noSecret?: boolean;
}

interface FixedState {
  cursor: string;
  done: boolean;
}

export function defineFixed<A extends Record<string, unknown>>(spec: FixedSpec<A>): VgiFunction {
  const out = colSchema(spec.cols);
  return defineTableFunction<A, FixedState>({
    name: spec.name,
    description: spec.description,
    args: (spec.args ?? {}) as never,
    argDefaults: spec.argDefaults,
    argDocs: spec.argDocs,
    argConstraints: spec.argConstraints as never,
    requiredSecrets: spec.noSecret ? undefined : [SECRET_TYPE],
    projectionPushdown: true,
    filterPushdown: true,
    autoApplyFilters: true,
    onBind: () => ({ outputSchema: out }),
    initialState: () => ({ cursor: "", done: false }),
    process: async (params, state, o) => {
      const attach = params.initCall.bind_call.attach_opaque_data;
      const ctx = spec.noSecret ? ({} as CallContext) : callContext(params.secrets, attach);
      for (;;) {
        if (state.done) {
          o.finish();
          return;
        }
        const page = await spec.page(ctx, params.args, state.cursor, attach);
        if (page.next === null) state.done = true;
        else state.cursor = page.next;
        if (page.rows.length) {
          const cols: Record<string, unknown[]> = {};
          for (const f of params.outputSchema.fields) {
            const c = spec.cols.find((x) => x.name === f.name);
            cols[f.name] = page.rows.map((r) => (c ? c.get(r) : null));
          }
          o.emit(batchFromColumns(cols, params.outputSchema));
          return;
        }
      }
    },
    tags: docTags({ ...spec, columns: colDocs(spec.cols) }),
    examples: spec.examples,
  });
}

export interface TableKeys {
  /** Primary-key column (a Salesforce id or name the platform keeps unique). */
  pk?: string[];
  /** Foreign keys: column → referenced table (its PK column has the same name). */
  fks?: { column: string; table: string; refColumn: string }[];
}

const META_PATH = ["meta"];

/**
 * A parameterless spec as a catalog table in `meta`. Salesforce enforces the uniqueness of
 * record ids (and object / limit names) on every write path, so those keys are attested
 * ENFORCED / ALL_ROWS.
 */
export function fixedTable(spec: FixedSpec<Record<string, never>>, keys: TableKeys = {}): TableDescriptor {
  const fn = defineFixed({ ...spec, name: `${spec.name}_scan` });
  const rec = (id: string, kind: "NOT_NULL" | "PRIMARY_KEY", cols: string[]) =>
    constraintRecord({
      schemaPath: META_PATH,
      table: spec.name,
      id,
      kind,
      columns: cols.map((c) => [c]),
      enforcement: "ENFORCED",
      validation: "ALL_ROWS",
    });
  const constraints = keys.pk
    ? [...keys.pk.map((c) => rec(`${c}_not_null`, "NOT_NULL", [c])), rec("pk", "PRIMARY_KEY", keys.pk)]
    : [];
  for (const fk of keys.fks ?? []) {
    constraints.push(
      constraintRecord({
        schemaPath: META_PATH,
        table: spec.name,
        id: `fk_${fk.column}`,
        kind: "FOREIGN_KEY",
        columns: [[fk.column]],
        enforcement: "ENFORCED",
        validation: "ALL_ROWS",
        references: { schemaPath: META_PATH, table: fk.table, columns: [[fk.refColumn]], constraintId: "pk" },
      }),
    );
  }
  return {
    name: spec.name,
    comment: spec.description,
    columns: colSchema(spec.cols),
    function: fn,
    constraints,
    tags: {
      ...docTags({ ...spec, columns: colDocs(spec.cols) }),
      "vgi.example_queries": JSON.stringify(spec.examples),
    },
  } as TableDescriptor;
}
