/** RFC 4180 CSV parsing for Bulk API 2.0 results (comma delimiter, LF or CRLF line endings). */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"' && cur === "") {
      quoted = true;
      i++;
    } else if (ch === ",") {
      row.push(cur);
      cur = "";
      i++;
    } else if (ch === "\n" || ch === "\r") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      cur += ch;
      i++;
    }
  }
  if (cur !== "" || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}
