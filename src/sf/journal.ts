/**
 * The Bulk 2.0 / REST scan journal: one JSON file per query hash under the state
 * directory, rewritten after every page. It is what lets a later scan of the same
 * query (`resume := true`) continue a crashed extract from its saved locator, and it
 * backs the locator / records-seen columns of `meta.jobs`.
 *
 * Default directory: `$XDG_STATE_HOME/vgi-salesforce` (else `~/.local/state/vgi-salesforce`),
 * overridable with the `state_dir` ATTACH option. Entries hold no credentials.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface JournalEntry {
  query_sha256: string;
  instance_url: string;
  api_version: string;
  object_name: string;
  api: string;
  job_id: string;
  locator: string;
  next_records_url: string;
  records_seen: number;
  last_modstamp: string;
  last_ids: string[];
  resumable: boolean;
  state: "running" | "complete" | "failed";
  updated_at: string;
  error_message: string;
}

export function defaultStateDir(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "vgi-salesforce");
}

const fileOf = (dir: string, hash: string) => join(dir, `${hash}.json`);

export function readJournal(dir: string, hash: string): JournalEntry | null {
  try {
    return JSON.parse(readFileSync(fileOf(dir, hash), "utf8")) as JournalEntry;
  } catch {
    return null;
  }
}

export function writeJournal(dir: string, entry: JournalEntry): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${fileOf(dir, entry.query_sha256)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    renameSync(tmp, fileOf(dir, entry.query_sha256));
  } catch {
    // The journal is best-effort: an unwritable state dir only disables resume.
  }
}

export function listJournal(dir: string): JournalEntry[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  for (const n of names) {
    const e = readJournal(dir, n.slice(0, -5));
    if (e) out.push(e);
  }
  return out;
}
