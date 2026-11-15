/**
 * Discovery metadata for the `salesforce` catalog: titles, categories, docs and the
 * agent test tasks. DuckDB, coding agents and the `vgi-lint` checker read these tags.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "salesforce";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-salesforce";

export const SCHEMA_CATEGORIES = [
  {
    name: "ids",
    title: "ID Toolkit",
    description: "Credential-free Salesforce id functions: 15/18-character ids, checksums, key prefixes.",
  },
  { name: "query", title: "Queries", description: "SOQL and object scans with SQL filters pushed into SOQL." },
  { name: "lookup", title: "Lookups", description: "Per-row (LATERAL) record fetches, batched 200 ids per call." },
  {
    name: "replication",
    title: "Replication",
    description: "getUpdated / getDeleted for delete-aware incremental loads.",
  },
  { name: "metadata", title: "Metadata", description: "Describe metadata, org limits, Bulk jobs, users and access." },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"];

export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** An Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

export const CATALOG_COMMENT =
  "Salesforce CRM as SQL: SOQL and Bulk API 2.0 scans with DuckDB filters pushed into SOQL, describe-typed object " +
  "views, delete-aware incremental helpers, org metadata and limits, plus a credential-free Salesforce ID toolkit.";

export const CATALOG_DOC_LLM =
  "The salesforce catalog reads a Salesforce org (read-only). Tier 0 needs nothing: main.id18 / id15 / key_prefix / " +
  "object_of / is_valid_id / soql_literal work on any exported id column (DuckDB joins are case-sensitive; join on id18). " +
  "Everything else needs CREATE SECRET (TYPE salesforce, INSTANCE_URL …, plus a JWT bearer, client credentials or refresh " +
  "token OAuth flow). main.query_object(object_name, fields := […], modified_after := …) and the sobjects.<Object> views " +
  "(one per object in the ATTACH OBJECTS list) return typed rows: DuckDB WHERE filters, projections and ORDER BY … LIMIT " +
  "become SOQL. main.soql(query) runs SOQL with a bind-time typed result (fields, parent paths, aggregates, date functions). " +
  "Large scans move to Bulk API 2.0 jobs automatically. main.updated_ids / deleted_ids give delete-aware increments. " +
  "main.lookup(sf_id, object_name := …) and main.record(object_name, sf_id) enrich rows per id (LATERAL). meta.* has " +
  "objects, columns (field → column names), picklist_values, record_types, users, profiles, permission_sets, limits, jobs " +
  "and org. Column names are lower snake case: StageName → stage_name, Acme__Score__c → acme_score, Account.Name → account_name.";

export const CATALOG_DOC_MD =
  "# Salesforce CRM in DuckDB\n\n" +
  "Query a Salesforce org from SQL. DuckDB predicates and projections become SOQL, large scans run as Bulk API 2.0 jobs " +
  "with the `Sforce-Locator` as a resumable cursor, and schemas come from the org's own describe metadata.\n\n" +
  "**Reference notes.** Scans stop at `quota_guard_pct` (ATTACH option, default 80) of the org's daily API allowance, " +
  "which is shared with its production integrations; check `meta.limits` first. `deleted_ids()` refuses windows " +
  "older than the recycle-bin retention instead of returning an incomplete delete set.\n\n" +
  "- **ID toolkit** (`id18`, `id15`, `key_prefix`, `object_of`, `is_valid_id`, `soql_literal`): no secret, no network.\n" +
  "- **Queries**: `soql()`, `query_object()`, and `sobjects.<Object>` views for the ATTACH `OBJECTS` list.\n" +
  "- **Lookups**: `lookup()`, `record()`, `picklist_values()` — batched, LATERAL-friendly.\n" +
  "- **Replication**: `updated_ids()`, `deleted_ids()`.\n" +
  "- **Metadata**: `meta.objects`, `meta.columns`, `meta.limits`, `meta.jobs`, `meta.org` and more.\n\n" +
  `Setup (connected app, certificate, JWT bearer): ${SOURCE_URL}#connect-an-org`;

export const SCHEMA_DOC_LLM =
  "main holds the functions: the credential-free ID toolkit (id18, id15, key_prefix, object_of, is_valid_id, " +
  "soql_literal), the scans soql(query) and query_object(object_name, …), the per-row lookups lookup / record / " +
  "picklist_values, describe_fields(object_name), and updated_ids / deleted_ids for incremental sync. Scans need a " +
  "salesforce secret; filters on query_object columns are pushed into SOQL WHERE.";

export const SCHEMA_DOC_MD =
  "## main\n\nSalesforce functions: the ID toolkit, SOQL / object scans, per-row lookups, describe and replication helpers.";

export const META_DOC_LLM =
  "meta holds org metadata tables (all need a salesforce secret): objects (describeGlobal), columns and picklist_values " +
  "(for the ATTACH OBJECTS list), record_types, users, profiles, permission_sets, limits (/limits, check DailyApiRequests " +
  "before big extracts), jobs (Bulk API 2.0 jobs + this worker's resume journal) and org.";

export const SOBJECTS_DOC_LLM =
  "sobjects has one view per object named in the ATTACH OBJECTS option (e.g. OBJECTS 'Account,Opportunity,Invoice__c'): " +
  "SELECT … FROM salesforce.sobjects.Opportunity WHERE stage_name = 'Closed Won' pushes the filter and the selected " +
  "columns into SOQL. Each view is query_object('<Object>'); columns are typed from describe (see meta.columns). " +
  "Without OBJECTS the schema is empty; browse meta.objects, then re-ATTACH with the objects you want.";

export const AGENT_TEST_TASKS = [
  {
    name: "id18_conversion",
    prompt:
      "Using the salesforce worker, convert the 15-character Salesforce id 001Dn00000AbCdE to its 18-character case-safe form.",
  },
  {
    name: "validate_ids",
    prompt:
      "Using the salesforce worker, which of these values are valid Salesforce ids: '001Dn00000AbCdEIAV', '001Dn00000AbCdEAAA', 'n/a'? Return each value with true or false.",
  },
  {
    name: "object_of_prefix",
    prompt: "Using the salesforce worker, which standard Salesforce object does the id 00QDn000001aBcD belong to?",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Salesforce",
  "vgi.subtitle": "Salesforce CRM as SQL: SOQL pushdown, Bulk API 2.0, describe-typed objects and a free ID toolkit.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query.Farm",
  "vgi.copyright": "Copyright 2026 Query Farm LLC - https://query.farm",
  "vgi.keywords": keywordsArray(
    "salesforce, sfdc, crm, soql, bulk api 2.0, revops, sales operations, opportunities, accounts, id18, duckdb",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Salesforce Functions",
  domain: "crm",
  "vgi.keywords": keywordsArray("salesforce, soql, crm, ids, lookup, replication, describe"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};
