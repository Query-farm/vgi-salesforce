/**
 * Tier 0: the Salesforce ID toolkit. Pure functions, no org, no network.
 *
 * A Salesforce record ID is 15 case-sensitive base-62 characters. The 18-character
 * "case-safe" form appends three checksum characters, each encoding which of five
 * characters in one block of the 15 is an upper-case letter. Because the suffix
 * records the case of every letter, an 18-character ID whose letters were
 * up- or down-cased by a spreadsheet can be restored exactly.
 */

const SUFFIX_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
const BASE62 = /^[0-9A-Za-z]+$/;

/** The 3-character case-safe suffix of a 15-character ID. */
export function checksum(id15: string): string {
  let out = "";
  for (let block = 0; block < 3; block++) {
    let bits = 0;
    for (let i = 0; i < 5; i++) {
      const c = id15.charCodeAt(block * 5 + i);
      if (c >= 65 && c <= 90) bits |= 1 << i;
    }
    out += SUFFIX_ALPHABET[bits];
  }
  return out;
}

/** Restore the letter case of the first 15 characters of an 18-character ID from its suffix. */
function restoreCase(id: string): string | null {
  const suffix = id.slice(15).toUpperCase();
  let out = "";
  for (let block = 0; block < 3; block++) {
    const bits = SUFFIX_ALPHABET.indexOf(suffix[block] ?? "");
    if (bits < 0) return null;
    for (let i = 0; i < 5; i++) {
      const ch = id[block * 5 + i] ?? "";
      const upper = (bits >> i) & 1;
      if (/[A-Za-z]/.test(ch)) out += upper ? ch.toUpperCase() : ch.toLowerCase();
      else if (upper)
        return null; // the suffix says "upper-case letter" but this is a digit
      else out += ch;
    }
  }
  return out;
}

/** 15 or 18 characters → 18-character case-safe ID; NULL when the input is not an ID. */
export function id18(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const id = raw.trim();
  if (!BASE62.test(id)) return null;
  if (id.length === 15) return id + checksum(id);
  if (id.length === 18) {
    const restored = restoreCase(id);
    return restored === null ? null : restored + checksum(restored);
  }
  return null;
}

/** 15 or 18 characters → 15-character case-sensitive ID; NULL when the input is not an ID. */
export function id15(raw: string | null | undefined): string | null {
  const full = id18(raw);
  return full === null ? null : full.slice(0, 15);
}

/** True for a 15-character base-62 ID, or an 18-character ID whose suffix matches its first 15 characters. */
export function isValidId(raw: string | null | undefined): boolean | null {
  if (raw == null) return null;
  const id = raw.trim();
  if (!BASE62.test(id)) return false;
  if (id.length === 15) return true;
  if (id.length === 18) return checksum(id.slice(0, 15)) === id.slice(15).toUpperCase();
  return false;
}

/** The 3-character key prefix that names the object type, e.g. '006' for Opportunity. */
export function keyPrefix(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const id = raw.trim();
  if ((id.length !== 15 && id.length !== 18) || !BASE62.test(id)) return null;
  return id.slice(0, 3);
}

/**
 * Key prefixes of standard objects that are the same in every org. Custom objects
 * (a0x…) get org-specific prefixes: look those up in `meta.objects.key_prefix`.
 */
export const STANDARD_PREFIXES: Readonly<Record<string, string>> = {
  "001": "Account",
  "002": "Note",
  "003": "Contact",
  "005": "User",
  "006": "Opportunity",
  "008": "OpportunityHistory",
  "00B": "ListView",
  "00D": "Organization",
  "00E": "UserRole",
  "00G": "Group",
  "00J": "OpportunityCompetitor",
  "00K": "OpportunityContactRole",
  "00O": "Report",
  "00P": "Attachment",
  "00Q": "Lead",
  "00T": "Task",
  "00U": "Event",
  "00X": "EmailTemplate",
  "00a": "CaseComment",
  "00e": "Profile",
  "00h": "Layout",
  "00k": "OpportunityLineItem",
  "00l": "Folder",
  "00v": "CampaignMember",
  "010": "CaseSolution",
  "011": "GroupMember",
  "012": "RecordType",
  "015": "Document",
  "01Z": "Dashboard",
  "01p": "ApexClass",
  "01q": "ApexTrigger",
  "01s": "Pricebook2",
  "01t": "Product2",
  "01u": "PricebookEntry",
  "02i": "Asset",
  "02s": "EmailMessage",
  "068": "ContentVersion",
  "069": "ContentDocument",
  "06A": "ContentDocumentLink",
  "07L": "ApexLog",
  "081": "StaticResource",
  "0D5": "FeedItem",
  "0PS": "PermissionSet",
  "0Pa": "PermissionSetAssignment",
  "0Q0": "Quote",
  "0QL": "QuoteLineItem",
  "500": "Case",
  "501": "Solution",
  "701": "Campaign",
  "707": "AsyncApexJob",
  "800": "Contract",
  "801": "Order",
  "802": "OrderItem",
};

/** Object name for an ID's key prefix: the org map (when given) first, then the standard table. */
export function objectOf(raw: string | null | undefined, orgPrefixes?: ReadonlyMap<string, string>): string | null {
  const p = keyPrefix(raw);
  if (p === null) return null;
  return orgPrefixes?.get(p) ?? STANDARD_PREFIXES[p] ?? null;
}

/**
 * Quote a value as a SOQL string literal: single quotes, with backslash escapes for
 * the characters SOQL treats specially inside a quoted string (\\ ' " \n \r \t \b \f).
 * The result is always safe to splice into a WHERE clause as one literal.
 */
export function soqlLiteral(v: string | null | undefined): string | null {
  if (v == null) return null;
  let out = "'";
  for (const ch of v) {
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case "'":
        out += "\\'";
        break;
      case '"':
        out += '\\"';
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      default:
        out += ch;
    }
  }
  return `${out}'`;
}

/** Escape a value for use inside a SOQL LIKE pattern (also escapes % and _). */
export function soqlLikeEscape(v: string): string {
  return (soqlLiteral(v) as string).slice(1, -1).replace(/%/g, "\\%").replace(/_/g, "\\_");
}
