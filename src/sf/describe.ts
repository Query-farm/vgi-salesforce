/**
 * Describe metadata: describeGlobal + per-object describe, cached per process.
 *
 * Per-object describe is lazy (fetched on the first bind that needs the object) and
 * cached for an hour; after that it is revalidated with `If-Modified-Since`, so an
 * unchanged object costs a 304 and no payload. describeGlobal is cached the same way.
 */

import { type SfConfig, sfRequest } from "./client.ts";

export interface SfPicklistValue {
  value: string;
  label: string | null;
  active: boolean;
  defaultValue: boolean;
}

export interface SfField {
  name: string;
  label: string;
  type: string;
  soapType: string;
  length: number;
  precision: number;
  scale: number;
  digits?: number;
  nillable: boolean;
  createable: boolean;
  updateable: boolean;
  filterable: boolean;
  sortable: boolean;
  groupable?: boolean;
  custom: boolean;
  calculated?: boolean;
  calculatedFormula?: string | null;
  referenceTo: string[];
  relationshipName: string | null;
  compoundFieldName?: string | null;
  picklistValues?: SfPicklistValue[];
}

export interface SfRecordTypeInfo {
  recordTypeId: string;
  developerName: string;
  name: string;
  active: boolean;
  available?: boolean;
  master?: boolean;
}

export interface SfDescribe {
  name: string;
  label: string;
  keyPrefix: string | null;
  custom: boolean;
  queryable: boolean;
  fields: SfField[];
  recordTypeInfos?: SfRecordTypeInfo[];
}

export interface SfGlobalObject {
  name: string;
  label: string;
  labelPlural?: string;
  keyPrefix: string | null;
  custom: boolean;
  queryable: boolean;
  createable: boolean;
  updateable?: boolean;
  deletable?: boolean;
  replicateable: boolean;
  retrieveable: boolean;
  searchable?: boolean;
  customSetting?: boolean;
}

interface Entry<T> {
  value: T;
  fetchedAt: number;
  httpDate: string;
}

export const DESCRIBE_TTL_MS = 3_600_000;
const describeCache = new Map<string, Entry<SfDescribe>>();
const globalCache = new Map<string, Entry<SfGlobalObject[]>>();
/** Count of describe HTTP calls made, for tests and the spike. */
export const describeStats = { calls: 0, notModified: 0, bytes: 0 };

export function clearDescribeCache(): void {
  describeCache.clear();
  globalCache.clear();
}

const keyOf = (cfg: SfConfig, name: string) => `${cfg.instanceUrl}|${cfg.apiVersion}|${name.toLowerCase()}`;

async function cachedGet<T>(
  cache: Map<string, Entry<T>>,
  key: string,
  cfg: SfConfig,
  path: string,
  parse: (body: unknown) => T,
  notFound?: () => T,
): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < DESCRIBE_TTL_MS) return hit.value;
  describeStats.calls++;
  const res = await sfRequest(cfg, path, {
    allow404: !!notFound,
    headers: hit ? { "If-Modified-Since": hit.httpDate } : {},
  });
  if (res.status === 404 && notFound) return notFound();
  if (res.status === 304 && hit) {
    describeStats.notModified++;
    hit.fetchedAt = Date.now();
    return hit.value;
  }
  describeStats.bytes += res.text.length;
  const value = parse(JSON.parse(res.text));
  cache.set(key, { value, fetchedAt: Date.now(), httpDate: new Date().toUTCString() });
  return value;
}

/** Every object in the org (describeGlobal). */
export async function describeGlobal(cfg: SfConfig): Promise<SfGlobalObject[]> {
  return cachedGet(
    globalCache,
    keyOf(cfg, "*global*"),
    cfg,
    "sobjects",
    (b) => (b as { sobjects: SfGlobalObject[] }).sobjects,
  );
}

export class UnknownObjectError extends Error {}

/** One object's describe, or an error naming the object when it does not exist. */
export async function describeObject(cfg: SfConfig, name: string): Promise<SfDescribe> {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
    throw new UnknownObjectError(`salesforce: '${name}' is not an object API name`);
  const d = await cachedGet(
    describeCache,
    keyOf(cfg, name),
    cfg,
    `sobjects/${encodeURIComponent(name)}/describe`,
    (b) => b as SfDescribe,
    () => null as unknown as SfDescribe,
  );
  if (!d) {
    throw new UnknownObjectError(
      `salesforce: object '${name}' does not exist in this org or is not visible to the connected user ` +
        "(see meta.objects for the full list)",
    );
  }
  return d;
}

/** Find a field by API name (case-insensitive, as SOQL is). */
export function fieldOf(d: SfDescribe, name: string): SfField | undefined {
  const lower = name.toLowerCase();
  return d.fields.find((f) => f.name.toLowerCase() === lower);
}

/** Find a reference field by its relationship name (`Account` for `AccountId`, `Owner__r` …). */
export function relationshipOf(d: SfDescribe, rel: string): SfField | undefined {
  const lower = rel.toLowerCase();
  return d.fields.find((f) => f.type === "reference" && f.relationshipName?.toLowerCase() === lower);
}
