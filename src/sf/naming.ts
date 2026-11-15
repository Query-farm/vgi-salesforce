/**
 * The column-naming ("mangling") rule: Salesforce API names → lower-case snake.
 *
 *  1. A trailing `__c` / `__r` / `__x` / `__b` suffix is dropped.
 *  2. A managed-package namespace stays as a leading segment: `Acme__Score__c` → `acme_score`.
 *  3. The rest splits on `_` and on lower→upper camel-case boundaries, lower-cased and
 *     joined with `_`: `StageName` → `stage_name`, `SystemModstamp` → `system_modstamp`.
 *  4. Relationship paths flatten with `_`: `Account.Owner.Name` → `account_owner_name`.
 *  5. (soql) Unaliased aggregates are `expr0`, `expr1`, … as the API itself names them.
 *  6. Collisions are resolved deterministically: the first in describe order keeps the
 *     name, later ones get `_2`, `_3`, … and a warning names both source fields.
 */

const SUFFIX = /__(c|r|x|b)$/i;

/** Mangle one API name segment (no dots). */
export function mangleSegment(apiName: string): string {
  const base = apiName.replace(SUFFIX, "");
  const parts = base.split("__").flatMap((p) => p.split("_"));
  const words: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    for (const w of p.split(/(?<=[a-z0-9])(?=[A-Z])/)) if (w) words.push(w.toLowerCase());
  }
  return words.join("_") || apiName.toLowerCase();
}

/** Mangle a field name or a dotted relationship path. */
export function mangle(apiPath: string): string {
  return apiPath
    .split(".")
    .map((s) => mangleSegment(s))
    .join("_");
}

export interface NamedColumn {
  /** Salesforce field or relationship path, e.g. `Account.Owner.Name`. */
  sfName: string;
  /** The DuckDB column name after mangling and collision suffixing. */
  column: string;
}

/**
 * Assign column names to Salesforce fields in order, suffixing collisions.
 * Returns the names and a warning per collision.
 */
export function assignColumns(
  sfNames: string[],
  explicit?: (string | undefined)[],
): {
  columns: NamedColumn[];
  warnings: string[];
} {
  const used = new Map<string, string>();
  const columns: NamedColumn[] = [];
  const warnings: string[] = [];
  sfNames.forEach((sfName, i) => {
    const base = explicit?.[i] ? mangleSegment(explicit[i] as string) : mangle(sfName);
    let name = base;
    let n = 1;
    while (used.has(name)) name = `${base}_${++n}`;
    if (name !== base) {
      warnings.push(
        `salesforce: '${sfName}' and '${used.get(base)}' both map to column '${base}'; '${sfName}' is '${name}'`,
      );
    }
    used.set(name, sfName);
    columns.push({ sfName, column: name });
  });
  return { columns, warnings };
}
