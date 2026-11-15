/** `meta.*` tables and `describe_fields()`: the org's metadata, limits and scan journal. */

import { type TableDescriptor, utf8, type VgiFunction } from "@query-farm/vgi";
import { lastUsage, sfJson } from "../sf/client.ts";
import { attachObjects, type CallContext } from "../sf/context.ts";
import { describeGlobal, describeObject } from "../sf/describe.ts";
import { listJournal } from "../sf/journal.ts";
import { assignColumns } from "../sf/naming.ts";
import { kindOf, sqlTypeOf } from "../sf/types.ts";
import { Q } from "./common.ts";
import { C, defineFixed, type FixedSpec, fixedTable, type PageResult, type Row } from "./fixed.ts";

const M = "salesforce.meta";

interface RestPage {
  records: Row[];
  done: boolean;
  nextRecordsUrl?: string;
}

/** One REST query page; the cursor is the nextRecordsUrl. */
export async function soqlPage(ctx: CallContext, soql: string, cursor: string): Promise<PageResult> {
  const res = cursor
    ? await sfJson<RestPage>(ctx.cfg, cursor)
    : await sfJson<RestPage>(ctx.cfg, "query", { query: { q: soql } });
  return { rows: res.records ?? [], next: res.done || !res.nextRecordsUrl ? null : res.nextRecordsUrl };
}

/** Rows over the ATTACH OBJECTS list, one object (one describe) per page. */
async function perObject(
  attach: Uint8Array | null,
  cursor: string,
  rowsOf: (name: string) => Promise<Row[]>,
): Promise<PageResult> {
  const objects = attachObjects(attach);
  const i = cursor ? Number(cursor) : 0;
  const name = objects[i];
  if (name === undefined) return { rows: [], next: null };
  return { rows: await rowsOf(name), next: i + 1 < objects.length ? String(i + 1) : null };
}

const objects = fixedTable(
  {
    name: "objects",
    description: "Every object in the org (describeGlobal): name, label, key prefix and capabilities",
    title: "Salesforce Objects",
    category: "metadata",
    keywords: "salesforce, sobjects, objects, describe global, key prefix, custom objects, schema",
    docLlm:
      "meta.objects lists every object the connected user can see (one describeGlobal call, cached for an hour): name " +
      "(API name for query_object / OBJECTS), label, label_plural, key_prefix (first 3 characters of its record ids — join " +
      "with main.key_prefix(id) to resolve polymorphic ids to custom objects), custom, queryable, replicateable, " +
      "retrieveable and other capability flags. Browse it, then re-ATTACH with OBJECTS 'A,B,C' to get sobjects views.",
    docMd:
      "## meta.objects\n\nThe org's describeGlobal, one row per object. Use it to choose the `OBJECTS` ATTACH list.",
    cols: [
      C.str("name", "Object API name, e.g. Account or Invoice__c.", "name", false),
      C.str("label", "Singular label.", "label"),
      C.str("label_plural", "Plural label.", "labelPlural"),
      C.str("key_prefix", "3-character record id prefix (null for objects without records).", "keyPrefix"),
      C.bool("custom", "True for custom objects (__c).", "custom"),
      C.bool("queryable", "Can be read with SOQL.", "queryable"),
      C.bool("createable", "Records can be created.", "createable"),
      C.bool("updateable", "Records can be updated.", "updateable"),
      C.bool("deletable", "Records can be deleted.", "deletable"),
      C.bool("replicateable", "Supports getUpdated / getDeleted (updated_ids / deleted_ids).", "replicateable"),
      C.bool("retrieveable", "Records can be retrieved by id.", "retrieveable"),
      C.bool("searchable", "Included in SOSL search.", "searchable"),
      C.bool("custom_setting", "True for custom settings.", "customSetting"),
    ],
    page: async (ctx) => ({ rows: (await describeGlobal(ctx.cfg)) as unknown as Row[], next: null }),
    examples: [
      {
        sql: `SELECT name, label, key_prefix FROM ${M}.objects WHERE custom AND queryable ORDER BY name`,
        description: "Custom objects you can query",
      },
    ],
  },
  { pk: ["name"] },
);

const limits = fixedTable(
  {
    name: "limits",
    description: "The org's API limits (/limits): maximum and remaining per limit, plus the worker's quota-guard view",
    title: "Salesforce Org Limits",
    category: "metadata",
    keywords: "salesforce, limits, api quota, daily api requests, bulk api, quota guard, remaining",
    docLlm:
      "meta.limits returns one row per org limit from /limits: limit_name (DailyApiRequests, DailyBulkV2QueryJobs, " +
      "DailyBulkV2QueryFileStorageMB, …), maximum, remaining, used and used_pct. Check DailyApiRequests before a large " +
      "extract: scans fail loudly once usage reaches the quota_guard_pct ATTACH option (default 80%).",
    docMd:
      "## meta.limits\n\nOrg limits from `/limits`. The daily API request quota is shared with every integration " +
      "in the org; the worker's quota guard stops scans at `quota_guard_pct` (default 80) of it.",
    cols: [
      C.str("limit_name", "Limit name, e.g. DailyApiRequests.", "name", false),
      C.big("maximum", "The limit's allowance, in the limit's own unit (requests, jobs or MB).", "Max"),
      C.big("remaining", "Allowance left, in the limit's unit (requests, jobs or MB).", "Remaining"),
      C.big("used", "Allowance consumed (maximum minus remaining), in the limit's unit.", (r) =>
        typeof r.Max === "number" && typeof r.Remaining === "number" ? r.Max - r.Remaining : null,
      ),
      C.dbl("used_pct", "Percentage of the limit used (0-100).", (r) =>
        typeof r.Max === "number" && r.Max > 0 && typeof r.Remaining === "number"
          ? (100 * (r.Max - r.Remaining)) / r.Max
          : null,
      ),
    ],
    page: async (ctx) => {
      const body = await sfJson<Record<string, { Max: number; Remaining: number }>>(ctx.cfg, "limits");
      const rows: Row[] = Object.entries(body).map(([name, v]) => ({ name, Max: v.Max, Remaining: v.Remaining }));
      const u = lastUsage(ctx.cfg);
      if (u) rows.push({ name: "SforceLimitInfoApiUsage", Max: u.max, Remaining: u.max - u.used });
      return { rows, next: null };
    },
    examples: [
      {
        sql: `SELECT limit_name, maximum, remaining, round(used_pct, 1) AS used_pct FROM ${M}.limits WHERE limit_name LIKE 'Daily%' ORDER BY used_pct DESC`,
        description: "Daily limits, most used first",
      },
    ],
  },
  { pk: ["limit_name"] },
);

interface JobList {
  records: Row[];
  done: boolean;
  nextRecordsUrl?: string | null;
}

const jobs = fixedTable(
  {
    name: "jobs",
    description: "Bulk API 2.0 query jobs in the org joined with this worker's scan journal (locator, records read)",
    title: "Bulk Query Jobs",
    category: "metadata",
    keywords: "salesforce, bulk api 2.0, jobs, locator, resume, journal, extract",
    docLlm:
      "meta.jobs lists Bulk API 2.0 query jobs (GET jobs/query) with id, object_name, operation, state, created_date, " +
      "and — for jobs this worker ran — the journalled locator, records_read, query_sha256, resumable and journal_state. " +
      "A row with journal_state 'running' or 'failed' is a scan that can continue with resume := true on the same query.",
    docMd:
      "## meta.jobs\n\nThe org's Bulk API 2.0 query jobs plus this worker's journal (where a resume cursor comes from).",
    cols: [
      C.str("id", "Bulk job id (750…).", "id", false),
      C.str("object_name", "Object queried.", "object"),
      C.str("operation", "query or queryAll.", "operation"),
      C.str("state", "UploadComplete, InProgress, JobComplete, Failed or Aborted.", "state"),
      C.time("created_date", "When the job was created.", "createdDate"),
      C.str("api_version", "API version the job was created with (results must be read with the same one).", (r) =>
        r.apiVersion == null ? null : String(r.apiVersion),
      ),
      C.str(
        "locator",
        "Journalled Sforce-Locator of the next unread page (null when complete or not ours).",
        (r) => r.__j?.locator || null,
      ),
      C.big(
        "records_read",
        "Count of records this worker has read from the job so far.",
        (r) => r.__j?.records_seen ?? null,
      ),
      C.str(
        "query_sha256",
        "Hash of instance, API version and SOQL that keys the journal.",
        (r) => r.__j?.query_sha256 ?? null,
      ),
      C.bool(
        "resumable",
        "Whether an expired job can be recovered by SystemModstamp.",
        (r) => r.__j?.resumable ?? null,
      ),
      C.str(
        "journal_state",
        "running, complete or failed (null when the job was not run by this worker).",
        (r) => r.__j?.state ?? null,
      ),
      C.str(
        "error_message",
        "Failure message, from the job or the journal.",
        (r) => r.errorMessage ?? (r.__j?.error_message || null),
      ),
    ],
    page: async (ctx, _a, cursor) => {
      const res = cursor
        ? await sfJson<JobList>(ctx.cfg, cursor)
        : await sfJson<JobList>(ctx.cfg, "jobs/query", { query: { jobType: "V2Query" } });
      const journal = new Map(
        listJournal(ctx.stateDir)
          .filter((e) => e.instance_url === ctx.cfg.instanceUrl && e.job_id)
          .map((e) => [e.job_id, e]),
      );
      const rows = (res.records ?? []).map((r) => ({ ...r, __j: journal.get(r.id) }));
      return { rows, next: res.done || !res.nextRecordsUrl ? null : res.nextRecordsUrl };
    },
    examples: [
      {
        sql: `SELECT id, object_name, state, records_read, journal_state FROM ${M}.jobs WHERE journal_state IS NOT NULL ORDER BY created_date DESC`,
        description: "Bulk jobs this worker ran, newest first",
      },
    ],
  },
  { pk: ["id"] },
);

const recordTypes = fixedTable(
  {
    name: "record_types",
    description: "Record types of every object (one SOQL query on RecordType)",
    title: "Record Type Catalog",
    category: "metadata",
    keywords: "salesforce, record types, recordtypeid, developer name, business process",
    docLlm:
      "meta.record_types lists every record type: object_name (SobjectType), id (join to an object's " +
      "record_type_id column), developer_name, name, description, active.",
    docMd: "## meta.record_types\n\nOne row per record type, read with a single SOQL query on the RecordType object.",
    cols: [
      C.str("object_name", "Object the record type belongs to.", "SobjectType", false),
      C.str("id", "Record type id (012…); objects carry it in their record_type_id column.", "Id", false),
      C.str("developer_name", "API name.", "DeveloperName"),
      C.str("name", "Label.", "Name"),
      C.str("description", "Admin-entered explanation of what the record type is for.", "Description"),
      C.bool("active", "Whether the record type is active.", "IsActive"),
    ],
    page: (ctx, _a, cursor) =>
      soqlPage(
        ctx,
        "SELECT Id, SobjectType, DeveloperName, Name, Description, IsActive FROM RecordType ORDER BY SobjectType, DeveloperName",
        cursor,
      ),
    examples: [
      {
        sql: `SELECT object_name, developer_name, active FROM ${M}.record_types ORDER BY object_name, developer_name`,
        description: "Record types by object",
      },
    ],
  },
  { pk: ["id"] },
);

const columns = fixedTable(
  {
    name: "columns",
    description:
      "The column-name mapping of every object in the ATTACH OBJECTS list: Salesforce field → DuckDB column and type",
    title: "Column Mapping",
    category: "metadata",
    keywords: "salesforce, columns, fields, mangling, snake case, types, mapping",
    docLlm:
      "meta.columns shows, for each object in the ATTACH OBJECTS list, how every field becomes a column of " +
      "sobjects.<Object> / query_object: object_name, sf_field_name (e.g. Acme__Score__c), column_name (acme_score), " +
      "duckdb_type, sf_type, label, filterable (pushed into SOQL WHERE), nillable, custom, is_relationship_path. " +
      "Use it to find what a custom field is called in SQL.",
    docMd: "## meta.columns\n\nThe mangling map (Salesforce field → DuckDB column) for the attached objects.",
    cols: [
      C.str("object_name", "Object API name.", "object", false),
      C.str("sf_field_name", "Salesforce field API name.", "field", false),
      C.str("column_name", "DuckDB column name.", "column", false),
      C.str("duckdb_type", "DuckDB column type.", "duckdb"),
      C.str("sf_type", "Salesforce field type.", "sfType"),
      C.str("label", "Field label.", "label"),
      C.bool("filterable", "SQL filters on this column are pushed into SOQL WHERE.", "filterable"),
      C.bool("nillable", "The field can be empty.", "nillable"),
      C.bool("custom", "Custom field (__c).", "custom"),
      C.bool("is_relationship_path", "The column is a parent relationship path (never for object views).", () => false),
    ],
    page: (ctx, _a, cursor, attach) =>
      perObject(attach, cursor, async (name) => {
        const d = await describeObject(ctx.cfg, name);
        const exposed = d.fields.filter((f) => kindOf(f));
        const { columns: names } = assignColumns(exposed.map((f) => f.name));
        return exposed.map((f, i) => {
          const k = kindOf(f);
          return {
            object: d.name,
            field: f.name,
            column: names[i]?.column,
            duckdb: k ? sqlTypeOf(k, f.precision, f.scale) : null,
            sfType: f.type,
            label: f.label,
            filterable: f.filterable && k !== "address" && k !== "location",
            nillable: f.nillable,
            custom: f.custom,
          };
        });
      }),
    examples: [
      {
        sql: `SELECT sf_field_name, column_name, duckdb_type FROM ${M}.columns WHERE object_name = 'Account' AND sf_field_name LIKE '%__c' ORDER BY column_name`,
        description: "What the custom fields of Account are called in SQL",
      },
    ],
  },
  { pk: ["object_name", "sf_field_name"] },
);

const picklists = fixedTable(
  {
    name: "picklist_values",
    description: "Picklist and multi-select picklist values of every object in the ATTACH OBJECTS list",
    title: "Picklist Value Catalog",
    category: "metadata",
    keywords: "salesforce, picklist, values, stage, status, multipicklist, labels",
    docLlm:
      "meta.picklist_values lists picklist values for the attached objects: object_name, field_name, value (the API " +
      "value stored on records), label, active, default_value. For one field of any object use main.picklist_values(object, field).",
    docMd: "## meta.picklist_values\n\nPicklist values from describe, for the attached objects.",
    cols: [
      C.str("object_name", "Object API name.", "object", false),
      C.str("field_name", "Field API name.", "field", false),
      C.str("value", "API value.", "value", false),
      C.str("label", "Display label.", "label"),
      C.bool("active", "Whether the value can be chosen.", "active"),
      C.bool("default_value", "Whether it is the field's default.", "defaultValue"),
    ],
    page: (ctx, _a, cursor, attach) =>
      perObject(attach, cursor, async (name) => {
        const d = await describeObject(ctx.cfg, name);
        return d.fields.flatMap((f) => (f.picklistValues ?? []).map((p) => ({ ...p, object: d.name, field: f.name })));
      }),
    examples: [
      {
        sql: `SELECT value, label FROM ${M}.picklist_values WHERE object_name = 'Opportunity' AND field_name = 'StageName' AND active ORDER BY value`,
        description: "Active opportunity stages",
      },
    ],
  },
  { pk: ["object_name", "field_name", "value"] },
);

const users = fixedTable(
  {
    name: "users",
    description: "Users of the org with profile and role names",
    title: "Org Users and Licenses",
    category: "metadata",
    keywords: "salesforce, users, licenses, profile, role, last login, active",
    docLlm:
      "meta.users lists users: id, username, name, email, active, user_type (Standard, PowerPartner, …), " +
      "profile_id, profile_name, role_id, role_name, last_login, created_date. Join id to owner_id columns.",
    docMd: "## meta.users\n\nOrg users with their profile and role.",
    cols: [
      C.str("id", "User id (005…); joins owner_id / created_by_id columns.", "Id", false),
      C.str("username", "Login username.", "Username"),
      C.str("name", "Full name.", "Name"),
      C.str("email", "Email address.", "Email"),
      C.bool("active", "IsActive.", "IsActive"),
      C.str("user_type", "License category (Standard, PowerPartner, CsnOnly …).", "UserType"),
      C.str(
        "profile_id",
        "Id (00e…) of the profile that sets the user's base permissions; joins meta.profiles.",
        "ProfileId",
      ),
      C.str("profile_name", "Name of that profile, e.g. System Administrator.", "Profile.Name"),
      C.str(
        "role_id",
        "Id (00E…) of the user's position in the role hierarchy (record sharing); NULL when unassigned.",
        "UserRoleId",
      ),
      C.str("role_name", "Name of that role, e.g. Sales Rep.", "UserRole.Name"),
      C.time("last_login", "Last successful login.", "LastLoginDate"),
      C.time("created_date", "When the user was created.", "CreatedDate"),
    ],
    page: (ctx, _a, cursor) =>
      soqlPage(
        ctx,
        "SELECT Id, Username, Name, Email, IsActive, UserType, ProfileId, Profile.Name, UserRoleId, UserRole.Name, LastLoginDate, CreatedDate FROM User ORDER BY Username",
        cursor,
      ),
    examples: [
      {
        sql: `SELECT profile_name, count(*) AS users FROM ${M}.users WHERE active GROUP BY profile_name ORDER BY users DESC`,
        description: "Active users per profile",
      },
    ],
  },
  { pk: ["id"], fks: [{ column: "profile_id", table: "profiles", refColumn: "id" }] },
);

async function countsBy(ctx: CallContext, soql: string, key: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let cursor = "";
  for (;;) {
    const p = await soqlPage(ctx, soql, cursor);
    for (const r of p.rows) out.set(String(r[key]), Number(r.expr0 ?? 0));
    if (p.next === null) return out;
    cursor = p.next;
  }
}

const profiles = fixedTable(
  {
    name: "profiles",
    description: "Profiles with their license and how many active users hold each",
    title: "Profile Summary",
    category: "metadata",
    keywords: "salesforce, profiles, licenses, access, permissions, users",
    docLlm:
      "meta.profiles summarises profiles: id, name, user_license, user_type, description and active_users " +
      "(count of active users assigned).",
    docMd: "## meta.profiles\n\nProfiles with an active-user count.",
    cols: [
      C.str("id", "Profile id (00e…).", "Id", false),
      C.str("name", "Profile name.", "Name"),
      C.str("user_license", "User license name.", "UserLicense.Name"),
      C.str("user_type", "License category the profile applies to (Standard, PowerPartner, …).", "UserType"),
      C.str("description", "Admin-entered explanation of the profile's purpose.", "Description"),
      C.big("active_users", "Count of active users assigned this profile.", "__users"),
    ],
    page: async (ctx, _a, cursor) => {
      const p = await soqlPage(
        ctx,
        "SELECT Id, Name, UserLicense.Name, UserType, Description FROM Profile ORDER BY Name",
        cursor,
      );
      const counts = await countsBy(
        ctx,
        "SELECT ProfileId, COUNT(Id) FROM User WHERE IsActive = TRUE GROUP BY ProfileId",
        "ProfileId",
      );
      return { ...p, rows: p.rows.map((r) => ({ ...r, __users: counts.get(r.Id) ?? 0 })) };
    },
    examples: [
      {
        sql: `SELECT name, user_license, active_users FROM ${M}.profiles WHERE active_users > 0 ORDER BY active_users DESC`,
        description: "Profiles in use",
      },
    ],
  },
  { pk: ["id"] },
);

const permissionSets = fixedTable(
  {
    name: "permission_sets",
    description: "Permission sets (not owned by profiles) with their assignment counts",
    title: "Permission Set Summary",
    category: "metadata",
    keywords: "salesforce, permission sets, access, assignments, security review",
    docLlm:
      "meta.permission_sets summarises permission sets that are not profile-owned: id, name (API name), " +
      "label, custom, description and assignments (count of PermissionSetAssignment rows).",
    docMd: "## meta.permission_sets\n\nPermission sets with assignment counts.",
    cols: [
      C.str("id", "Permission set id (0PS…).", "Id", false),
      C.str("name", "API name.", "Name"),
      C.str("label", "Display name shown in Setup.", "Label"),
      C.bool("custom", "Custom (not standard) permission set.", "IsCustom"),
      C.str("description", "Admin-entered explanation of the access it grants.", "Description"),
      C.big("assignments", "Count of users the permission set is assigned to.", "__assigned"),
    ],
    page: async (ctx, _a, cursor) => {
      const p = await soqlPage(
        ctx,
        "SELECT Id, Name, Label, IsCustom, Description FROM PermissionSet WHERE IsOwnedByProfile = FALSE ORDER BY Name",
        cursor,
      );
      const counts = await countsBy(
        ctx,
        "SELECT PermissionSetId, COUNT(Id) FROM PermissionSetAssignment GROUP BY PermissionSetId",
        "PermissionSetId",
      );
      return { ...p, rows: p.rows.map((r) => ({ ...r, __assigned: counts.get(r.Id) ?? 0 })) };
    },
    examples: [
      {
        sql: `SELECT label, assignments FROM ${M}.permission_sets ORDER BY assignments DESC, label LIMIT 10`,
        description: "Most-assigned permission sets",
      },
    ],
  },
  { pk: ["id"] },
);

const organizations = fixedTable(
  {
    name: "organizations",
    description: "The connected org: id, name, edition, instance, sandbox flag, locale, and the API version in use",
    title: "Connected Org Info",
    category: "metadata",
    keywords: "salesforce, organization, org id, edition, instance, sandbox, api version",
    docLlm:
      "meta.organizations is one row describing the connected org: org_id (00D…), name, edition (OrganizationType), instance_name, " +
      "is_sandbox, namespace_prefix, default_locale, time_zone, language, created_date, plus instance_url and api_version " +
      "as configured in the salesforce secret.",
    docMd: "## meta.organizations\n\nOne row about the connected org (Salesforce calls it the Organization).",
    cols: [
      C.str("org_id", "Organization id (00D…).", "Id", false),
      C.str("name", "Org name.", "Name"),
      C.str("edition", "Edition (OrganizationType).", "OrganizationType"),
      C.str("instance_name", "Pod, e.g. NA224.", "InstanceName"),
      C.bool("is_sandbox", "True for sandboxes.", "IsSandbox"),
      C.str("namespace_prefix", "Org namespace (developer orgs).", "NamespacePrefix"),
      C.str("default_locale", "DefaultLocaleSidKey.", "DefaultLocaleSidKey"),
      C.str("time_zone", "TimeZoneSidKey.", "TimeZoneSidKey"),
      C.str("language", "LanguageLocaleKey.", "LanguageLocaleKey"),
      C.time("created_date", "When the org was created.", "CreatedDate"),
      C.str("instance_url", "Instance URL from the salesforce secret.", "__instance"),
      C.str("api_version", "REST API version in use.", "__version"),
    ],
    page: async (ctx) => {
      const p = await soqlPage(
        ctx,
        "SELECT Id, Name, OrganizationType, InstanceName, IsSandbox, NamespacePrefix, DefaultLocaleSidKey, TimeZoneSidKey, LanguageLocaleKey, CreatedDate FROM Organization",
        "",
      );
      return {
        rows: p.rows.map((r) => ({ ...r, __instance: ctx.cfg.instanceUrl, __version: ctx.cfg.apiVersion })),
        next: null,
      };
    },
    examples: [
      {
        sql: `SELECT org_id, name, edition, is_sandbox, api_version FROM ${M}.organizations`,
        description: "Which org am I connected to?",
      },
    ],
  },
  { pk: ["org_id"] },
);

export const META_TABLES: TableDescriptor[] = [
  objects,
  limits,
  jobs,
  recordTypes,
  columns,
  picklists,
  users,
  profiles,
  permissionSets,
  organizations,
];

const describeFieldsSpec: FixedSpec<{ object_name: string }> = {
  name: "describe_fields",
  description:
    "Every field of one object from describe: names, types, lengths, flags, references, formulas and the DuckDB column",
  title: "Describe Fields",
  category: "metadata",
  keywords: "salesforce, describe, fields, schema, types, formula, reference, picklist",
  docLlm:
    "describe_fields(object_name) returns one row per field of an object: name, label, sf_type, soap_type, length, " +
    "precision, scale, nillable, createable, updateable, filterable, sortable, custom, calculated, formula, reference_to " +
    "(`VARCHAR[]` of target objects), relationship_name, compound_field_name, column_name (the DuckDB column) and duckdb_type. " +
    "Fully cached for an hour.",
  docMd: "## describe_fields(object_name)\n\nThe object's describe, one row per field.",
  args: { object_name: utf8() },
  argDocs: { object_name: "Object API name, e.g. 'Opportunity'." },
  cols: [
    C.str("name", "Field API name.", "name", false),
    C.str("label", "Label.", "label"),
    C.str("sf_type", "Salesforce field type.", "type"),
    C.str("soap_type", "SOAP type (xsd:string …).", "soapType"),
    C.int("length", "Maximum length for text fields.", "length"),
    C.int("precision", "Total digits for numbers.", "precision"),
    C.int("scale", "Digits after the decimal point.", "scale"),
    C.bool("nillable", "Can be empty.", "nillable"),
    C.bool("createable", "Settable on insert.", "createable"),
    C.bool("updateable", "Settable on update.", "updateable"),
    C.bool("filterable", "Usable in SOQL WHERE.", "filterable"),
    C.bool("sortable", "Usable in ORDER BY.", "sortable"),
    C.bool("custom", "Custom field.", "custom"),
    C.bool("calculated", "Formula or roll-up field.", "calculated"),
    C.str("formula", "Formula text for calculated fields.", "calculatedFormula"),
    C.strList("reference_to", "Objects a lookup can point to (several for polymorphic fields).", "referenceTo"),
    C.str("relationship_name", "Relationship name for paths (Account in Account.Name).", "relationshipName"),
    C.str("compound_field_name", "Compound (address/geolocation) field this is a component of.", "compoundFieldName"),
    C.str("column_name", "DuckDB column name in query_object / sobjects views (null if not exposed).", "__column"),
    C.str("duckdb_type", "DuckDB type (null for base64 fields, which are not exposed).", "__duckdb"),
  ],
  page: async (ctx, args) => {
    const d = await describeObject(ctx.cfg, args.object_name);
    const exposed = d.fields.filter((f) => kindOf(f));
    const { columns: names } = assignColumns(exposed.map((f) => f.name));
    const byField = new Map(exposed.map((f, i) => [f.name, names[i]?.column]));
    return {
      rows: d.fields.map((f) => {
        const k = kindOf(f);
        return { ...f, __column: byField.get(f.name) ?? null, __duckdb: k ? sqlTypeOf(k, f.precision, f.scale) : null };
      }) as unknown as Row[],
      next: null,
    };
  },
  examples: [
    {
      sql: `SELECT name, sf_type, column_name, duckdb_type FROM ${Q}.describe_fields('Opportunity') WHERE custom ORDER BY name`,
      description: "Custom fields of Opportunity and their SQL columns",
    },
    {
      sql: `SELECT name, reference_to FROM ${Q}.describe_fields('Task') WHERE sf_type = 'reference' AND len(reference_to) > 1 ORDER BY name`,
      description: "Polymorphic lookups on Task (WhatId, WhoId …)",
    },
  ],
};

export const describeFields: VgiFunction = defineFixed(describeFieldsSpec);
