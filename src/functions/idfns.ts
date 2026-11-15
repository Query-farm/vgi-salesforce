/** Tier 0 scalars: the Salesforce ID toolkit. No secret, no network. */

import { bool, defineScalarFunction, utf8, type VgiBatch, type VgiFunction } from "@query-farm/vgi";
import { id15, id18, isValidId, keyPrefix, objectOf, soqlLiteral } from "../sf/ids.ts";
import { docTags, Q } from "./common.ts";

const ID_DOC =
  "A Salesforce record id as text, in its short case-sensitive form or its long case-safe form; NULL in, NULL out.";
const col = (b: VgiBatch) => (b.getChildAt(0) ?? []) as Iterable<string | null>;

interface Exec {
  description: string;
  sql: string;
  expected_result: unknown[][];
}

function scalar(opts: {
  name: string;
  description: string;
  returns: "VARCHAR" | "BOOLEAN";
  fn: (v: string | null) => unknown;
  argName?: string;
  argDoc?: string;
  title: string;
  keywords: string;
  docLlm: string;
  docMd: string;
  examples: { sql: string; description: string }[];
  exec: Exec[];
}): VgiFunction {
  const fn = defineScalarFunction({
    name: opts.name,
    description: opts.description,
    params: { [opts.argName ?? "sf_id"]: utf8() },
    argDocs: { [opts.argName ?? "sf_id"]: opts.argDoc ?? ID_DOC },
    returns: opts.returns === "BOOLEAN" ? (bool as never) : utf8(),
    compute: (batch: VgiBatch) => Array.from(col(batch), (v) => opts.fn(v)),
    tags: {
      ...docTags({
        title: opts.title,
        category: "ids",
        keywords: opts.keywords,
        docLlm: opts.docLlm,
        docMd: opts.docMd,
      }),
      "vgi.executable_examples": JSON.stringify(opts.exec),
    },
    examples: opts.examples,
  } as never);
  return fn as VgiFunction;
}

const ACC15 = "001Dn00000AbCdE";
const ACC18 = "001Dn00000AbCdEIAV";

export const ID_FUNCTIONS: VgiFunction[] = [
  scalar({
    name: "id18",
    description: "Convert a 15-character case-sensitive Salesforce id to the 18-character case-safe form",
    returns: "VARCHAR",
    fn: id18,
    title: "15 → 18 Character ID",
    keywords: "salesforce id, id18, 18 character, case safe, case insensitive, join key, export, casesafeid",
    docLlm:
      "id18(sf_id) returns the 18-character case-safe id for a 15- or 18-character Salesforce id. DuckDB joins are " +
      "case-sensitive and Salesforce emits both forms (reports export 15, the API returns 18), so join on id18(x) = id18(y). " +
      "An 18-character id whose letters were up- or lower-cased (by Excel, say) is repaired from its checksum. " +
      "Returns NULL for anything that is not an id. Needs no secret.",
    docMd:
      "## id18(sf_id)\n\nThe 18-character case-safe form of a Salesforce id — the join key that survives case-insensitive tools. " +
      "Also restores the letter case of a mangled 18-character id. NULL for non-ids.",
    examples: [
      {
        sql: `SELECT ${Q}.id18(opportunity_id) AS join_key, count(*) AS rows FROM (VALUES ('${ACC15}'), ('${ACC18}')) t(opportunity_id) GROUP BY join_key`,
        description: "15- and 18-character forms of the same id collapse to one join key",
      },
    ],
    exec: [
      {
        description: "Both forms map to the same 18-character id",
        sql: `SELECT ${Q}.id18('${ACC15}') AS a, ${Q}.id18('${ACC18}') AS b, ${Q}.id18(lower('${ACC18}')) AS repaired`,
        expected_result: [[ACC18, ACC18, ACC18]],
      },
    ],
  }),
  scalar({
    name: "id15",
    description:
      "Convert an 18-character Salesforce id to the 15-character case-sensitive form (validating its checksum)",
    returns: "VARCHAR",
    fn: id15,
    title: "18 → 15 Character ID",
    keywords: "salesforce id, id15, 15 character, case sensitive, report export",
    docLlm:
      "id15(sf_id) returns the 15-character case-sensitive id (what Salesforce reports export) for a 15- or 18-character " +
      "id, restoring letter case from the checksum. NULL for non-ids. Needs no secret.",
    docMd: "## id15(sf_id)\n\nThe 15-character form of a Salesforce id. NULL for non-ids.",
    examples: [
      { sql: `SELECT ${Q}.id15('${ACC18}') AS short_id`, description: "Shorten an API id to its report form" },
    ],
    exec: [
      {
        description: "Shorten an 18-character id",
        sql: `SELECT ${Q}.id15('${ACC18}') AS id`,
        expected_result: [[ACC15]],
      },
    ],
  }),
  scalar({
    name: "key_prefix",
    description: "The 3-character key prefix of a Salesforce id (the object type code, e.g. '006' for Opportunity)",
    returns: "VARCHAR",
    fn: keyPrefix,
    title: "ID Key Prefix",
    keywords: "salesforce id, key prefix, object type, 001, 003, 006",
    docLlm:
      "key_prefix(sf_id) returns the first three characters of a 15/18-character id, which identify its object type " +
      "('001' Account, '003' Contact, '006' Opportunity). Join with meta.objects.key_prefix to name custom objects. NULL for non-ids.",
    docMd: "## key_prefix(sf_id)\n\nThe object-type prefix of an id. NULL for non-ids.",
    examples: [
      {
        sql: `SELECT ${Q}.key_prefix(what_id) AS prefix, count(*) AS tasks FROM (VALUES ('006Dn000001aBcD'), ('001Dn00000AbCdE')) t(what_id) GROUP BY prefix ORDER BY prefix`,
        description: "Count ids by object-type prefix",
      },
    ],
    exec: [
      {
        description: "Prefix of an opportunity id",
        sql: `SELECT ${Q}.key_prefix('006Dn000001aBcD') AS p`,
        expected_result: [["006"]],
      },
    ],
  }),
  scalar({
    name: "object_of",
    description: "The standard object an id belongs to, from its key prefix (NULL for custom objects)",
    returns: "VARCHAR",
    fn: (v) => objectOf(v),
    title: "Object of an ID",
    keywords: "salesforce id, object type, polymorphic, whatid, whoid, key prefix, standard objects",
    docLlm:
      "object_of(sf_id) names the standard object an id belongs to from its key prefix ('006…' → 'Opportunity', " +
      "'00Q…' → 'Lead'), using a bundled table of standard prefixes that are the same in every org. Essential for " +
      "polymorphic lookups such as Task.WhatId / WhoId. Custom objects have org-specific prefixes and return NULL here: " +
      "for those join key_prefix(id) to meta.objects.key_prefix. Needs no secret.",
    docMd:
      "## object_of(sf_id)\n\nStandard object name from an id's key prefix (bundled table). Custom objects → NULL; " +
      "join `key_prefix(id)` to `meta.objects` for them.",
    examples: [
      {
        sql: `SELECT ${Q}.object_of(what_id) AS target, count(*) AS tasks FROM (VALUES ('006Dn000001aBcD'), ('500Dn000002XyZq'), ('006Dn000003aBcE')) t(what_id) GROUP BY target ORDER BY target`,
        description: "Resolve polymorphic WhatIds to object names",
      },
    ],
    exec: [
      {
        description: "Opportunity, Lead and a custom object",
        sql: `SELECT ${Q}.object_of('006Dn000001aBcD') AS a, ${Q}.object_of('00QDn000001aBcD') AS b, ${Q}.object_of('a0XDn000001aBcD') AS c`,
        expected_result: [["Opportunity", "Lead", null]],
      },
    ],
  }),
  scalar({
    name: "is_valid_id",
    description: "True when a value is a well-formed Salesforce id (an 18-character id must carry a matching checksum)",
    returns: "BOOLEAN",
    fn: isValidId,
    title: "Validate an ID",
    keywords: "salesforce id, validate, checksum, data quality, export",
    docLlm:
      "is_valid_id(sf_id) is true for 15 base-62 characters, or 18 characters whose last three match the checksum of " +
      "the first fifteen; false otherwise; NULL for NULL. Use it to filter junk out of exported id columns. Needs no secret.",
    docMd: "## is_valid_id(sf_id)\n\nChecksum validation of a Salesforce id.",
    examples: [
      {
        sql: `SELECT count(*) FILTER (WHERE ${Q}.is_valid_id(id)) AS valid, count(*) FILTER (WHERE NOT ${Q}.is_valid_id(id)) AS invalid FROM (VALUES ('${ACC18}'), ('001Dn00000AbCdEAAA'), ('n/a')) t(id)`,
        description: "Count valid and invalid ids in an export",
      },
    ],
    exec: [
      {
        description: "A good id, a bad checksum and junk",
        sql: `SELECT ${Q}.is_valid_id('${ACC18}') AS good, ${Q}.is_valid_id('001Dn00000AbCdEAAA') AS bad, ${Q}.is_valid_id('n/a') AS junk`,
        expected_result: [[true, false, false]],
      },
    ],
  }),
  scalar({
    name: "soql_literal",
    description: "Quote and escape a value as a SOQL string literal, for building WHERE clauses safely",
    returns: "VARCHAR",
    fn: soqlLiteral,
    argName: "v",
    argDoc: "Value to quote; NULL in, NULL out.",
    title: "SOQL String Literal",
    keywords: "soql, escape, quote, injection, literal, where clause",
    docLlm:
      "soql_literal(v) returns v as a SOQL string literal: wrapped in single quotes with backslash escapes for \\ ' \" " +
      "and control characters. Use it when composing where_clause strings for query_object() from data, so a value " +
      "such as O'Brien cannot break or inject into the query. Needs no secret.",
    docMd: "## soql_literal(v)\n\nInjection-safe SOQL string quoting.",
    examples: [
      {
        sql: `SELECT 'LastName = ' || ${Q}.soql_literal(last_name) AS where_clause FROM (VALUES ('O''Brien')) t(last_name)`,
        description: "Build a WHERE clause from a value with a quote in it",
      },
    ],
    exec: [
      {
        description: "Escape a quote",
        sql: `SELECT ${Q}.soql_literal('O''Brien') AS lit`,
        expected_result: [["'O\\'Brien'"]],
      },
    ],
  }),
];
