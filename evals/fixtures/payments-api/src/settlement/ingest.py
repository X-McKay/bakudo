"""Settlement file ingest. PLANTED: a hand-rolled CSV parser with manual
quote handling; the csv module does this correctly in three lines. The
accepted grammar (quoted fields, embedded commas) must not shrink."""


def parse_settlement_line(line):
    """Split one CSV line into fields, honouring double-quoted fields."""
    fields = []
    current = ""
    in_quotes = False
    i = 0
    while i < len(line):
        ch = line[i]
        if in_quotes:
            if ch == '"':
                if i + 1 < len(line) and line[i + 1] == '"':
                    current += '"'
                    i += 1
                else:
                    in_quotes = False
            else:
                current += ch
        else:
            if ch == '"':
                in_quotes = True
            elif ch == ",":
                fields.append(current)
                current = ""
            else:
                current += ch
        i += 1
    fields.append(current)
    return fields


def parse_settlement_file(text):
    rows = []
    for line in text.splitlines():
        if not line.strip():
            continue
        rows.append(parse_settlement_line(line))
    return rows
