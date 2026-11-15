/** Helpers shared by the table functions. */

import { field, schema, utf8, type VgiField, type VgiSchema } from "@query-farm/vgi";
import { type Category, column, objectTags } from "../meta.ts";
import { SalesforceError } from "../sf/client.ts";
import { arrowField, type ColumnSpec, sqlTypeOf } from "../sf/types.ts";

export const Q = "salesforce.main";

export interface FnExample {
  sql: string;
  description: string;
}

export interface DocSpec {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  columns?: { name: string; type: string; description: string }[];
  /** The result columns depend on the object / query (describe-driven). */
  dynamicColumns?: boolean;
}

export const DYNAMIC_COLUMNS_MD =
  "### Object scan (query_object, sobjects views, lookup)\n\n" +
  "One column per field of the object, typed from describe and named by the mangling rule (see meta.columns). " +
  "For Opportunity, for example:\n\n" +
  "| Name | Type | Description |\n|---|---|---|\n" +
  "| id | VARCHAR | The record id (18 characters). |\n" +
  "| stage_name | VARCHAR | StageName (picklist). |\n" +
  "| amount | DECIMAL(16,2) | Amount (currency, precision and scale from describe). |\n" +
  "| close_date | DATE | CloseDate. |\n" +
  "| is_won | BOOLEAN | IsWon. |\n" +
  "| system_modstamp | TIMESTAMP WITH TIME ZONE | Last system change, the incremental watermark. |\n\n" +
  "### SOQL query (soql)\n\n" +
  "One column per select item. For SOQL selecting StageName, Account.Owner.Name, COUNT(Id) and SUM(Amount) total:\n\n" +
  "| Name | Type | Description |\n|---|---|---|\n" +
  "| stage_name | VARCHAR | A plain field, typed from describe. |\n" +
  "| account_owner_name | VARCHAR | A parent relationship path, flattened with underscores. |\n" +
  "| expr0 | BIGINT | An unaliased aggregate, numbered as the API numbers it. |\n" +
  "| total | DOUBLE | An aliased SUM/AVG (MIN/MAX keep the field's type). |";

/** Discovery tags for a function or table. */
export function docTags(d: DocSpec): Record<string, string> {
  const tags: Record<string, string> = {
    domain: "crm",
    ...objectTags({ title: d.title, category: d.category, keywords: d.keywords, docLlm: d.docLlm, docMd: d.docMd }),
  };
  if (d.columns) tags["vgi.result_columns_schema"] = JSON.stringify(d.columns);
  if (d.dynamicColumns) tags["vgi.result_dynamic_columns_md"] = DYNAMIC_COLUMNS_MD;
  return tags;
}

/** Output schema of describe-driven columns; each field's comment is its label + Salesforce type. */
export function specSchema(columns: ColumnSpec[]): VgiSchema {
  return schema(
    columns.map((c) =>
      arrowField(c, `${c.label} (${c.sfPath}, Salesforce ${c.sfType} → ${sqlTypeOf(c.kind, c.precision, c.scale)})`),
    ),
  );
}

/** Wrap an error so DuckDB shows a clean message. */
export function rethrow(err: unknown): never {
  if (err instanceof SalesforceError) throw err;
  throw new SalesforceError((err as Error).message ?? String(err));
}

export const fields = (cols: [string, VgiField["type"], string, boolean?][]) =>
  schema(cols.map(([n, t, doc, nullable]) => column(n, t, doc, nullable ?? true)));

export const jsonField = (name: string, doc: string, nullable = true): VgiField =>
  field(
    name,
    utf8(),
    nullable,
    new Map([
      ["comment", doc],
      ["ARROW:extension:name", "arrow.json"],
    ]),
  );
