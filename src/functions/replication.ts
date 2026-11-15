/**
 * `updated_ids()` / `deleted_ids()`: the REST getUpdated / getDeleted endpoints that make
 * incremental replication delete-aware, within their honest retention bounds.
 *
 * Windows longer than 30 days are split into 30-day requests (the API's maximum).
 * `deleted_ids` fails loudly when `start_date` is older than the org reports deleted
 * records are available (`earliestDateAvailable`, the recycle-bin retention, nominally 15
 * days): beyond that a delete set would be silently incomplete and a full reload is the
 * only correct answer.
 */

import { timestampMicros, utf8, type VgiFunction } from "@query-farm/vgi";
import { SalesforceError, sfJson } from "../sf/client.ts";
import type { CallContext } from "../sf/context.ts";
import { toMicros } from "../sf/types.ts";
import { Q } from "./common.ts";
import { C, defineFixed, type PageResult } from "./fixed.ts";

const WINDOW_US = 30n * 86_400_000_000n;

type Args = {
  object_name: string;
  start_date: bigint;
  end_date: bigint;
};

const iso = (us: bigint) => `${new Date(Number(us / 1000n)).toISOString().slice(0, 19)}+00:00`;

function windows(args: Args): [bigint, bigint][] {
  const start = BigInt(args.start_date);
  const end = BigInt(args.end_date);
  if (end <= start) throw new SalesforceError("salesforce: end_date must be after start_date");
  const out: [bigint, bigint][] = [];
  for (let s = start; s < end; s += WINDOW_US) {
    const e = s + WINDOW_US;
    // biome-ignore lint/complexity/useMathMinMax: bigint operands (Math.min takes numbers).
    out.push([s, e > end ? end : e]);
  }
  return out;
}

const objectPath = (o: string) => {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(o)) throw new SalesforceError(`salesforce: '${o}' is not an object API name`);
  return `sobjects/${o}`;
};

async function updatedPage(ctx: CallContext, args: Args, cursor: string): Promise<PageResult> {
  const w = windows(args);
  const i = cursor ? Number(cursor) : 0;
  const win = w[i];
  if (!win) return { rows: [], next: null };
  const body = await sfJson<{ ids: string[]; latestDateCovered: string }>(
    ctx.cfg,
    `${objectPath(args.object_name)}/updated/`,
    {
      query: { start: iso(win[0]), end: iso(win[1]) },
    },
  );
  return {
    rows: (body.ids ?? []).map((id) => ({ id, latest: body.latestDateCovered })),
    next: i + 1 < w.length ? String(i + 1) : null,
  };
}

async function deletedPage(ctx: CallContext, args: Args, cursor: string): Promise<PageResult> {
  const w = windows(args);
  const i = cursor ? Number(cursor) : 0;
  const win = w[i];
  if (!win) return { rows: [], next: null };
  const body = await sfJson<{
    deletedRecords: { id: string; deletedDate: string }[];
    earliestDateAvailable?: string;
    latestDateCovered?: string;
  }>(ctx.cfg, `${objectPath(args.object_name)}/deleted/`, { query: { start: iso(win[0]), end: iso(win[1]) } });
  if (i === 0 && body.earliestDateAvailable) {
    const earliest = toMicros(body.earliestDateAvailable);
    if (earliest !== null && BigInt(args.start_date) < earliest) {
      throw new SalesforceError(
        `salesforce: deleted_ids start_date ${iso(BigInt(args.start_date))} is before the earliest date ${body.earliestDateAvailable} ` +
          `for which ${args.object_name} deletions are still available (recycle-bin retention). The delete set would be ` +
          "incomplete: do a full reload instead of an incremental one.",
      );
    }
  }
  return {
    rows: (body.deletedRecords ?? []).map((r) => ({ id: r.id, deleted: r.deletedDate })),
    next: i + 1 < w.length ? String(i + 1) : null,
  };
}

const ARGS = { object_name: utf8(), start_date: timestampMicros("UTC"), end_date: timestampMicros("UTC") };
const ARG_DOCS = {
  object_name: "Object API name (must be replicateable, see meta.objects).",
  start_date: "Window start (inclusive). Longer than 30 days is split automatically.",
  end_date: "Window end.",
};

export const updatedIds: VgiFunction = defineFixed<Args>({
  name: "updated_ids",
  description: "Ids of records of an object created or updated in a time window (REST getUpdated)",
  title: "Updated Record IDs",
  category: "replication",
  keywords: "salesforce, getupdated, incremental, replication, changed records, cdc, sync",
  docLlm:
    "updated_ids(object_name, start_date, end_date) returns sf_id and latest_date_covered for every record of the object " +
    "created or updated in the window, via /sobjects/<o>/updated (windows over 30 days are chunked). Salesforce only " +
    "answers for roughly the last 30 days. Pair with deleted_ids for a delete-aware incremental sync.",
  docMd: "## updated_ids(object_name, start_date, end_date)\n\nREST getUpdated, chunked into 30-day windows.",
  args: ARGS,
  argDocs: ARG_DOCS,
  cols: [
    C.str("sf_id", "Record id (18 characters).", "id", false),
    C.time("latest_date_covered", "The window end Salesforce guarantees complete.", "latest"),
  ],
  page: (ctx, args, cursor) => updatedPage(ctx, args, cursor),
  examples: [
    {
      sql: `SELECT count(*) AS changed FROM ${Q}.updated_ids('Opportunity', now() - INTERVAL 1 DAY, now())`,
      description: "How many opportunities changed in the last day",
    },
  ],
});

export const deletedIds: VgiFunction = defineFixed<Args>({
  name: "deleted_ids",
  description:
    "Ids of records of an object deleted in a time window (REST getDeleted); errors outside recycle-bin retention",
  title: "Deleted Record IDs",
  category: "replication",
  keywords: "salesforce, getdeleted, deletes, incremental, replication, recycle bin, sync, drift",
  docLlm:
    "deleted_ids(object_name, start_date, end_date) returns sf_id and deleted_date for every record of the object deleted " +
    "in the window, via /sobjects/<o>/deleted. Apply it to a local replica (DELETE … WHERE id IN (SELECT sf_id …)) so " +
    "deletes and merges do not drift. Fails with an explicit error if start_date is older than the org's " +
    "earliestDateAvailable (recycle-bin retention, ~15 days): then only a full reload is correct.",
  docMd:
    "## deleted_ids(object_name, start_date, end_date)\n\nREST getDeleted. Correct incremental deletes **within retention**, " +
    "and an explicit error outside it rather than a quietly incomplete set.",
  args: ARGS,
  argDocs: ARG_DOCS,
  cols: [
    C.str("sf_id", "Deleted record id.", "id", false),
    C.time("deleted_date", "When the record was deleted.", "deleted"),
  ],
  page: (ctx, args, cursor) => deletedPage(ctx, args, cursor),
  examples: [
    {
      sql: `SELECT sf_id, deleted_date FROM ${Q}.deleted_ids('Opportunity', now() - INTERVAL 7 DAY, now()) ORDER BY deleted_date`,
      description: "Opportunities deleted this week (to remove from a replica)",
    },
  ],
});
