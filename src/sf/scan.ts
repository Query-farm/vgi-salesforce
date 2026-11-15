/**
 * The scan engine shared by `soql()` and `query_object()` (and so every
 * `sobjects.<Object>` view): REST `query` / `queryMore` or a Bulk API 2.0 query job,
 * with the cursor in serializable scan state.
 *
 * **REST**: `GET query?q=` (or `queryAll` with `include_deleted`), then each
 * `nextRecordsUrl` until `done`. **Bulk 2.0**: `POST jobs/query` → poll
 * `GET jobs/query/{id}` (1 s → 20 s backoff) until `JobComplete` →
 * `GET …/results?maxRecords=N&locator=L`, following `Sforce-Locator` until it is
 * `null`. **auto** runs the REST query first and, when the first page reports
 * `totalSize` above `bulk_threshold` (and more pages remain), discards it and moves the
 * scan to a Bulk job; a `LIMIT 5` therefore never waits for a Bulk poll.
 *
 * **State** = `{phase, api, next, jobId, locator, seen, lastModstamp, lastIds, …}`. It
 * rides the HTTP transport, and is also journalled per query hash so `resume := true`
 * can continue a crashed scan from its saved job + locator.
 *
 * **Expiry.** Bulk results stay retrievable for 7 days after the job completes and a
 * locator is stable for the job's lifetime, so an "expired locator" is a vanished job
 * (404 NOT_FOUND); an idle REST cursor expires with INVALID_QUERY_LOCATOR. Either way a
 * *resumable* scan (ordered by SystemModstamp, Id — every `query_object` scan without a
 * custom order_by) re-submits with `SystemModstamp >= :last_modstamp` and drops the
 * rows whose Id is in the ring of Ids already emitted at the same second as the last modstamp, which is
 * correct under ties. A non-resumable scan fails with a clear error instead of
 * silently re-reading.
 */

import { createHash } from "node:crypto";
import { log } from "../log.ts";
import { SalesforceError, type SfConfig, sfJson, sfRequest } from "./client.ts";
import { parseCsv } from "./csv.ts";
import { type JournalEntry, readJournal, writeJournal } from "./journal.ts";
import { soqlDateTime } from "./pushdown.ts";
import { atPath, type ColumnSpec, readColumn, toMicros } from "./types.ts";

export type Api = "auto" | "rest" | "bulk";

export interface ScanPlan {
  /** The SOQL submitted on a fresh start. */
  soql: string;
  object: string;
  columns: ColumnSpec[];
  api: Api;
  includeDeleted: boolean;
  /** Aggregate queries are REST-only (Bulk 2.0 does not run them). */
  aggregate: boolean;
  /** `SELECT COUNT() …`: one row with the totalSize. */
  countOnly: boolean;
  /** Rebuild the query to resume at a modstamp (null = not resumable). */
  resumeQuery: ((sinceSoqlDateTime: string) => string) | null;
  bulkThreshold: number;
  bulkPageSize: number;
  stateDir: string | null;
  resume: boolean;
}

export interface ScanState {
  phase: string;
  api: string;
  next: string;
  jobId: string;
  locator: string;
  seen: number;
  lastModstamp: string;
  lastIds: string[];
  polls: number;
  resubmits: number;
  query: string;
}

export function initialScanState(): ScanState {
  return {
    phase: "start",
    api: "",
    next: "",
    jobId: "",
    locator: "",
    seen: 0,
    lastModstamp: "",
    lastIds: [],
    polls: 0,
    resubmits: 0,
    query: "",
  };
}

export const MAX_RING = 50_000;
const MAX_RESUBMITS = 5;

/** Telemetry for tests and EXPLAIN: what the last scans did. */
export const scanStats = { restPages: 0, bulkJobs: 0, bulkPages: 0, resubmits: 0, switchedToBulk: 0 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function queryHash(cfg: SfConfig, soql: string, includeDeleted: boolean): string {
  return createHash("sha256").update(`${cfg.instanceUrl}\n${cfg.apiVersion}\n${includeDeleted}\n${soql}`).digest("hex");
}

/** One page of rows: `get(row, path)` reads a SOQL path's raw value. */
interface Page {
  rows: unknown[];
  get: (row: unknown, path: string) => unknown;
}

const restGet = (row: unknown, path: string) => atPath(row, path);

function csvPage(text: string): Page {
  const all = parseCsv(text);
  const header = (all[0] ?? []).map((h) => h.toLowerCase());
  const idx = new Map(header.map((h, i) => [h, i]));
  return {
    rows: all.slice(1).filter((r) => !(r.length === 1 && r[0] === "")),
    get: (row, path) => {
      const i = idx.get(path.toLowerCase());
      if (i === undefined) return null;
      const v = (row as string[])[i];
      return v === undefined || v === "" ? null : v;
    },
  };
}

interface RestQueryResult {
  totalSize: number;
  done: boolean;
  nextRecordsUrl?: string;
  records: unknown[];
}

interface BulkJob {
  id: string;
  state: string;
  errorMessage?: string;
  numberRecordsProcessed?: number;
}

export class Scan {
  readonly hash: string;

  constructor(
    private readonly cfg: SfConfig,
    private readonly plan: ScanPlan,
    private readonly state: ScanState,
  ) {
    this.hash = queryHash(cfg, plan.soql, plan.includeDeleted);
  }

  private journal(extra: Partial<JournalEntry> = {}): void {
    if (!this.plan.stateDir) return;
    const s = this.state;
    writeJournal(this.plan.stateDir, {
      query_sha256: this.hash,
      instance_url: this.cfg.instanceUrl,
      api_version: this.cfg.apiVersion,
      object_name: this.plan.object,
      api: s.api,
      job_id: s.jobId,
      locator: s.locator,
      next_records_url: s.next,
      records_seen: s.seen,
      last_modstamp: s.lastModstamp,
      last_ids: s.lastIds.slice(0, 1000),
      resumable: this.plan.resumeQuery !== null,
      state: s.phase === "done" ? "complete" : "running",
      updated_at: new Date().toISOString(),
      error_message: "",
      ...extra,
    });
  }

  /** Mark the journal entry failed (called when a scan step throws). */
  fail(err: unknown): void {
    this.journal({ state: "failed", error_message: (err as Error).message.slice(0, 500) });
  }

  private async submitBulk(query: string): Promise<void> {
    const job = await sfJson<BulkJob>(this.cfg, "jobs/query", {
      method: "POST",
      body: {
        operation: this.plan.includeDeleted ? "queryAll" : "query",
        query,
        contentType: "CSV",
        columnDelimiter: "COMMA",
        lineEnding: "LF",
      },
    });
    scanStats.bulkJobs++;
    Object.assign(this.state, { api: "bulk", phase: "poll", jobId: job.id, locator: "", polls: 0, query });
    this.journal();
  }

  private restPath(query: string): { path: string; query: Record<string, string> } {
    return { path: this.plan.includeDeleted ? "queryAll" : "query", query: { q: query } };
  }

  /** Expired job / cursor: re-submit from the last modstamp, or fail for non-resumable scans. */
  private async recover(reason: string): Promise<void> {
    const s = this.state;
    if (!this.plan.resumeQuery) {
      throw new SalesforceError(
        `salesforce: ${reason}, and this query is not resumable (it needs Id and SystemModstamp selected and ` +
          "ORDER BY SystemModstamp, Id). Re-run the query; nothing was re-read silently.",
      );
    }
    if (++s.resubmits > MAX_RESUBMITS)
      throw new SalesforceError(`salesforce: ${reason} (gave up after ${MAX_RESUBMITS} re-submits)`);
    scanStats.resubmits++;
    const q = s.lastModstamp ? this.plan.resumeQuery(s.lastModstamp) : this.plan.soql;
    log.warn(
      `salesforce: ${reason}; re-submitting from SystemModstamp >= ${s.lastModstamp || "(start)"} ` +
        `and skipping ${s.lastIds.length} already-emitted Id(s) at that instant`,
    );
    if (s.api === "bulk") await this.submitBulk(q);
    else {
      s.query = q;
      s.next = "";
      s.phase = "rest_first";
    }
  }

  /** Drop rows already emitted (ring de-dup) and advance the modstamp ring. */
  private admit(page: Page): unknown[] {
    const s = this.state;
    if (!this.plan.resumeQuery) return page.rows;
    const out: unknown[] = [];
    for (const row of page.rows) {
      const ms = page.get(row, "SystemModstamp");
      const id = page.get(row, "Id");
      const us = toMicros(ms);
      const iso = us === null ? "" : soqlDt(us);
      if (iso && iso === s.lastModstamp && typeof id === "string" && s.lastIds.includes(id)) continue;
      if (iso && iso !== s.lastModstamp) {
        // Rows arrive in SystemModstamp order, so a new instant starts a new ring.
        if (s.lastModstamp && iso < s.lastModstamp) {
          // Out of order (a record modified mid-scan): keep it, leave the ring alone.
        } else {
          s.lastModstamp = iso;
          s.lastIds = [];
        }
      }
      if (iso === s.lastModstamp && typeof id === "string") {
        s.lastIds.push(id);
        if (s.lastIds.length > MAX_RING) {
          throw new SalesforceError(
            `salesforce: more than ${MAX_RING} records share SystemModstamp ${iso}; the scan cannot resume safely`,
          );
        }
      }
      out.push(row);
    }
    return out;
  }

  private resumeFromJournal(): boolean {
    if (!this.plan.resume || !this.plan.stateDir) return false;
    const e = readJournal(this.plan.stateDir, this.hash);
    if (!e || e.state === "complete") return false;
    const s = this.state;
    s.api = e.api;
    s.seen = e.records_seen;
    s.lastModstamp = e.last_modstamp;
    s.lastIds = e.last_ids ?? [];
    s.jobId = e.job_id;
    s.locator = e.locator;
    s.next = e.next_records_url;
    s.query = this.plan.soql;
    s.phase =
      e.api === "bulk" ? (e.job_id ? "resume_bulk" : "start_bulk") : e.next_records_url ? "rest" : "resume_rest";
    log.info(`salesforce: resuming journalled scan ${this.hash.slice(0, 12)} (${e.records_seen} records already read)`);
    return true;
  }

  /** Advance the scan by one page. Returns rows to emit (maybe none) or null when finished. */
  async step(): Promise<Page | null> {
    const s = this.state;
    const p = this.plan;
    for (;;) {
      switch (s.phase) {
        case "start": {
          if (this.resumeFromJournal()) continue;
          s.query = p.soql;
          if (p.api === "bulk") {
            if (p.aggregate)
              throw new SalesforceError(
                "salesforce: aggregate queries cannot run as Bulk API 2.0 jobs; use api := 'rest'",
              );
            await this.submitBulk(p.soql);
            continue;
          }
          s.api = "rest";
          s.phase = "rest_first";
          continue;
        }
        case "start_bulk":
          await this.submitBulk(s.query || p.soql);
          continue;
        case "resume_rest":
          await this.recover("the journalled REST cursor is gone");
          continue;
        case "resume_bulk": {
          const res = await sfRequest(this.cfg, `jobs/query/${s.jobId}`, { allow404: true });
          if (res.status === 404) {
            await this.recover(`journalled Bulk job ${s.jobId} no longer exists (results are kept 7 days)`);
          } else {
            const job = JSON.parse(res.text) as BulkJob;
            s.phase = job.state === "JobComplete" ? "results" : "poll";
          }
          continue;
        }
        case "rest_first": {
          const r = this.restPath(s.query);
          const res = await sfJson<RestQueryResult>(this.cfg, r.path, { query: r.query });
          scanStats.restPages++;
          if (p.countOnly) {
            s.phase = "done";
            this.journal();
            return { rows: [{ __count: res.totalSize }], get: (row) => (row as { __count: number }).__count };
          }
          if (p.api === "auto" && !p.aggregate && !res.done && res.totalSize > p.bulkThreshold && s.resubmits === 0) {
            scanStats.switchedToBulk++;
            log.info(
              `salesforce: ${res.totalSize} rows > bulk_threshold ${p.bulkThreshold}; switching to Bulk API 2.0`,
            );
            await this.submitBulk(s.query);
            continue;
          }
          return this.restPage(res);
        }
        case "rest": {
          let res: RestQueryResult;
          try {
            res = await sfJson<RestQueryResult>(this.cfg, s.next);
          } catch (err) {
            if (err instanceof SalesforceError && err.errorCode === "INVALID_QUERY_LOCATOR") {
              await this.recover("the REST query cursor expired (INVALID_QUERY_LOCATOR)");
              continue;
            }
            throw err;
          }
          scanStats.restPages++;
          return this.restPage(res);
        }
        case "poll": {
          const res = await sfRequest(this.cfg, `jobs/query/${s.jobId}`, { allow404: true });
          if (res.status === 404) {
            await this.recover(`Bulk job ${s.jobId} vanished while running`);
            continue;
          }
          const job = JSON.parse(res.text) as BulkJob;
          if (job.state === "JobComplete") {
            s.phase = "results";
            continue;
          }
          if (job.state === "Failed" || job.state === "Aborted") {
            throw new SalesforceError(`salesforce: Bulk job ${s.jobId} ${job.state}: ${job.errorMessage ?? ""}`);
          }
          s.polls++;
          await sleep(Math.min(1000 * 2 ** Math.min(s.polls - 1, 5), 20_000));
          continue;
        }
        case "results": {
          const res = await sfRequest(this.cfg, `jobs/query/${s.jobId}/results`, {
            accept: "text/csv",
            allow404: true,
            query: { maxRecords: String(p.bulkPageSize), locator: s.locator || undefined },
          });
          if (res.status === 404) {
            await this.recover(`Bulk job ${s.jobId} (or its locator) expired`);
            continue;
          }
          scanStats.bulkPages++;
          const loc = res.headers.get("Sforce-Locator");
          const page = csvPage(res.text);
          const rows = this.admit(page);
          s.seen += rows.length;
          if (!loc || loc === "null") s.phase = "done";
          else s.locator = loc;
          this.journal();
          return { rows, get: page.get };
        }
        case "done":
          return null;
        default:
          throw new SalesforceError(`salesforce: corrupt scan state '${s.phase}'`);
      }
    }
  }

  private restPage(res: RestQueryResult): Page {
    const s = this.state;
    const page: Page = { rows: res.records ?? [], get: restGet };
    const rows = this.admit(page);
    s.seen += rows.length;
    if (res.done || !res.nextRecordsUrl) {
      s.phase = "done";
      s.next = "";
    } else {
      s.phase = "rest";
      s.next = res.nextRecordsUrl;
    }
    this.journal();
    return { rows, get: restGet };
  }
}

/**
 * Epoch µs → the whole-second SOQL datetime literal of its second. The resume ring is
 * keyed by that second (SOQL datetime literals carry no fractional seconds), so
 * re-submitting with `SystemModstamp >= <second>` plus the ring is exact.
 */
export function soqlDt(us: bigint): string {
  return soqlDateTime(us - (((us % 1_000_000n) + 1_000_000n) % 1_000_000n));
}

/** Build a page's output columns for the projected schema. */
export function pageColumns(
  page: { rows: unknown[]; get: (row: unknown, path: string) => unknown },
  fieldNames: string[],
  byColumn: Map<string, ColumnSpec>,
): Record<string, unknown[]> {
  const cols: Record<string, unknown[]> = {};
  for (const name of fieldNames) {
    const c = byColumn.get(name);
    cols[name] = c ? page.rows.map((r) => readColumn(c, (path) => page.get(r, path))) : page.rows.map(() => null);
  }
  return cols;
}
