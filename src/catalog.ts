/**
 * The `salesforce` catalog: `main` (functions), `meta` (org metadata tables) and
 * `sobjects` (one view per object in the ATTACH `OBJECTS` list).
 *
 * The `sobjects` views are `SELECT * FROM main.query_object('<Object>')`. Their columns
 * are bound when a query uses them, through query_object's bind — which is where the
 * `salesforce` secret is available — so ATTACH makes no API calls at all, `SHOW TABLES`
 * costs nothing per object, and each object's describe is fetched lazily on first use
 * (then cached). That is the Gate 0 design decision; see the README's scale section.
 */

import {
  type AttachOpaqueData,
  type AttachOptionSpec,
  type CatalogAttachResult,
  type CatalogDescriptor,
  type FunctionRegistry,
  int32,
  ReadOnlyCatalogInterface,
  type SchemaInfo,
  type TransactionOpaqueData,
  utf8,
  type VgiFunction,
  type ViewInfo,
} from "@query-farm/vgi";
import { ID_FUNCTIONS } from "./functions/idfns.ts";
import { lookup, picklistValues, record } from "./functions/lookup.ts";
import { describeFields, META_TABLES } from "./functions/metadata.ts";
import { queryObject, soql } from "./functions/query.ts";
import { deletedIds, updatedIds } from "./functions/replication.ts";
import {
  CATALOG_COMMENT,
  CATALOG_NAME,
  CATALOG_TAGS,
  keywordsArray,
  META_DOC_LLM,
  SCHEMA_CATEGORIES,
  SCHEMA_DOC_MD,
  SCHEMA_TAGS,
  SOBJECTS_DOC_LLM,
  SOURCE_URL,
} from "./meta.ts";
import { SALESFORCE_SECRET_TYPE } from "./secret.ts";
import { parseObjectList } from "./sf/context.ts";

export const FUNCTIONS: VgiFunction[] = [
  ...ID_FUNCTIONS,
  soql,
  queryObject,
  describeFields,
  updatedIds,
  deletedIds,
  record,
  lookup,
  picklistValues,
];

export const ATTACH_OPTIONS: AttachOptionSpec[] = [
  {
    name: "objects",
    description:
      "Comma-separated object API names to expose as sobjects.<Object> views, e.g. 'Account,Contact,Opportunity,Invoice__c'. " +
      "Empty (the default) gives the functions and meta tables only; browse meta.objects, then re-attach.",
    type: utf8(),
    default: "",
  },
  {
    name: "quota_guard_pct",
    description:
      "Fail a scan before an API call once the org's daily API usage (Sforce-Limit-Info) reaches this percentage (1-100).",
    type: int32 as never,
    default: 80,
  },
  {
    name: "state_dir",
    description:
      "Directory for the Bulk/REST scan journal used by resume := true and meta.jobs (default $XDG_STATE_HOME/vgi-salesforce).",
    type: utf8(),
    default: "",
  },
];

interface Example {
  description: string;
  sql: string;
}

function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const byName = new Map<string, Example[]>();
  for (const fn of functions) {
    const bucket = byName.get(fn.meta.name) ?? [];
    byName.set(fn.meta.name, bucket);
    for (const ex of fn.meta.examples ?? []) {
      if (!bucket.some((e) => e.sql === ex.sql)) bucket.push({ description: ex.description, sql: ex.sql });
    }
  }
  for (const fn of functions) {
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(byName.get(fn.meta.name)) };
  }
  return [...byName.values()].flat();
}

const FN_EXAMPLES = stampExampleQueries(FUNCTIONS);
const META_EXAMPLES = META_TABLES.flatMap((t) => JSON.parse(t.tags?.["vgi.example_queries"] ?? "[]") as Example[]);

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_COMMENT,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  attachOptions: ATTACH_OPTIONS,
  secretTypes: [SALESFORCE_SECRET_TYPE],
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_DOC_MD,
      functions: FUNCTIONS,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(FN_EXAMPLES.slice(0, 12)) },
    },
    {
      path: ["meta"],
      comment:
        "Org metadata: objects, columns, picklists, record types, users, profiles, permission sets, limits, Bulk jobs, org.",
      tables: META_TABLES,
      tags: {
        "vgi.title": "Salesforce Metadata",
        domain: "crm",
        "vgi.keywords": keywordsArray(
          "salesforce, metadata, describe, limits, users, profiles, permission sets, bulk jobs",
        ),
        "vgi.doc_llm": META_DOC_LLM,
        "vgi.doc_md": "## meta\n\nOrg metadata tables. All need a `salesforce` secret.",
        "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
        "vgi.example_queries": JSON.stringify(META_EXAMPLES.slice(0, 12)),
      },
    },
    {
      path: ["sobjects"],
      comment: "One view per object in the ATTACH OBJECTS list; SQL filters and projections are pushed into SOQL.",
      tags: {
        "vgi.title": "Salesforce Objects",
        domain: "crm",
        "vgi.keywords": keywordsArray("salesforce, sobjects, accounts, opportunities, contacts, custom objects, views"),
        "vgi.doc_llm": SOBJECTS_DOC_LLM,
        "vgi.doc_md":
          "## sobjects\n\nOne view per object in `OBJECTS`, e.g. `ATTACH 'salesforce' (TYPE vgi, LOCATION '…', OBJECTS 'Account,Opportunity')`.",
        "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
        "vgi.example_queries": JSON.stringify([
          {
            description: "Won pipeline by account, from two object views",
            sql: "SELECT a.name, sum(o.amount) AS won FROM salesforce.sobjects.Opportunity o JOIN salesforce.sobjects.Account a ON a.id = o.account_id WHERE o.is_won GROUP BY a.name ORDER BY won DESC",
          },
        ]),
      },
    },
  ],
};

const SOBJECTS = "sobjects";
const isSobjects = (path: string[]) => path.length === 1 && path[0]?.toLowerCase() === SOBJECTS;
const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

function objectView(name: string): ViewInfo {
  return {
    name,
    schema_path: [SOBJECTS],
    comment: `Salesforce ${name} records (query_object('${name}')): typed from describe, filters and projections pushed into SOQL.`,
    tags: { "vgi.title": `${name} records`, "salesforce.object": name },
    definition: `SELECT * FROM main.query_object(${sqlString(name)})`,
    column_comments: {},
    aliases: [],
    security: "regular",
  } as unknown as ViewInfo;
}

/** A stub for an object outside the OBJECTS scope: binds, and fails with a pointer when read. */
function scopeStub(name: string, objects: string[]): ViewInfo {
  const msg =
    `salesforce: object '${name}' is not in the ATTACH OBJECTS scope. Re-attach with OBJECTS ` +
    `'${[...objects, name].join(",")}' (see salesforce.meta.objects for the full list), or query it directly ` +
    `with salesforce.main.query_object('${name}').`;
  return {
    ...objectView(name),
    comment: `${name} is not in the ATTACH OBJECTS scope.`,
    definition: `SELECT error(${sqlString(msg)}) AS out_of_scope`,
  } as ViewInfo;
}

export class SalesforceCatalog extends ReadOnlyCatalogInterface {
  override perAttachItemIds = true;
  override catalogContentsAttachIndependent = false;
  override supportsCatalogContents = false;

  constructor(descriptor: CatalogDescriptor, registry: FunctionRegistry) {
    super(descriptor, registry, { perAttachItemIds: true });
  }

  override attachOptionSpecs(_name: string): AttachOptionSpec[] {
    return ATTACH_OPTIONS;
  }

  override async attach(
    name: string,
    options?: Record<string, unknown>,
    dataVersionSpec?: string | null,
    implementationVersion?: string | null,
    clientCapabilities?: Uint8Array | null,
  ): Promise<CatalogAttachResult> {
    // Validate OBJECTS up front so a typo fails the ATTACH, not the first query.
    parseObjectList(String(options?.objects ?? ""));
    const pct = Number(options?.quota_guard_pct ?? 80);
    if (!Number.isInteger(pct) || pct < 1 || pct > 100)
      throw new Error(`quota_guard_pct must be 1-100, got ${options?.quota_guard_pct}`);
    return super.attach(name, options, dataVersionSpec, implementationVersion, clientCapabilities);
  }

  private objects(attach: AttachOpaqueData): string[] {
    const o = this.attachOptions(attach) as Record<string, unknown>;
    const k = Object.keys(o).find((x) => x.toLowerCase() === "objects");
    return parseObjectList(k ? String(o[k] ?? "") : "");
  }

  private withViewCount(info: SchemaInfo, attach: AttachOpaqueData): SchemaInfo {
    if (!isSobjects(info.path)) return info;
    return { ...info, estimated_object_count: { ...info.estimated_object_count, view: this.objects(attach).length } };
  }

  override async schemas(attach: AttachOpaqueData, tx?: TransactionOpaqueData): Promise<SchemaInfo[]> {
    return (await super.schemas(attach, tx)).map((s) => this.withViewCount(s, attach));
  }

  override async schemaGet(
    attach: AttachOpaqueData,
    path: string[],
    tx?: TransactionOpaqueData,
  ): Promise<SchemaInfo | null> {
    const info = await super.schemaGet(attach, path, tx);
    return info ? this.withViewCount(info, attach) : null;
  }

  override async schemaContentsViews(
    attach: AttachOpaqueData,
    path: string[],
    tx?: TransactionOpaqueData,
  ): Promise<ViewInfo[]> {
    if (!isSobjects(path)) return super.schemaContentsViews(attach, path, tx);
    return this.objects(attach).map(objectView);
  }

  override async viewGet(
    attach: AttachOpaqueData,
    path: string[],
    name: string,
    tx?: TransactionOpaqueData,
  ): Promise<ViewInfo | null> {
    if (!isSobjects(path)) return super.viewGet(attach, path, name, tx);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return null;
    const objects = this.objects(attach);
    const hit = objects.find((o) => o.toLowerCase() === name.toLowerCase());
    return hit ? objectView(hit) : scopeStub(name, objects);
  }
}
