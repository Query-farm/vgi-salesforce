/**
 * DuckDB pushed-down predicates → a SOQL WHERE clause.
 *
 * Every scan sets `autoApplyFilters`, so the SDK re-applies each pushed predicate
 * exactly after the rows arrive. The SOQL we generate therefore only has to return a
 * SUPERSET of the matching rows; a predicate we cannot express safely is simply not
 * sent. Where SOQL semantics differ from SQL we either widen or skip:
 *
 * - SOQL string comparison is case-insensitive. `=`, `IN` and LIKE (from
 *   starts_with / ends_with / contains / prefix ranges) are pushed — case-insensitive
 *   matching is a superset — but string `!=`, `NOT IN` and `<`/`>` ranges are not,
 *   because a case-insensitive collation would drop rows SQL keeps.
 * - Literals are formatted per Salesforce type: strings quoted and escaped, dates
 *   `YYYY-MM-DD` and datetimes `YYYY-MM-DDThh:mm:ssZ` unquoted, booleans TRUE/FALSE,
 *   numbers bare, NULL as `null`. Sub-second datetime bounds are widened to whole
 *   seconds.
 * - Under OR every branch must translate, or the whole OR is dropped; under AND the
 *   translatable conjuncts are kept.
 *
 * `exact` reports whether every pushed predicate was required and became an equivalent SOQL condition;
 * only then may a LIMIT be pushed into SOQL as well.
 */

import type { PushdownFilters } from "@query-farm/vgi";
import { soqlLikeEscape, soqlLiteral } from "./ids.ts";
import type { ColumnSpec } from "./types.ts";

type Expr = PushdownFilters["filters"][number];

export interface Translation {
  /** SOQL conditions to AND together (each already parenthesised when needed). */
  conditions: string[];
  /** True when every pushed predicate translated to an equivalent condition. */
  exact: boolean;
}

interface Part {
  soql: string;
  exact: boolean;
}

const OPS: Record<string, string> = { eq: "=", ne: "!=", lt: "<", le: "<=", gt: ">", ge: ">=" };
const FLIP: Record<string, string> = { eq: "eq", ne: "ne", lt: "gt", le: "ge", gt: "lt", ge: "le" };

function unwrap(e: Expr): Expr {
  return e.node === "cast" ? unwrap(e.expression) : e;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function isoDate(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Epoch µs → SOQL datetime literal (whole seconds, UTC). */
export function soqlDateTime(us: bigint): string {
  const d = new Date(Number(us / 1_000_000n) * 1000);
  return `${isoDate(d)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

function asMicros(v: unknown): bigint | undefined {
  if (typeof v === "bigint") return v;
  if (v instanceof Date) return BigInt(v.getTime()) * 1000n;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v)) * 1000n;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : BigInt(t) * 1000n;
  }
  return undefined;
}

function asDate(v: unknown, lit?: Expr): string | undefined {
  if (v instanceof Date) return isoDate(v);
  if (typeof v === "number" && Number.isInteger(v)) return isoDate(new Date(v * 86_400_000)); // date32 days
  if (typeof v === "bigint") {
    // A timestamp literal compared with a DATE column: only whole days are exact.
    const isTs = lit?.node === "literal" && /timestamp/i.test(String(lit.field.type));
    const us = isTs ? v : v * 86_400_000_000n;
    if (us % 86_400_000_000n !== 0n) return undefined;
    return isoDate(new Date(Number(us / 1000n)));
  }
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return undefined;
}

/** A decimal literal (unscaled bigint at the literal's scale) or plain number → SOQL number text. */
function asNumber(v: unknown, lit?: Expr): string | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : undefined;
  if (typeof v === "bigint") {
    const t = lit?.node === "literal" ? (lit.field.type as unknown as { scale?: number; typeId?: number }) : undefined;
    const scale = t && typeof t.scale === "number" ? t.scale : 0;
    if (!scale) return v.toString();
    const neg = v < 0n;
    const digits = (neg ? -v : v).toString().padStart(scale + 1, "0");
    return `${neg ? "-" : ""}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return v;
  return undefined;
}

const isTextual = (c: ColumnSpec) => c.kind === "string";

/** SOQL literal for a value compared with column `c`; undefined when it cannot be expressed. */
function literal(c: ColumnSpec, v: unknown, lit?: Expr): string | undefined {
  if (v === null || v === undefined) return undefined;
  switch (c.kind) {
    case "string":
      return typeof v === "string" ? (soqlLiteral(v) as string) : undefined;
    case "bool":
      return typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : undefined;
    case "int":
    case "long":
    case "double":
    case "decimal":
      return asNumber(v, lit);
    case "date":
      return asDate(v, lit);
    default:
      return undefined;
  }
}

type Col = (e: Expr) => ColumnSpec | undefined;

function comparison(c: ColumnSpec, op: string, value: unknown, lit: Expr): Part | undefined {
  if (!c.filterable) return undefined;
  if (c.kind === "datetime") {
    const us = asMicros(value);
    if (us === undefined) return undefined;
    const whole = us % 1_000_000n === 0n;
    const floor = soqlDateTime(us - (((us % 1_000_000n) + 1_000_000n) % 1_000_000n));
    const ceil = whole ? floor : soqlDateTime(us - (((us % 1_000_000n) + 1_000_000n) % 1_000_000n) + 1_000_000n);
    if (whole) return { soql: `${c.sfPath} ${OPS[op]} ${floor}`, exact: true };
    // Widen a sub-second bound to the surrounding whole seconds (a superset).
    if (op === "gt" || op === "ge") return { soql: `${c.sfPath} >= ${floor}`, exact: false };
    if (op === "lt" || op === "le") return { soql: `${c.sfPath} <= ${ceil}`, exact: false };
    if (op === "eq") return { soql: `(${c.sfPath} >= ${floor} AND ${c.sfPath} <= ${ceil})`, exact: false };
    return undefined;
  }
  if (isTextual(c) && op !== "eq") return undefined; // case-insensitive collation: only = is a superset
  const l = literal(c, value, lit);
  if (l === undefined) return undefined;
  return { soql: `${c.sfPath} ${OPS[op]} ${l}`, exact: !isTextual(c) };
}

function translate(e: Expr, col: Col): Part | undefined {
  switch (e.node) {
    case "column_ref": {
      const c = col(e);
      return c?.kind === "bool" && c.filterable ? { soql: `${c.sfPath} = TRUE`, exact: true } : undefined;
    }
    case "not": {
      const inner = unwrap(e.expression);
      if (inner.node === "column_ref") {
        const c = col(inner);
        return c?.kind === "bool" && c.filterable ? { soql: `${c.sfPath} = FALSE`, exact: true } : undefined;
      }
      return undefined;
    }
    case "and": {
      const parts = e.children.map((ch) => translate(ch, col));
      const ok = parts.filter((p): p is Part => !!p);
      if (!ok.length) return undefined;
      return {
        soql: ok.length === 1 ? (ok[0] as Part).soql : `(${ok.map((p) => p.soql).join(" AND ")})`,
        exact: ok.length === parts.length && ok.every((p) => p.exact),
      };
    }
    case "or": {
      const parts = e.children.map((ch) => translate(ch, col));
      if (!parts.length || parts.some((p) => !p)) return undefined;
      return { soql: `(${(parts as Part[]).map((p) => p.soql).join(" OR ")})`, exact: parts.every((p) => p?.exact) };
    }
    case "is_null": {
      const c = col(unwrap(e.expression));
      if (!c?.filterable || c.kind === "address" || c.kind === "location") return undefined;
      return {
        soql: `${c.sfPath} ${e.negated ? "!=" : "="} null`,
        exact: c.kind !== "string" && c.kind !== "multipicklist",
      };
    }
    case "comparison": {
      if (!(e.op in OPS)) return undefined;
      const [l, r] = [unwrap(e.left), unwrap(e.right)];
      if (r.node === "literal") {
        const c = col(l);
        return c ? comparison(c, e.op, r.value, r) : undefined;
      }
      if (l.node === "literal") {
        const c = col(r);
        return c ? comparison(c, FLIP[e.op] as string, l.value, l) : undefined;
      }
      return undefined;
    }
    case "in": {
      const c = col(unwrap(e.expression));
      if (!c?.filterable) return undefined;
      const values = e.set.values;
      if (!values.length || values.length > 500 || values.some((v) => v == null)) return undefined;
      if (e.negated && isTextual(c)) return undefined;
      if (c.kind === "datetime") {
        const us = values.map(asMicros);
        if (us.some((u) => u === undefined || u % 1_000_000n !== 0n)) return undefined;
        const lits = [...new Set((us as bigint[]).map(soqlDateTime))];
        return { soql: `${c.sfPath} ${e.negated ? "NOT IN" : "IN"} (${lits.join(", ")})`, exact: true };
      }
      const litExpr =
        e.set.kind === "literal" ? ({ node: "literal", field: e.set.field } as unknown as Expr) : undefined;
      const lits = values.map((v) => literal(c, v, litExpr));
      if (lits.some((x) => x === undefined)) return undefined;
      return {
        soql: `${c.sfPath} ${e.negated ? "NOT IN" : "IN"} (${[...new Set(lits as string[])].join(", ")})`,
        exact: !isTextual(c),
      };
    }
    case "call": {
      if (typeof e.function !== "string" || e.arguments.length !== 2) return undefined;
      const c = col(unwrap(e.arguments[0] as Expr));
      const v = unwrap(e.arguments[1] as Expr);
      if (!c?.filterable || v.node !== "literal" || typeof v.value !== "string") return undefined;
      if (e.function === "list_contains" && c.kind === "multipicklist") {
        return { soql: `${c.sfPath} INCLUDES (${soqlLiteral(v.value)})`, exact: false };
      }
      if (!isTextual(c) || c.sfType === "id" || c.sfType === "reference" || c.sfType === "textarea") return undefined;
      const esc = soqlLikeEscape(v.value);
      const pat =
        e.function === "starts_with"
          ? `${esc}%`
          : e.function === "ends_with"
            ? `%${esc}`
            : e.function === "contains"
              ? `%${esc}%`
              : undefined;
      return pat === undefined ? undefined : { soql: `${c.sfPath} LIKE '${pat}'`, exact: false };
    }
    default:
      return undefined;
  }
}

/** The string after every string starting with `p` (DuckDB's prefix-range upper bound). */
function prefixSuccessor(p: string): string | undefined {
  const last = p.codePointAt(p.length - 1);
  return last === undefined ? undefined : p.slice(0, -1) + String.fromCodePoint(last + 1);
}

/**
 * DuckDB rewrites `col LIKE 'ab%'` / `starts_with(col, 'ab')` into `col >= 'ab' AND col < 'ac'`.
 * String ranges cannot be pushed (collation), but the pair is exactly a prefix: emit LIKE.
 */
function prefixRanges(exprs: Expr[], col: Col): string[] {
  const lows: { c: ColumnSpec; v: string }[] = [];
  const highs: { c: ColumnSpec; v: string }[] = [];
  const visit = (e: Expr) => {
    if (e.node === "and") {
      e.children.forEach(visit);
      return;
    }
    if (e.node !== "comparison") return;
    const [l, r] = [unwrap(e.left), unwrap(e.right)];
    if (r.node !== "literal" || typeof r.value !== "string") return;
    const c = col(l);
    if (!c || !isTextual(c) || !c.filterable || c.sfType === "id" || c.sfType === "reference") return;
    if (e.op === "ge") lows.push({ c, v: r.value });
    if (e.op === "lt") highs.push({ c, v: r.value });
  };
  exprs.forEach(visit);
  const out: string[] = [];
  for (const lo of lows) {
    const hi = lo.v ? prefixSuccessor(lo.v) : undefined;
    if (hi && highs.some((h) => h.c === lo.c && h.v === hi)) out.push(`${lo.c.sfPath} LIKE '${soqlLikeEscape(lo.v)}%'`);
  }
  return out;
}

/** Translate a scan's required pushed predicates against its columns. */
export function toSoql(filters: PushdownFilters | undefined, columns: ColumnSpec[]): Translation {
  const byName = new Map(columns.map((c) => [c.column, c]));
  const col: Col = (e) => (e.node === "column_ref" ? byName.get(e.columnName) : undefined);
  const conditions: string[] = [];
  let exact = true;
  // Required predicates were dropped from DuckDB's plan; advisory ones (an IN list DuckDB
  // derived from an OR it still evaluates) only prune, so both may narrow the SOQL. Top-N
  // dynamic filters change during the scan and are not sent.
  const all = filters?.predicates ?? [];
  const usable = all.filter((p) => p.source !== "top_n");
  const required = usable.map((p) => p.expression);
  // (A Top-N dynamic filter is implied by the very ORDER BY … LIMIT being pushed, so it does
  // not make the translation inexact.)
  if (usable.some((p) => p.mode !== "required")) exact = false;
  for (const e of required) {
    const p = translate(e, col);
    if (!p) exact = false;
    else {
      conditions.push(p.soql);
      if (!p.exact) exact = false;
    }
  }
  conditions.push(...prefixRanges(required, col));
  return { conditions, exact };
}
