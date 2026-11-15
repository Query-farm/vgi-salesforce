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
  "Query a Salesforce org from SQL and join it to everything Salesforce reports cannot reach: product usage, " +
  "billing, support data in local files. DuckDB predicates and projections become SOQL, so a six-column query " +
  "against a 900-field object fetches six fields; large scans run as Bulk API 2.0 jobs whose `Sforce-Locator` is " +
  "a resumable cursor; and column types come from the org's own describe metadata.\n\n" +
  "The ID toolkit needs no org at all: it fixes the 15- versus 18-character id join in any exported CSV.\n\n" +
  "**Reference notes.** Scans stop at `quota_guard_pct` (ATTACH option, default 80) of the org's daily API " +
  "allowance, which is shared with its production integrations. Delete-aware incremental helpers refuse windows " +
  "older than the recycle-bin retention rather than return an incomplete delete set. Everything is read-only.\n\n" +
  `Setup (connected app, certificate, JWT bearer): ${SOURCE_URL}#connect-an-org`;

export const SCHEMA_DOC_LLM =
  "main holds the functions: the credential-free ID toolkit (id18, id15, key_prefix, object_of, is_valid_id, " +
  "soql_literal), the scans soql(query) and query_object(object_name, …), the per-row lookups lookup / record / " +
  "picklist_values, describe_fields(object_name), and updated_ids / deleted_ids for incremental sync. Scans need a " +
  "salesforce secret; filters on query_object columns are pushed into SOQL WHERE.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "The functions. The ID toolkit works on any id column with no secret and no network — the place to start " +
  "with a downloaded report.\n\n" +
  "The scans (`soql`, `query_object`) read records with typed columns, and push DuckDB filters, projections and " +
  "Top-N limits into SOQL; above `bulk_threshold` rows they switch to Bulk API 2.0. The per-row lookups are " +
  "LATERAL-friendly and batch 200 ids per API call. `updated_ids` / `deleted_ids` make incremental loads " +
  "delete-aware within Salesforce's retention windows.";

export const META_DOC_LLM =
  "meta holds org metadata tables (all need a salesforce secret): objects (describeGlobal), columns and picklist_values " +
  "(for the ATTACH OBJECTS list), record_types, users, profiles, permission_sets, limits (/limits, check DailyApiRequests " +
  "before big extracts), jobs (Bulk API 2.0 jobs + this worker's resume journal) and organizations.";

export const SOBJECTS_DOC_LLM =
  "sobjects has one view per object named in the ATTACH OBJECTS option (e.g. OBJECTS 'Account,Opportunity,Invoice__c'). " +
  "Filtering a view, for example on stage_name = 'Closed Won', pushes the filter and the selected columns into SOQL. " +
  "Each view is query_object('<Object>'); columns are typed from describe (see meta.columns). Without OBJECTS the " +
  "schema is empty; browse meta.objects, then re-ATTACH with the objects you want.";

export const SOBJECTS_DOC_MD =
  "## sobjects\n\n" +
  "One view per object in the ATTACH `OBJECTS` list, e.g. `OBJECTS 'Account,Opportunity,Invoice__c'`. Each view " +
  "is `query_object('<Object>')`, so filters, projections and Top-N limits are pushed into SOQL.\n\n" +
  "Views cost nothing at ATTACH: an object's describe is fetched the first time a query binds it and cached for an " +
  "hour. Without `OBJECTS` the schema is empty — browse `meta.objects`, then re-attach with the objects you want.";

export const META_DOC_MD =
  "## meta\n\n" +
  "Org metadata as tables, all behind the `salesforce` secret: the object list, the column-name mapping and " +
  "picklists of the attached objects, record types, users, profiles, permission sets and the org itself.\n\n" +
  "Operational tables sit alongside: the org's API limits (check the daily request allowance before a large " +
  "extract) and the Bulk API 2.0 jobs with this worker's resume journal.";

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
    prompt:
      "Using the salesforce worker, which standard Salesforce object does the id 00QDn000001aBcD belong to, and what is its key prefix and 15-character form?",
  },
  {
    name: "quote_literal",
    prompt:
      "Using the salesforce worker, build a SOQL condition LastName = <value> for the last name O'Brien, quoted safely.",
  },
  {
    name: "open_pipeline_by_stage",
    prompt: "What is the total open (not closed) opportunity amount per stage in the connected Salesforce org?",
  },
  {
    name: "won_deals_soql",
    prompt: "Using SOQL through the salesforce worker, count the won opportunities and their total amount.",
  },
  {
    name: "task_targets",
    prompt:
      "For each Salesforce task whose WhatId is an opportunity, list the task subject with the opportunity's name, and also give the raw record JSON's StageName.",
  },
  {
    name: "stage_picklist",
    prompt:
      "List the picklist values of the Opportunity StageName field, both from the per-field function and from the attached objects' metadata table.",
  },
  {
    name: "custom_field_columns",
    prompt: "What are the custom fields of Invoice__c called as SQL columns, and which of them appear in meta.columns?",
  },
  {
    name: "changes_this_week",
    prompt: "How many opportunities were updated, and how many deleted, between 2026-01-01 and 2026-01-08 UTC?",
  },
  {
    name: "api_budget",
    prompt: "How much of the org's daily API request limit remains, and how many Bulk query jobs exist?",
  },
  {
    name: "custom_objects",
    prompt: "Which custom objects does the org have, with their key prefixes, and what is the org's edition?",
  },
  {
    name: "access_review",
    prompt:
      "List active users with their profile and how many active users that profile has, plus the number of permission sets and Account record types.",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Salesforce CRM",
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
