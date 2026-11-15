/**
 * The closed SOQL SELECT-list grammar that `soql()` types at bind time.
 *
 * Supported select items (anything else is a bind error naming the item):
 *
 * - a field or a parent relationship path up to 5 levels (`Amount`, `Account.Owner.Name`);
 * - `COUNT()` (alone), `COUNT(f)`, `COUNT_DISTINCT(f)`, `SUM(f)`, `AVG(f)`, `MIN(f)`, `MAX(f)`;
 * - date functions `CALENDAR_YEAR/MONTH/QUARTER`, `FISCAL_YEAR/QUARTER`, `DAY_ONLY`,
 *   `DAY_IN_MONTH/WEEK/YEAR`, `HOUR_IN_DAY`, `WEEK_IN_MONTH/YEAR` over a date/datetime field;
 * - `GROUPING(f)`;
 * - `FIELDS(STANDARD)`.
 *
 * Aggregates and functions take an optional alias (`SUM(Amount) total`, `AS` allowed);
 * unaliased ones are `expr0`, `expr1`, … as the API names them. Rejected: subqueries,
 * `TYPEOF`, `toLabel()`, `convertCurrency()`, `format()`, `FIELDS(ALL|CUSTOM)`.
 */

export type SelectItem =
  | { kind: "field"; path: string; text: string }
  | { kind: "count_all"; alias?: string; text: string }
  | { kind: "agg"; fn: string; path: string; alias?: string; text: string }
  | { kind: "datefn"; fn: string; path: string; alias?: string; text: string }
  | { kind: "grouping"; path: string; alias?: string; text: string }
  | { kind: "fields_standard"; text: string };

export interface ParsedSoql {
  items: SelectItem[];
  object: string;
  /** Everything after the FROM object: WHERE … GROUP BY … ORDER BY … LIMIT … */
  rest: string;
  aggregate: boolean;
  /** Top-level clause offsets within `rest` (keyword → index), for safe rewriting. */
  clauses: Clause[];
}

export interface Clause {
  keyword: string;
  start: number;
}

export class SoqlGrammarError extends Error {}

const AGGS = new Set(["COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX"]);
export const DATE_FNS = new Set([
  "CALENDAR_YEAR",
  "CALENDAR_MONTH",
  "CALENDAR_QUARTER",
  "FISCAL_YEAR",
  "FISCAL_QUARTER",
  "FISCAL_MONTH",
  "DAY_ONLY",
  "DAY_IN_MONTH",
  "DAY_IN_WEEK",
  "DAY_IN_YEAR",
  "HOUR_IN_DAY",
  "WEEK_IN_MONTH",
  "WEEK_IN_YEAR",
]);
const KNOWN_REJECTED = new Set(["TYPEOF", "TOLABEL", "CONVERTCURRENCY", "FORMAT", "DISTANCE", "GEOLOCATION"]);
const SUPPORTED =
  "supported select items: fields and parent paths (Account.Owner.Name), COUNT(), COUNT(f), COUNT_DISTINCT(f), " +
  "SUM/AVG/MIN/MAX(f), CALENDAR_*/FISCAL_*/DAY_ONLY/DAY_IN_*/HOUR_IN_DAY/WEEK_IN_*(f), GROUPING(f), FIELDS(STANDARD). " +
  "Use salesforce.main.record() for anything else";

const PATH = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*){0,5}$/;
const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Split `s` on top-level commas (outside parentheses and quotes). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (quote) {
      cur += ch;
      if (ch === "\\") cur += s[++i] ?? "";
      else if (ch === "'") quote = false;
      continue;
    }
    if (ch === "'") quote = true;
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/**
 * Find top-level keywords in a clause string, skipping quoted strings and parentheses.
 * Returns their offsets (upper-cased keyword, e.g. "ORDER BY").
 */
export function findClauses(rest: string): Clause[] {
  const out: Clause[] = [];
  const KW = /^(WHERE|WITH|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|FOR|UPDATE|USING\s+SCOPE)\b/i;
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "'") {
      for (i++; i < rest.length && rest[i] !== "'"; i++) if (rest[i] === "\\") i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /[A-Za-z]/.test(ch ?? "") && (i === 0 || /[\s)]/.test(rest[i - 1] ?? ""))) {
      const m = rest.slice(i).match(KW);
      if (m) {
        out.push({ keyword: (m[1] as string).toUpperCase().replace(/\s+/g, " "), start: i });
        i += (m[0] as string).length - 1;
      }
    }
  }
  return out;
}

function parseItem(raw: string): SelectItem {
  const text = raw.trim();
  if (!text) throw new SoqlGrammarError("soql: empty select item");
  if (/^\(\s*SELECT\b/i.test(text)) {
    throw new SoqlGrammarError(`soql: unsupported select item '${text}': parent-to-child subqueries; ${SUPPORTED}`);
  }
  const fm = text.match(/^([A-Za-z_]+)\s*\((.*)\)\s*(?:(?:AS\s+)?([A-Za-z][A-Za-z0-9_]*))?$/is);
  if (fm) {
    const fn = (fm[1] as string).toUpperCase();
    const arg = (fm[2] as string).trim();
    const alias = fm[3];
    if (fn === "FIELDS") {
      if (arg.toUpperCase() === "STANDARD" && !alias) return { kind: "fields_standard", text };
      throw new SoqlGrammarError(
        `soql: unsupported select item '${text}': FIELDS(ALL) and FIELDS(CUSTOM) make the schema non-deterministic; ${SUPPORTED}`,
      );
    }
    if (fn === "COUNT" && arg === "") return { kind: "count_all", alias, text };
    if (AGGS.has(fn)) {
      if (!PATH.test(arg)) throw new SoqlGrammarError(`soql: unsupported select item '${text}': ${SUPPORTED}`);
      return { kind: "agg", fn, path: arg, alias, text };
    }
    if (DATE_FNS.has(fn)) {
      if (!PATH.test(arg)) throw new SoqlGrammarError(`soql: unsupported select item '${text}': ${SUPPORTED}`);
      return { kind: "datefn", fn, path: arg, alias, text };
    }
    if (fn === "GROUPING") {
      if (!PATH.test(arg)) throw new SoqlGrammarError(`soql: unsupported select item '${text}': ${SUPPORTED}`);
      return { kind: "grouping", path: arg, alias, text };
    }
    throw new SoqlGrammarError(
      `soql: unsupported select item '${text}': ${fm[1]}() is not in the supported grammar; ${SUPPORTED}`,
    );
  }
  const first = text.split(/\s+/)[0]?.toUpperCase() ?? "";
  if (KNOWN_REJECTED.has(first)) throw new SoqlGrammarError(`soql: unsupported select item '${text}': ${SUPPORTED}`);
  if (PATH.test(text)) return { kind: "field", path: text, text };
  if (/^\S+\s+(AS\s+)?[A-Za-z]\w*$/i.test(text)) {
    throw new SoqlGrammarError(
      `soql: unsupported select item '${text}': SOQL only allows aliases on aggregates and functions`,
    );
  }
  throw new SoqlGrammarError(`soql: unsupported select item '${text}': ${SUPPORTED}`);
}

/** Parse a SOQL query against the closed grammar. */
export function parseSoql(query: string): ParsedSoql {
  const q = query.trim().replace(/;\s*$/, "");
  const sm = q.match(/^SELECT\s+/i);
  if (!sm) throw new SoqlGrammarError("soql: the query must start with SELECT");
  // Find the top-level FROM that ends the select list.
  const body = q.slice(sm[0].length);
  let depth = 0;
  let fromAt = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /\s/.test(ch ?? "") && /^\s+FROM\s/i.test(body.slice(i))) {
      fromAt = i;
      break;
    }
  }
  if (fromAt < 0) throw new SoqlGrammarError("soql: no FROM clause");
  const items = splitTop(body.slice(0, fromAt)).map(parseItem);
  const after = body.slice(fromAt).replace(/^\s+FROM\s+/i, "");
  const om = after.match(/^([A-Za-z][A-Za-z0-9_]*)\b\s*/);
  if (!om) throw new SoqlGrammarError("soql: FROM must name one object");
  const object = om[1] as string;
  const rest = after.slice(om[0].length);
  const clauses = findClauses(rest);
  if (rest.trim() && (clauses.length === 0 || (clauses[0] as Clause).start !== rest.length - rest.trimStart().length)) {
    const word = rest.trim().split(/\s+/)[0];
    throw new SoqlGrammarError(`soql: unexpected '${word}' after FROM ${object} (object aliases are not supported)`);
  }
  if (items.filter((i) => i.kind === "count_all").length && items.length > 1) {
    throw new SoqlGrammarError("soql: COUNT() must be the only select item");
  }
  const aggregate =
    items.some((i) => i.kind === "agg" || i.kind === "count_all" || i.kind === "grouping") ||
    clauses.some((c) => c.keyword === "GROUP BY");
  if (!IDENT.test(object)) throw new SoqlGrammarError("soql: FROM must name one object");
  return { items, object, rest, aggregate, clauses };
}
