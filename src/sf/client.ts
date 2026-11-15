/**
 * Salesforce REST client: OAuth, retries, API-usage tracking and the quota guard.
 *
 * - **Auth.** A `salesforce` DuckDB secret carries the org's `instance_url` plus one
 *   OAuth flow: JWT bearer (`client_id` + `username` + `private_key`, the recommended
 *   server-to-server flow), client credentials (`client_id` + `client_secret`), a
 *   refresh token (`client_id` [+ `client_secret`] + `refresh_token`), or a
 *   pre-issued `access_token`. Username + password + security token is deliberately
 *   not supported. Tokens are cached in memory (never in scan state or logs) and a
 *   401 `INVALID_SESSION_ID` re-authenticates once.
 * - **Limits.** Every REST response's `Sforce-Limit-Info: api-usage=N/M` is recorded
 *   per org. Before each call the **quota guard** fails the scan loudly once usage
 *   reaches `quota_guard_pct` (ATTACH option, default 80) of the daily allowance,
 *   rather than spend the last of a quota shared with the org's production
 *   integrations. `REQUEST_LIMIT_EXCEEDED` for the daily total is never retried;
 *   concurrent-request limits, 429 and 5xx retry with backoff and `Retry-After`.
 * - **Origin pinning.** Credentials are only ever sent to the configured
 *   `instance_url` / `login_url` origins; `nextRecordsUrl` paths are resolved against
 *   the instance URL.
 */

import { createHash, createPrivateKey, sign } from "node:crypto";
import { secretOfType } from "@query-farm/vgi";
import { log } from "../log.ts";
import { VERSION } from "../meta.ts";

export const SECRET_TYPE = "salesforce";
export const DEFAULT_API_VERSION = "64.0";
export const DEFAULT_LOGIN_URL = "https://login.salesforce.com";
export const TIMEOUT_MS = 60_000;
export const MAX_ATTEMPTS = 5;
const MAX_RETRY_WAIT_MS = 30_000;
const USER_AGENT = `vgi-salesforce-worker/${VERSION}`;
export const README_AUTH = "https://github.com/Query-farm/vgi-salesforce#connect-an-org";

export class SalesforceError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly errorCode = "",
  ) {
    super(message);
  }
}

export type AuthFlow = "jwt_bearer" | "client_credentials" | "refresh_token" | "access_token";

export interface SfConfig {
  instanceUrl: string;
  loginUrl: string;
  apiVersion: string;
  flow: AuthFlow;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  privateKey?: string;
  refreshToken?: string;
  accessToken?: string;
  /** Fail before a call once api-usage reaches this % of the daily allowance (1–100). */
  quotaGuardPct: number;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Normalize a URL option: https, or http only for a loopback fixture server. */
export function normalizeUrl(raw: string, what: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SalesforceError(`salesforce secret: ${what} '${raw}' is not a URL (e.g. https://acme.my.salesforce.com)`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new SalesforceError(
      `salesforce secret: ${what} must use https:// (http:// is accepted only for 127.0.0.1/localhost)`,
    );
  }
  return url.origin;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** Build the client config from the `salesforce` secret DuckDB resolved for this call. */
export function configFromSecrets(secrets: Record<string, Record<string, unknown>>, quotaGuardPct = 80): SfConfig {
  const s = secretOfType(secrets as never, SECRET_TYPE) as Record<string, unknown> | undefined;
  if (!s) {
    throw new SalesforceError(
      "no salesforce secret: run CREATE SECRET (TYPE salesforce, INSTANCE_URL 'https://<domain>.my.salesforce.com', " +
        `CLIENT_ID '…', USERNAME '…', PRIVATE_KEY '…') — see ${README_AUTH}`,
    );
  }
  const instanceRaw = str(s.instance_url);
  if (!instanceRaw) throw new SalesforceError(`salesforce secret: instance_url is required (see ${README_AUTH})`);
  const apiVersion = (str(s.api_version) ?? DEFAULT_API_VERSION).replace(/^v/i, "");
  if (!/^\d{2,3}\.0$/.test(apiVersion)) {
    throw new SalesforceError(`salesforce secret: api_version must look like '64.0', got '${apiVersion}'`);
  }
  const cfg: Omit<SfConfig, "flow"> = {
    instanceUrl: normalizeUrl(instanceRaw, "instance_url"),
    loginUrl: normalizeUrl(str(s.login_url) ?? DEFAULT_LOGIN_URL, "login_url"),
    apiVersion,
    clientId: str(s.client_id),
    clientSecret: str(s.client_secret),
    username: str(s.username),
    privateKey: str(s.private_key),
    refreshToken: str(s.refresh_token),
    accessToken: str(s.access_token),
    quotaGuardPct,
  };
  let flow: AuthFlow;
  if (cfg.accessToken) flow = "access_token";
  else if (cfg.privateKey && cfg.clientId && cfg.username) flow = "jwt_bearer";
  else if (cfg.refreshToken && cfg.clientId) flow = "refresh_token";
  else if (cfg.clientId && cfg.clientSecret) flow = "client_credentials";
  else {
    throw new SalesforceError(
      "salesforce secret: set CLIENT_ID + USERNAME + PRIVATE_KEY (JWT bearer), CLIENT_ID + CLIENT_SECRET " +
        "(client credentials), CLIENT_ID + REFRESH_TOKEN, or ACCESS_TOKEN. Username/password login is not " +
        `supported. See ${README_AUTH}`,
    );
  }
  return { ...cfg, flow };
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

/** Sign the JWT bearer assertion (RS256): iss = client id, sub = username, aud = login URL. */
export function jwtAssertion(cfg: SfConfig, nowSeconds = Math.floor(Date.now() / 1000)): string {
  if (!cfg.clientId || !cfg.privateKey || !cfg.username) {
    throw new SalesforceError("salesforce secret: client_id, username and private_key are required for JWT bearer");
  }
  let key: ReturnType<typeof createPrivateKey>;
  try {
    const pem = cfg.privateKey.includes("\\n") ? cfg.privateKey.replace(/\\n/g, "\n") : cfg.privateKey;
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch (err) {
    throw new SalesforceError(`salesforce secret: private_key is not a PEM private key (${(err as Error).message})`);
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new SalesforceError(`salesforce secret: private_key must be an RSA key (got ${key.asymmetricKeyType})`);
  }
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iss: cfg.clientId, sub: cfg.username, aud: cfg.loginUrl, exp: nowSeconds + 180 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${b64url(sign("sha256", Buffer.from(input), key))}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();

function cacheKey(cfg: SfConfig): string {
  return createHash("sha256")
    .update(
      [cfg.flow, cfg.instanceUrl, cfg.loginUrl, cfg.clientId, cfg.username, cfg.privateKey, cfg.refreshToken].join(
        "\u0000",
      ),
    )
    .update(cfg.clientSecret ?? "")
    .digest("hex");
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

/** Obtain (or reuse) an access token for the configured flow. */
export async function accessToken(cfg: SfConfig): Promise<string> {
  if (cfg.flow === "access_token") return cfg.accessToken as string;
  const key = cacheKey(cfg);
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.token;
  const form = new URLSearchParams();
  // Client credentials must be exchanged at the org's own My Domain; the others at the login host.
  let tokenUrl = `${cfg.loginUrl}/services/oauth2/token`;
  if (cfg.flow === "jwt_bearer") {
    form.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
    form.set("assertion", jwtAssertion(cfg));
  } else if (cfg.flow === "refresh_token") {
    form.set("grant_type", "refresh_token");
    form.set("client_id", cfg.clientId as string);
    if (cfg.clientSecret) form.set("client_secret", cfg.clientSecret);
    form.set("refresh_token", cfg.refreshToken as string);
  } else {
    tokenUrl = `${cfg.instanceUrl}/services/oauth2/token`;
    form.set("grant_type", "client_credentials");
    form.set("client_id", cfg.clientId as string);
    form.set("client_secret", cfg.clientSecret as string);
  }
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: string; error_description?: string };
      detail = `${j.error ?? ""}: ${j.error_description ?? ""}`;
    } catch {}
    throw new SalesforceError(
      `Salesforce OAuth (${cfg.flow}) failed with HTTP ${res.status} (${detail}). Check the connected app — ${README_AUTH}`,
      res.status,
    );
  }
  const j = JSON.parse(text) as { access_token?: string };
  if (!j.access_token) throw new SalesforceError("Salesforce OAuth response had no access_token");
  // Salesforce does not return expires_in; sessions last at least 15 minutes, and a 401 re-auths.
  tokenCache.set(key, { token: j.access_token, expiresAt: Date.now() + 15 * 60_000 });
  return j.access_token;
}

// ---------------------------------------------------------------- usage + quota guard

export interface ApiUsage {
  used: number;
  max: number;
  at: number;
}
const usage = new Map<string, ApiUsage>();
export const USAGE_FRESH_MS = 60_000;

/** Parse `api-usage=18/15000` out of a Sforce-Limit-Info header. */
export function parseLimitInfo(header: string | null): { used: number; max: number } | null {
  const m = header?.match(/api-usage=(\d+)\/(\d+)/);
  return m ? { used: Number(m[1]), max: Number(m[2]) } : null;
}

export function lastUsage(cfg: SfConfig): ApiUsage | undefined {
  return usage.get(cfg.instanceUrl);
}

export function recordUsage(cfg: SfConfig, u: { used: number; max: number }): void {
  usage.set(cfg.instanceUrl, { ...u, at: Date.now() });
}

export function resetUsage(): void {
  usage.clear();
}

function guard(cfg: SfConfig): void {
  const u = usage.get(cfg.instanceUrl);
  if (!u || u.max <= 0 || cfg.quotaGuardPct >= 100) return;
  // A reading older than a minute is re-measured by letting one call through (usage is a
  // rolling 24-hour count, so a long-lived worker must not stay blocked on a stale value).
  if (Date.now() - u.at > USAGE_FRESH_MS) return;
  const pct = (100 * u.used) / u.max;
  if (pct >= cfg.quotaGuardPct) {
    throw new SalesforceError(
      `salesforce quota guard: the org has used ${u.used} of ${u.max} daily API requests (${pct.toFixed(1)}%), ` +
        `at or above quota_guard_pct ${cfg.quotaGuardPct}. Stopping rather than spend the rest of a quota shared ` +
        "with the org's integrations. Check meta.limits, or re-ATTACH with a higher quota_guard_pct.",
      0,
      "QUOTA_GUARD",
    );
  }
}

// ----------------------------------------------------------------------- requests

export interface SfResponse {
  status: number;
  headers: Headers;
  text: string;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string | undefined>;
  body?: unknown;
  accept?: string;
  /** Return 404 responses instead of throwing. */
  allow404?: boolean;
  /** Extra request headers (e.g. If-Modified-Since). */
  headers?: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve an API path (`/services/data/v64.0/...`, `sobjects/Account/describe`, or an absolute URL). */
export function resolveUrl(cfg: SfConfig, pathOrUrl: string, query?: Record<string, string | undefined>): string {
  let url: string;
  if (/^https?:\/\//.test(pathOrUrl)) url = pathOrUrl;
  else if (pathOrUrl.startsWith("/")) url = `${cfg.instanceUrl}${pathOrUrl}`;
  else url = `${cfg.instanceUrl}/services/data/v${cfg.apiVersion}/${pathOrUrl}`;
  if (new URL(url).origin !== cfg.instanceUrl) {
    throw new SalesforceError(`refusing to send Salesforce credentials to ${new URL(url).origin}`);
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, v);
  const q = qs.toString();
  return q ? `${url}${url.includes("?") ? "&" : "?"}${q}` : url;
}

interface SfErrorBody {
  message?: string;
  errorCode?: string;
}

function parseError(text: string): { code: string; message: string } {
  try {
    const j = JSON.parse(text) as SfErrorBody[] | SfErrorBody | { error?: string; error_description?: string };
    const first = Array.isArray(j) ? j[0] : j;
    if (first && "errorCode" in first) return { code: first.errorCode ?? "", message: first.message ?? "" };
    if (first && "error" in first) return { code: String(first.error), message: String(first.error_description ?? "") };
  } catch {}
  return { code: "", message: text.slice(0, 300) };
}

/** Show the path of a URL in errors, without the (possibly long) query string. */
function shortUrl(url: string): string {
  const u = new URL(url);
  return u.pathname.length > 120 ? `${u.pathname.slice(0, 120)}…` : u.pathname;
}

/** One authenticated request with retries, usage tracking and the quota guard. */
export async function sfRequest(cfg: SfConfig, pathOrUrl: string, opts: RequestOptions = {}): Promise<SfResponse> {
  const url = resolveUrl(cfg, pathOrUrl, opts.query);
  const method = opts.method ?? "GET";
  let reauthed = false;
  for (let attempt = 1; ; attempt++) {
    guard(cfg);
    let res: Response;
    try {
      const headers: Record<string, string> = {
        Accept: opts.accept ?? "application/json",
        Authorization: `Bearer ${await accessToken(cfg)}`,
        "User-Agent": USER_AGENT,
        ...opts.headers,
      };
      let body: string | undefined;
      if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.body);
      }
      res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if (err instanceof SalesforceError) throw err;
      if (attempt >= MAX_ATTEMPTS) {
        throw new SalesforceError(`${method} ${shortUrl(url)} failed: ${(err as Error).message}`);
      }
      await sleep(250 * 2 ** attempt);
      continue;
    }
    const li = parseLimitInfo(res.headers.get("Sforce-Limit-Info"));
    if (li) recordUsage(cfg, li);
    const text = await res.text();
    if (res.ok || res.status === 304) return { status: res.status, headers: res.headers, text };
    if (res.status === 404 && opts.allow404) return { status: 404, headers: res.headers, text };
    const err = parseError(text);
    if (res.status === 401 && !reauthed && cfg.flow !== "access_token") {
      tokenCache.delete(cacheKey(cfg));
      reauthed = true;
      attempt--;
      continue;
    }
    const daily = err.code === "REQUEST_LIMIT_EXCEEDED" && /TotalRequests|total requests/i.test(err.message);
    const retryable = !daily && (res.status === 429 || res.status >= 500 || err.code === "REQUEST_LIMIT_EXCEEDED");
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      const what = daily ? " (the org's daily API request limit is exhausted; it is never retried)" : "";
      throw new SalesforceError(
        `${method} ${shortUrl(url)} failed with HTTP ${res.status}: ${err.code ? `${err.code}: ` : ""}${err.message}${what}`,
        res.status,
        err.code,
      );
    }
    const retryAfter = res.headers.get("Retry-After");
    const delay =
      retryAfter && /^\d+$/.test(retryAfter)
        ? Math.min(Number(retryAfter) * 1000, MAX_RETRY_WAIT_MS)
        : Math.min(250 * 2 ** attempt, MAX_RETRY_WAIT_MS);
    log.debug(`salesforce: HTTP ${res.status} ${err.code} for ${shortUrl(url)}; retry ${attempt} in ${delay} ms`);
    await sleep(delay);
  }
}

/** GET (or POST) and parse JSON. */
export async function sfJson<T = unknown>(cfg: SfConfig, pathOrUrl: string, opts: RequestOptions = {}): Promise<T> {
  const res = await sfRequest(cfg, pathOrUrl, opts);
  return (res.text ? JSON.parse(res.text) : null) as T;
}
