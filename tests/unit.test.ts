// Unit tests for the pure logic. SQL-level tests live in test/sql and run through DuckDB.

import { describe, expect, test } from "bun:test";
import { buildObjectSoql, withCondition } from "../src/functions/query.ts";
import { configFromSecrets, jwtAssertion, parseLimitInfo } from "../src/sf/client.ts";
import { parseObjectList } from "../src/sf/context.ts";
import { parseCsv } from "../src/sf/csv.ts";
import { checksum, id15, id18, isValidId, keyPrefix, objectOf, soqlLikeEscape, soqlLiteral } from "../src/sf/ids.ts";
import { assignColumns, mangle } from "../src/sf/naming.ts";
import { soqlDateTime } from "../src/sf/pushdown.ts";
import { soqlDt } from "../src/sf/scan.ts";
import { findClauses, parseSoql, SoqlGrammarError } from "../src/sf/soql_parse.ts";
import { convert, kindOf, toMicros, toUnscaled } from "../src/sf/types.ts";

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function randomId15(seed: number): string {
  let s = "";
  let x = seed;
  for (let i = 0; i < 15; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    s += B62[x % 62];
  }
  return s;
}

describe("ID toolkit", () => {
  test("known checksum", () => {
    expect(id18("001Dn00000AbCdE")).toBe("001Dn00000AbCdEIAV");
    expect(id15("001Dn00000AbCdEIAV")).toBe("001Dn00000AbCdE");
  });
  test("property: round trip and case repair for 2,000 random ids", () => {
    for (let i = 1; i <= 2000; i++) {
      const s = randomId15(i);
      const full = id18(s) as string;
      expect(full.length).toBe(18);
      expect(isValidId(full)).toBe(true);
      expect(id15(full)).toBe(s);
      expect(id18(full.toLowerCase())).toBe(full);
      expect(id18(full.toUpperCase())).toBe(full);
    }
  });
  test("invalid inputs", () => {
    expect(id18(null)).toBeNull();
    expect(id18("abc")).toBeNull();
    expect(id18("001Dn00000AbCd!")).toBeNull();
    expect(isValidId("001Dn00000AbCdEAAA")).toBe(false);
    expect(isValidId("n/a")).toBe(false);
    expect(isValidId(null)).toBeNull();
    expect(checksum("000000000000000")).toBe("AAA");
  });
  test("key prefix and object", () => {
    expect(keyPrefix("006Dn000001aBcD")).toBe("006");
    expect(objectOf("00QDn000001aBcD")).toBe("Lead");
    expect(objectOf("a0XDn000001aBcD")).toBeNull();
    expect(objectOf("a0XDn000001aBcD", new Map([["a0X", "Invoice__c"]]))).toBe("Invoice__c");
  });
  test("soql_literal escapes and is injection-safe", () => {
    expect(soqlLiteral("O'Brien")).toBe("'O\\'Brien'");
    expect(soqlLiteral("a\\b\n")).toBe("'a\\\\b\\n'");
    expect(soqlLiteral(null)).toBeNull();
    // property: the literal never contains an unescaped quote
    for (const v of ["' OR Name != '", "\\' OR 1=1", "''", "\\\\'", "x' AND Id != null AND Name = 'y"]) {
      const lit = soqlLiteral(v) as string;
      const inner = lit.slice(1, -1);
      expect(/(^|[^\\])(\\\\)*'/.test(inner)).toBe(false);
    }
    expect(soqlLikeEscape("50%_off")).toBe("50\\%\\_off");
  });
});

describe("column mangling", () => {
  test("rules", () => {
    expect(mangle("StageName")).toBe("stage_name");
    expect(mangle("SystemModstamp")).toBe("system_modstamp");
    expect(mangle("AccountId")).toBe("account_id");
    expect(mangle("Deal_Stage_History__c")).toBe("deal_stage_history");
    expect(mangle("Acme__Score__c")).toBe("acme_score");
    expect(mangle("Account.Owner.Name")).toBe("account_owner_name");
    expect(mangle("Acme__Deal__r.Name")).toBe("acme_deal_name");
    expect(mangle("HQ_Location__Latitude__s")).toBe("hq_location_latitude_s");
  });
  test("collisions are suffixed with a warning", () => {
    const { columns, warnings } = assignColumns(["OwnerId", "Owner_Id__c", "Owner.Id"]);
    expect(columns.map((c) => c.column)).toEqual(["owner_id", "owner_id_2", "owner_id_3"]);
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toContain("Owner_Id__c");
  });
});

describe("types", () => {
  test("kinds", () => {
    expect(kindOf({ type: "currency", precision: 18 })).toBe("decimal");
    expect(kindOf({ type: "double", precision: 0 })).toBe("double");
    expect(kindOf({ type: "base64", precision: 0 })).toBeNull();
    expect(kindOf({ type: "multipicklist", precision: 0 })).toBe("multipicklist");
  });
  test("decimal strings to unscaled", () => {
    expect(toUnscaled("1234.5", 2)).toBe(123450n);
    expect(toUnscaled(-0.005, 2)).toBe(-1n);
    expect(toUnscaled("1.2E3", 1)).toBe(12000n);
    expect(toUnscaled("", 2)).toBeNull();
    expect(toUnscaled(99000.99, 2)).toBe(9900099n);
  });
  test("datetimes in REST and CSV forms", () => {
    expect(toMicros("2026-01-05T09:00:00.000+0000")).toBe(toMicros("2026-01-05T09:00:00.000Z"));
    expect(toMicros("2026-01-05T10:00:00.000+01:00")).toBe(toMicros("2026-01-05T09:00:00Z"));
    expect(convert("multipicklist", "AMER;EMEA")).toEqual(["AMER", "EMEA"]);
    expect(convert("bool", "false")).toBe(false);
    expect(convert("long", "9007199254740993")).toBe(9007199254740993n);
  });
  test("SOQL datetime literals are whole seconds", () => {
    expect(soqlDateTime(toMicros("2026-01-05T09:00:00.750Z") as bigint)).toBe("2026-01-05T09:00:00Z");
    expect(soqlDt(toMicros("2026-01-05T09:00:00.750Z") as bigint)).toBe("2026-01-05T09:00:00Z");
  });
});

describe("closed SOQL grammar", () => {
  test("accepts fields, paths, aggregates, date functions", () => {
    const p = parseSoql(
      "SELECT StageName, Account.Owner.Name, COUNT(Id) deals, SUM(Amount), CALENDAR_YEAR(CloseDate) yr FROM Opportunity WHERE Name LIKE 'a, b%' GROUP BY StageName, Account.Owner.Name, CALENDAR_YEAR(CloseDate)",
    );
    expect(p.object).toBe("Opportunity");
    expect(p.items.map((i) => i.kind)).toEqual(["field", "field", "agg", "agg", "datefn"]);
    expect(p.aggregate).toBe(true);
  });
  test("rejects constructs outside the grammar, naming the item", () => {
    for (const [q, item] of [
      ["SELECT Id, (SELECT Id FROM Contacts) FROM Account", "(SELECT Id FROM Contacts)"],
      ["SELECT toLabel(StageName) FROM Opportunity", "toLabel(StageName)"],
      ["SELECT FIELDS(ALL) FROM Account", "FIELDS(ALL)"],
      ["SELECT convertCurrency(Amount) FROM Opportunity", "convertCurrency(Amount)"],
      ["SELECT TYPEOF What WHEN Account THEN Name END FROM Task", "TYPEOF"],
    ]) {
      expect(() => parseSoql(q as string)).toThrow(SoqlGrammarError);
      try {
        parseSoql(q as string);
      } catch (e) {
        expect((e as Error).message).toContain(item as string);
      }
    }
    expect(() => parseSoql("SELECT Id FROM Account a")).toThrow(/alias/);
    expect(() => parseSoql("SELECT COUNT(), Id FROM Account")).toThrow(/only/);
  });
  test("fuzz: malformed SOQL never throws anything but a grammar error", () => {
    const parts = ["SELECT", "FROM", "Id", ",", "(", ")", "'", "WHERE", "Account", "COUNT", "x.y", " ", "ORDER BY", "\\"];
    let x = 7;
    for (let n = 0; n < 3000; n++) {
      let q = "";
      const len = 1 + (n % 12);
      for (let i = 0; i < len; i++) {
        x = (x * 1103515245 + 12345) % 2147483648;
        q += `${parts[x % parts.length]} `;
      }
      try {
        parseSoql(q);
      } catch (e) {
        expect(e).toBeInstanceOf(SoqlGrammarError);
      }
    }
  });
  test("clause finder skips strings and parentheses", () => {
    const c = findClauses("WHERE Name = 'ORDER BY x' AND Id IN (SELECT Id FROM y LIMIT 1) ORDER BY Name LIMIT 5");
    expect(c.map((x) => x.keyword)).toEqual(["WHERE", "ORDER BY", "LIMIT"]);
  });
  test("resume condition is injected into the WHERE clause", () => {
    const soql = "SELECT Id, SystemModstamp FROM Account WHERE Name = 'x' ORDER BY SystemModstamp";
    const rest = "WHERE Name = 'x' ORDER BY SystemModstamp";
    const bind = { object: "Account", columns: [], soql, clauses: findClauses(rest), restStart: soql.length - rest.length };
    expect(withCondition(bind, "SystemModstamp >= 2026-01-01T00:00:00Z")).toBe(
      "SELECT Id, SystemModstamp FROM Account WHERE (SystemModstamp >= 2026-01-01T00:00:00Z) AND (Name = 'x') ORDER BY SystemModstamp",
    );
  });
  test("object soql builder", () => {
    expect(buildObjectSoql({ object: "Account", select: ["Id", "Name"], conditions: ["A = 1"], orderBy: "Name", limit: 5 })).toBe(
      "SELECT Id, Name FROM Account WHERE A = 1 ORDER BY Name LIMIT 5",
    );
  });
});

describe("config, csv, limits", () => {
  test("secret flows", () => {
    const base = { type: "salesforce", instance_url: "https://acme.my.salesforce.com" };
    expect(configFromSecrets({ s: { ...base, access_token: "t" } }).flow).toBe("access_token");
    expect(configFromSecrets({ s: { ...base, client_id: "c", client_secret: "s" } }).flow).toBe("client_credentials");
    expect(configFromSecrets({ s: { ...base, client_id: "c", refresh_token: "r" } }).flow).toBe("refresh_token");
    expect(() => configFromSecrets({ s: { ...base } })).toThrow(/not supported/);
    expect(() => configFromSecrets({ s: { ...base, instance_url: "http://acme.example", access_token: "t" } })).toThrow(
      /https/,
    );
    expect(() => configFromSecrets({})).toThrow(/no salesforce secret/);
  });
  test("JWT assertion claims", async () => {
    const pem = await Bun.file(`${import.meta.dir}/../test/fixtures/connected-app.key`).text();
    const cfg = configFromSecrets({
      s: { type: "salesforce", instance_url: "https://x.my.salesforce.com", client_id: "cid", username: "u@x", private_key: pem },
    });
    const [h, c] = jwtAssertion(cfg, 1000).split(".");
    expect(JSON.parse(Buffer.from(h as string, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c as string, "base64url").toString())).toEqual({
      iss: "cid",
      sub: "u@x",
      aud: "https://login.salesforce.com",
      exp: 1180,
    });
  });
  test("Sforce-Limit-Info", () => {
    expect(parseLimitInfo("api-usage=18/15000")).toEqual({ used: 18, max: 15000 });
    expect(parseLimitInfo(null)).toBeNull();
  });
  test("CSV with quotes, commas and newlines", () => {
    expect(parseCsv('"Id","Notes"\na,"x, ""y""\nz"\nb,\n')).toEqual([["Id", "Notes"], ["a", 'x, "y"\nz'], ["b", ""]]);
  });
  test("OBJECTS list", () => {
    expect(parseObjectList(" Account, Invoice__c ,account")).toEqual(["Account", "Invoice__c"]);
    expect(() => parseObjectList("Acme_*__c")).toThrow(/wildcards/);
    expect(() => parseObjectList("a b")).toThrow(/not an object/);
  });
});
