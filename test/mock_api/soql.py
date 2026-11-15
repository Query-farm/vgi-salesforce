"""A strict SOQL evaluator for the fixture org.

It parses incoming SOQL and filters the fixture records with it, so a wrong pushdown
returns wrong rows. It is strict where Salesforce is: unknown fields fail with
INVALID_FIELD, a quoted date/datetime or an unquoted string is MALFORMED_QUERY, booleans
take TRUE/FALSE only, range operators on booleans fail, and datetime literals must be
whole seconds with Z or +hh:mm. String comparisons and LIKE are case-insensitive as in
Salesforce. Supports SELECT fields / parent paths / COUNT() / aggregates / date functions,
WHERE (AND/OR/NOT, = != < <= > >=, IN, NOT IN, LIKE, INCLUDES, EXCLUDES, null), GROUP BY,
ORDER BY … ASC|DESC NULLS FIRST|LAST, LIMIT, OFFSET.
"""

import re
from datetime import date, datetime, timezone


class SoqlError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


TOKEN = re.compile(
    r"""\s*(?:
      (?P<datetime>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)
    | (?P<date>\d{4}-\d{2}-\d{2})
    | (?P<number>-?\d+(?:\.\d+)?)
    | (?P<string>'(?:[^'\\]|\\.)*')
    | (?P<op><=|>=|!=|<>|=|<|>|\(|\)|,)
    | (?P<word>[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)
    )""",
    re.X,
)

ESC = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "'": "'", '"': '"', "\\": "\\", "%": "\\%", "_": "\\_"}


def unquote(s):
    out, i = "", 1
    while i < len(s) - 1:
        c = s[i]
        if c == "\\":
            n = s[i + 1]
            if n not in ESC:
                raise SoqlError("MALFORMED_QUERY", f"Invalid string literal escape \\{n}")
            out += ESC[n]
            i += 2
        else:
            out += c
            i += 1
    return out


def tokenize(q):
    toks, pos = [], 0
    q = q.strip()
    while pos < len(q):
        m = TOKEN.match(q, pos)
        if not m or m.end() == pos:
            raise SoqlError("MALFORMED_QUERY", f"unexpected token at: {q[pos:pos + 20]}")
        kind = m.lastgroup
        toks.append((kind, m.group(kind)))
        pos = m.end()
        while pos < len(q) and q[pos].isspace():
            pos += 1
    return toks


KEYWORDS = {"SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "LIKE", "INCLUDES", "EXCLUDES", "GROUP", "BY",
            "ORDER", "ASC", "DESC", "NULLS", "FIRST", "LAST", "LIMIT", "OFFSET", "NULL", "TRUE", "FALSE", "AS"}
AGGS = {"COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX"}
DATE_FNS = {"CALENDAR_YEAR", "CALENDAR_MONTH", "CALENDAR_QUARTER", "FISCAL_YEAR", "FISCAL_QUARTER", "DAY_ONLY",
            "DAY_IN_MONTH", "DAY_IN_WEEK", "DAY_IN_YEAR", "HOUR_IN_DAY", "WEEK_IN_MONTH", "WEEK_IN_YEAR"}


def parse_dt(s):
    """Parse a stored or literal datetime to an aware datetime."""
    s = s.replace("+0000", "+00:00")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


class Org:
    """Describes + records, with relationship resolution."""

    def __init__(self, describes, records):
        self.describes = describes  # name -> list of field dicts
        self.records = records
        self.by_id = {}
        for obj, rows in records.items():
            for r in rows:
                self.by_id[r["Id"]] = (obj, r)

    def obj(self, name):
        for k in self.describes:
            if k.lower() == name.lower():
                return k
        raise SoqlError("INVALID_TYPE", f"sObject type '{name}' is not supported.")

    def field(self, obj, name):
        for f in self.describes[obj]:
            if f["name"].lower() == name.lower():
                return f
        raise SoqlError("INVALID_FIELD", f"No such column '{name}' on entity '{obj}'.")

    def resolve(self, obj, path):
        """Return (field, canonical path, getter(record))."""
        segs = path.split(".")
        canon, cur_obj = [], obj
        steps = []
        for seg in segs[:-1]:
            rel = next((f for f in self.describes[cur_obj] if f["type"] == "reference" and (f["relationshipName"] or "").lower() == seg.lower()), None)
            if rel is None:
                raise SoqlError("INVALID_FIELD", f"Didn't understand relationship '{seg}' in field path. ({path})")
            canon.append(rel["relationshipName"])
            steps.append((rel["name"], rel["referenceTo"]))
            cur_obj = rel["referenceTo"][0] if len(rel["referenceTo"]) == 1 else None
            if cur_obj is None:
                # polymorphic: Name pseudo-object
                last = segs[-1]
                if last.lower() not in ("id", "name", "type"):
                    raise SoqlError("INVALID_FIELD", f"No such column '{last}' on entity 'Name'.")
                fname = {"id": "Id", "name": "Name", "type": "Type"}[last.lower()]
                canon.append(fname)

                def poly(rec, steps=steps, fname=fname):
                    r = rec
                    for fk, _ in steps:
                        if r is None:
                            return None
                        hit = self.by_id.get(r.get(fk))
                        if hit is None:
                            return None
                        o, r = hit
                    if r is None:
                        return None
                    return o if fname == "Type" else r.get(fname)

                return {"name": fname, "type": "string"}, ".".join(canon), poly
        f = self.field(cur_obj, segs[-1])
        canon.append(f["name"])

        def get(rec, steps=steps, fname=f["name"]):
            r = rec
            for fk, _ in steps:
                if r is None:
                    return None
                hit = self.by_id.get(r.get(fk))
                r = hit[1] if hit else None
            return None if r is None else r.get(fname)

        return f, ".".join(canon), get


class Query:
    def __init__(self, org, text):
        self.org = org
        self.text = text
        self.toks = tokenize(text)
        self.i = 0
        self.parse()

    # -- token helpers
    def peek(self, k=0):
        return self.toks[self.i + k] if self.i + k < len(self.toks) else (None, None)

    def kw(self, *words):
        kind, v = self.peek()
        return kind == "word" and v.upper() in words

    def take(self):
        t = self.peek()
        self.i += 1
        return t

    def expect_kw(self, w):
        if not self.kw(w):
            raise SoqlError("MALFORMED_QUERY", f"expecting '{w}', found '{self.peek()[1]}'")
        self.take()

    def expect_op(self, op):
        if self.peek() != ("op", op):
            raise SoqlError("MALFORMED_QUERY", f"expecting '{op}', found '{self.peek()[1]}'")
        self.take()

    # -- grammar
    def parse(self):
        self.expect_kw("SELECT")
        raw_items = []
        while True:
            raw_items.append(self.parse_item())
            if self.peek() == ("op", ","):
                self.take()
                continue
            break
        self.expect_kw("FROM")
        _, name = self.take()
        self.obj = self.org.obj(name)
        self.where = None
        self.group = []
        self.order = []
        self.limit = None
        self.offset = 0
        if self.kw("WHERE"):
            self.take()
            self.where = self.parse_or()
        if self.kw("GROUP"):
            self.take()
            self.expect_kw("BY")
            while True:
                _, p = self.take()
                self.group.append(self.org.resolve(self.obj, p))
                if self.peek() == ("op", ","):
                    self.take()
                    continue
                break
        if self.kw("ORDER"):
            self.take()
            self.expect_kw("BY")
            while True:
                _, p = self.take()
                f, canon, get = self.org.resolve(self.obj, p)
                if not f.get("sortable", True):
                    raise SoqlError("INVALID_FIELD", f"field '{canon}' can not be sorted in a query call")
                desc = False
                if self.kw("ASC", "DESC"):
                    desc = self.take()[1].upper() == "DESC"
                nulls_last = desc
                if self.kw("NULLS"):
                    self.take()
                    nulls_last = self.take()[1].upper() == "LAST"
                self.order.append((get, desc, nulls_last))
                if self.peek() == ("op", ","):
                    self.take()
                    continue
                break
        if self.kw("LIMIT"):
            self.take()
            self.limit = int(self.take()[1])
        if self.kw("OFFSET"):
            self.take()
            self.offset = int(self.take()[1])
        if self.i != len(self.toks):
            raise SoqlError("MALFORMED_QUERY", f"unexpected token: '{self.peek()[1]}'")
        # resolve select items
        self.items = []
        expr = 0
        self.count_all = False
        for it in raw_items:
            kind = it[0]
            if kind == "count_all":
                self.count_all = True
                self.items.append(("count_all", None, None, None))
            elif kind == "field":
                f, canon, get = self.org.resolve(self.obj, it[1])
                self.items.append(("field", canon, f, get))
            else:
                _, fn, path, alias = it
                f, canon, get = self.org.resolve(self.obj, path)
                key = alias or f"expr{expr}"
                if not alias:
                    expr += 1
                self.items.append((kind, key, (fn, f), get))
        self.aggregate = bool(self.group) or any(k in ("agg",) for k, *_ in self.items)
        if self.count_all and len(self.items) > 1:
            raise SoqlError("MALFORMED_QUERY", "COUNT() must be the only element in the SELECT list")

    def parse_item(self):
        kind, v = self.take()
        if kind != "word":
            raise SoqlError("MALFORMED_QUERY", f"unexpected token in select list: '{v}'")
        if self.peek() == ("op", "("):
            fn = v.upper()
            self.take()
            if fn == "COUNT" and self.peek() == ("op", ")"):
                self.take()
                return ("count_all",)
            if fn not in AGGS and fn not in DATE_FNS:
                raise SoqlError("MALFORMED_QUERY", f"unsupported function {fn}")
            _, path = self.take()
            self.expect_op(")")
            alias = None
            k2, v2 = self.peek()
            if k2 == "word" and v2.upper() not in KEYWORDS:
                alias = self.take()[1]
            return ("agg" if fn in AGGS else "datefn", fn, path, alias)
        k2, v2 = self.peek()
        if k2 == "word" and v2.upper() not in KEYWORDS:
            raise SoqlError("MALFORMED_QUERY", f"unexpected token: '{v2}' (aliases are only allowed on aggregates)")
        return ("field", v)

    def parse_or(self):
        node = self.parse_and()
        while self.kw("OR"):
            self.take()
            node = ("or", node, self.parse_and())
        return node

    def parse_and(self):
        node = self.parse_not()
        while self.kw("AND"):
            self.take()
            node = ("and", node, self.parse_not())
        return node

    def parse_not(self):
        if self.kw("NOT"):
            self.take()
            return ("not", self.parse_not())
        if self.peek() == ("op", "("):
            self.take()
            n = self.parse_or()
            self.expect_op(")")
            return n
        return self.parse_pred()

    def parse_value(self, f):
        kind, v = self.take()
        t = f["type"]
        name = f["name"]
        if kind == "word" and v.upper() == "NULL":
            return None
        if t == "boolean":
            if kind == "word" and v.upper() in ("TRUE", "FALSE"):
                return v.upper() == "TRUE"
            raise SoqlError("INVALID_FIELD", f"value of filter criterion for field '{name}' must be of type boolean and should not be enclosed in quotes")
        if t == "date":
            if kind == "date":
                return date.fromisoformat(v)
            raise SoqlError("INVALID_FIELD", f"value of filter criterion for field '{name}' must be of type date and should not be enclosed in quotes")
        if t == "datetime":
            if kind == "datetime":
                if "." in v or not (v.endswith("Z") or re.search(r"[+-]\d{2}:\d{2}$", v)):
                    raise SoqlError("INVALID_FIELD", f"invalid datetime literal {v} for field '{name}' (use YYYY-MM-DDThh:mm:ssZ)")
                return parse_dt(v)
            raise SoqlError("INVALID_FIELD", f"value of filter criterion for field '{name}' must be of type dateTime and should not be enclosed in quotes")
        if t in ("int", "long", "double", "currency", "percent"):
            if kind == "number":
                return float(v)
            raise SoqlError("INVALID_FIELD", f"value of filter criterion for field '{name}' must be of type double and should not be enclosed in quotes")
        if kind == "string":
            return unquote(v)
        raise SoqlError("MALFORMED_QUERY", f"value of filter criterion for field '{name}' must be a quoted string, found {v}")

    def parse_pred(self):
        kind, path = self.take()
        if kind != "word":
            raise SoqlError("MALFORMED_QUERY", f"unexpected token: '{path}'")
        f, canon, get = self.org.resolve(self.obj, path)
        if not f.get("filterable", True):
            raise SoqlError("INVALID_FIELD", f"field '{canon}' can not be filtered in a query call")
        neg = False
        if self.kw("NOT"):
            self.take()
            neg = True
        if self.kw("IN", "INCLUDES", "EXCLUDES"):
            op = self.take()[1].upper()
            self.expect_op("(")
            vals = []
            while True:
                vals.append(self.parse_value(f))
                if self.peek() == ("op", ","):
                    self.take()
                    continue
                break
            self.expect_op(")")
            if op != "IN" and f["type"] != "multipicklist":
                raise SoqlError("INVALID_FIELD", f"{op} is only valid on multi-select picklists ({canon})")
            return ({"IN": "nin" if neg else "in"}.get(op, op.lower()), f, get, vals)
        if self.kw("LIKE"):
            self.take()
            k, v = self.take()
            if k != "string":
                raise SoqlError("MALFORMED_QUERY", "LIKE needs a quoted pattern")
            if f["type"] in ("id", "reference", "boolean", "date", "datetime", "double", "currency", "percent", "int"):
                raise SoqlError("INVALID_FIELD", f"invalid operator on {f['type']} field '{canon}': LIKE")
            return ("like", f, get, v[1:-1])
        if neg:
            raise SoqlError("MALFORMED_QUERY", "NOT must precede IN or a condition")
        k, op = self.take()
        if k != "op" or op not in ("=", "!=", "<>", "<", "<=", ">", ">="):
            raise SoqlError("MALFORMED_QUERY", f"unexpected operator '{op}'")
        if op in ("<", "<=", ">", ">=") and f["type"] in ("boolean", "multipicklist"):
            raise SoqlError("INVALID_FIELD", f"invalid operator on {f['type']} field '{canon}': {op}")
        return ("cmp", f, get, (op.replace("<>", "!="), self.parse_value(f)))

    # -- evaluation
    @staticmethod
    def norm(f, v):
        """Stored value → comparable value."""
        if v is None:
            return None
        t = f["type"]
        if t == "date":
            return date.fromisoformat(v)
        if t == "datetime":
            return parse_dt(v)
        if t in ("int", "long", "double", "currency", "percent"):
            return float(v)
        if t == "boolean":
            return bool(v)
        return str(v).lower()

    def eval(self, node, rec):
        tag = node[0]
        if tag == "and":
            return self.eval(node[1], rec) and self.eval(node[2], rec)
        if tag == "or":
            return self.eval(node[1], rec) or self.eval(node[2], rec)
        if tag == "not":
            return not self.eval(node[1], rec)
        _, f, get, arg = node
        raw = get(rec)
        v = self.norm(f, raw)
        lit = lambda x: x.lower() if isinstance(x, str) else x  # noqa: E731
        if tag == "cmp":
            op, want = arg
            want = lit(want)
            if want is None:
                return (v is None) if op == "=" else (v is not None)
            if op == "!=":
                return v is None or v != want  # Salesforce includes nulls in !=
            if v is None:
                return False
            return {"=": v == want, "<": v < want, "<=": v <= want, ">": v > want, ">=": v >= want}[op]
        if tag in ("in", "nin"):
            vals = [lit(x) for x in arg]
            return (v in vals) if tag == "in" else (v is None or v not in vals)
        if tag in ("includes", "excludes"):
            have = set((raw or "").lower().split(";")) - {""}
            hit = any(set(x.lower().split(";")) <= have for x in arg)
            return hit if tag == "includes" else not hit
        if tag == "like":
            if v is None:
                return False
            rx, i, pat = "", 0, arg
            while i < len(pat):
                c = pat[i]
                if c == "\\" and i + 1 < len(pat):
                    rx += re.escape(ESC.get(pat[i + 1], pat[i + 1]).lstrip("\\"))
                    i += 2
                    continue
                rx += ".*" if c == "%" else "." if c == "_" else re.escape(c)
                i += 1
            return re.fullmatch(rx, v, re.S | re.I) is not None
        raise AssertionError(tag)

    def run(self, include_deleted=False):
        rows = [r for r in self.org.records.get(self.obj, []) if include_deleted or not r.get("IsDeleted")]
        if self.where is not None:
            rows = [r for r in rows if self.eval(self.where, r)]
        total = len(rows)
        if self.count_all:
            return total, []
        if self.aggregate:
            return self.run_aggregate(rows)
        for get, desc, nulls_last in reversed(self.order):
            nn = [r for r in rows if get(r) is not None]
            nl = [r for r in rows if get(r) is None]
            nn.sort(key=lambda r, g=get: (str(g(r)).lower() if isinstance(g(r), str) else g(r)), reverse=desc)
            rows = nn + nl if nulls_last else nl + nn
        rows = rows[self.offset:]
        if self.limit is not None:
            rows = rows[: self.limit]
        return len(rows), rows

    def run_aggregate(self, rows):
        groups = {}
        for r in rows:
            k = tuple(g[2](r) for g in self.group)
            groups.setdefault(k, []).append(r)
        if not self.group:
            groups = {(): rows}
        out = []
        for k, rs in groups.items():
            rec = {}
            for (f, canon, get), v in zip(self.group, k):
                rec[canon.split(".")[-1]] = v
            for kind, key, info, get in self.items:
                if kind == "field":
                    continue
                fn, f = info
                vals = [get(r) for r in rs]
                nn = [x for x in vals if x is not None]
                if kind == "datefn":
                    v = vals[0]
                    if v is None:
                        rec[key] = None
                        continue
                    d = parse_dt(v) if "T" in v else datetime.fromisoformat(v)
                    rec[key] = {"CALENDAR_YEAR": d.year, "CALENDAR_MONTH": d.month, "CALENDAR_QUARTER": (d.month - 1) // 3 + 1,
                                "FISCAL_YEAR": d.year, "FISCAL_QUARTER": (d.month - 1) // 3 + 1, "DAY_ONLY": d.date().isoformat() if isinstance(d, datetime) else v,
                                "DAY_IN_MONTH": d.day, "DAY_IN_WEEK": (d.isoweekday() % 7) + 1, "DAY_IN_YEAR": d.timetuple().tm_yday,
                                "HOUR_IN_DAY": d.hour, "WEEK_IN_MONTH": (d.day - 1) // 7 + 1, "WEEK_IN_YEAR": d.isocalendar()[1]}[fn]
                    continue
                if fn == "COUNT":
                    rec[key] = len(nn)
                elif fn == "COUNT_DISTINCT":
                    rec[key] = len(set(nn))
                elif fn == "SUM":
                    rec[key] = sum(nn) if nn else None
                elif fn == "AVG":
                    rec[key] = sum(nn) / len(nn) if nn else None
                elif fn == "MIN":
                    rec[key] = min(nn) if nn else None
                elif fn == "MAX":
                    rec[key] = max(nn) if nn else None
            out.append(rec)
        if self.limit is not None:
            out = out[: self.limit]
        return len(out), out

    def compound_items(self):
        return [canon for kind, canon, f, _ in self.items if kind == "field" and f.get("type") in ("address", "location")]


def now_utc():
    return datetime.now(timezone.utc)
