/** Per-call context: the client config (secret + ATTACH options) and the journal directory. */

import { attachOptions } from "@query-farm/vgi";
import { configFromSecrets, type SfConfig } from "./client.ts";
import { defaultStateDir } from "./journal.ts";

export interface CallContext {
  cfg: SfConfig;
  stateDir: string;
}

function options(attach: Uint8Array | null | undefined): Record<string, unknown> {
  try {
    return { ...attachOptions(attach) } as Record<string, unknown>;
  } catch {
    return {};
  }
}

const opt = (o: Record<string, unknown>, name: string): unknown => {
  const k = Object.keys(o).find((x) => x.toLowerCase() === name);
  return k === undefined ? undefined : o[k];
};

export function quotaGuardPct(o: Record<string, unknown>): number {
  const v = Number(opt(o, "quota_guard_pct") ?? 80);
  return Number.isFinite(v) && v >= 1 && v <= 100 ? v : 80;
}

/** Build the context from a call's resolved secrets and its attach bytes. */
export function callContext(
  secrets: Record<string, Record<string, unknown>>,
  attach: Uint8Array | null | undefined,
): CallContext {
  const o = options(attach);
  const dir = opt(o, "state_dir");
  return {
    cfg: configFromSecrets(secrets, quotaGuardPct(o)),
    stateDir: typeof dir === "string" && dir.trim() ? dir.trim() : defaultStateDir(),
  };
}

/** The OBJECTS ATTACH option as a list of API names. */
export function attachObjects(attach: Uint8Array | null | undefined): string[] {
  const raw = opt(options(attach), "objects");
  return parseObjectList(typeof raw === "string" ? raw : "");
}

export function parseObjectList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (!name) continue;
    if (name === "*" || name.includes("*")) {
      throw new Error(
        "salesforce: OBJECTS takes an explicit list of object API names (e.g. 'Account,Contact,Invoice__c'); " +
          "wildcards are not supported in v1 — browse salesforce.meta.objects and list the ones you want",
      );
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
      throw new Error(`salesforce: OBJECTS entry '${name}' is not an object API name`);
    if (!out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}
