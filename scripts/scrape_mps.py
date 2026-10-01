#!/usr/bin/env python3
"""Scrape current Singapore MPs from parliament.gov.sg + sgdi.gov.sg into data/mps.json.

Sources:
  - https://www.parliament.gov.sg/mps/list-of-current-mps  (names, photos, constituency)
  - .../mp/details/<slug>                                   (designation, party, appointments, socials)
  - https://www.sgdi.gov.sg/organs-of-state/parl            (official email + contact number)
"""
import html
import json
import os
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

PARL = "https://www.parliament.gov.sg"
LIST_URL = f"{PARL}/mps/list-of-current-mps"
SGDI_URL = "https://www.sgdi.gov.sg/organs-of-state/parl"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "mps.json")


def get(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:
            if attempt == retries - 1:
                raise
            print(f"  retry {attempt + 1} {url}: {e}", file=sys.stderr)
    return ""


def clean(s):
    """Strip tags/comments/entities from an HTML fragment, keeping <br> as newline."""
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t\xa0]+", " ", s)
    return "\n".join(l.strip() for l in s.split("\n") if l.strip()).strip()


def english_only(text):
    """Parliament renders each field in EN / MS / ZH / TA. Keep the first (English) line."""
    for line in text.split("\n"):
        if line.strip():
            return line.strip()
    return ""


# ---------------------------------------------------------------- list page

def parse_list(doc):
    mps = []
    for li in re.findall(r"<li>(.*?)</li>", doc, re.S):
        if "list-of-mps-wrap" not in li:
            continue
        img = re.search(r'<img src="([^"]+)"', li)
        link = re.search(r'href="(/mps/list-of-current-mps/mp/details/[^"]+)">(.*?)</a>', li, re.S)
        name = re.search(r'class="name mp-last-name">(.*?)</div>', li, re.S)
        cons = re.search(r'class="col-md-6 col-xs-11 mp-sort constituency">(.*?)</div>', li, re.S)
        if not (link and name):
            continue
        titled = clean(link.group(2))
        plain = clean(name.group(1))
        mps.append({
            "name": plain,
            "salutation": titled[: len(titled) - len(plain)].strip(),
            "slug": link.group(1).rsplit("/", 1)[-1],
            "detailUrl": PARL + link.group(1),
            "photo": PARL + img.group(1) if img else None,
            "constituency": clean(cons.group(1)) if cons else "",
        })
    return mps


# -------------------------------------------------------------- detail page

FIELD_RE = r"<b>%s</b>\s*</div>\s*<div[^>]*>(.*?)</div>"


def field(doc, label):
    m = re.search(FIELD_RE % re.escape(label), doc, re.S)
    return english_only(clean(m.group(1))) if m else ""


def sections(doc):
    """Split the detail body into {subheader: html} keyed by <h2 class="indv-mp-subheader">."""
    parts = re.split(r'<h2 class="indv-mp-subheader">(.*?)</h2>', doc, flags=re.S)
    return {clean(parts[i]): parts[i + 1] for i in range(1, len(parts) - 1, 2)}


def info_rows(frag):
    """Each `<div class="row mp-info">` holds 2-3 column cells; return them as tuples."""
    rows = []
    for row in re.findall(r'<div class="row mp-info[^"]*">(.*?)</div>\s*</div>', frag, re.S):
        cells = [clean(c) for c in re.findall(r"<div[^>]*col-md-[^>]*>(.*?)</div>", row + "</div>", re.S)]
        cells = [c for c in cells if c]
        if cells:
            rows.append(cells)
    return rows


def parse_detail(doc):
    out = {
        "designation": field(doc, "Designation:"),
        "party": field(doc, "Party:"),
        "yearOfBirth": field(doc, "Year of Birth:"),
        "links": {},
        "officeHolding": [],
        "elected": [],
        "mps": [],
    }

    # CONNECT block: social / directory links keyed by aria-label
    con = re.search(r'class="connect-info">(.*?)</div>', doc, re.S)
    if con:
        for href, label in re.findall(r'<a href="([^"]+)"[^>]*aria-label="([^"]+)"', con.group(1)):
            out["links"][label.lower()] = html.unescape(href)

    cv = re.search(r'<a title="[^"]*CV"[^>]*href="([^"]+)"', doc)
    if cv:
        out["links"]["cv"] = PARL + html.unescape(cv.group(1))

    sec = sections(doc)

    # "<date> to <date|Current>" + role title
    for cells in info_rows(sec.get("Office-Holding Appointments", "")):
        if len(cells) >= 2 and re.match(r"^\d{1,2} \w+ \d{4} to ", cells[0]):
            out["officeHolding"].append({
                "period": cells[0],
                "title": english_only(cells[1]),
                "current": cells[0].lower().endswith("current"),
            })

    # "<date> to <date|Current>" + constituency served
    for cells in info_rows(sec.get("Member of Parliament", "")):
        if len(cells) >= 2 and re.match(r"^\d{1,2} \w+ \d{4} to ", cells[0]):
            out["elected"].append({"period": cells[0], "constituency": english_only(cells[1])})

    # Meet-the-People Session: place / time / constituency email
    for cells in info_rows(sec.get("Meet the People Session", "")):
        rec = {}
        for c in cells:
            m = re.match(r"(Place|Time|Email Address):\s*(.*)", c, re.S)
            if m:
                rec[m.group(1).split()[0].lower()] = m.group(2).replace("\n", " ").strip()
        if rec:
            out["mps"].append(rec)

    return out


# ------------------------------------------------------------------- sgdi

def norm_name(n):
    n = html.unescape(n).lower()
    n = re.sub(r"\b(mr|mrs|ms|miss|dr|prof|assoc|associate|professor|mdm|encik|er|ar)\b\.?", " ", n)
    n = re.sub(r"\b(bbm|pbm|bbs|pjg|jp)\b", " ", n)
    n = re.sub(r"\b(bin|binte|binti|bte|s/o|d/o|a/l|a/p)\b", " ", n)
    n = re.sub(r"[^a-z]+", " ", n)
    # Drop initials ("MASAGOS Zulkifli B M M") so they don't block subset matching.
    return " ".join(sorted(t for t in n.split() if len(t) > 1))


def parse_sgdi(doc):
    """Return {normalised-name: {email, phone, address, rank}}."""
    out = {}
    for li in re.findall(r"<li id=\"[^\"]*\">(.*?)</li>", doc, re.S):
        name = re.search(r'class="name"[^>]*>(.*?)</div>', li, re.S)
        if not name:
            continue
        nm = clean(name.group(1))
        rank = re.search(r'class="rank">(.*?)</div>', li, re.S)
        addr = re.search(r'class="detail">(.*?)</div>', li, re.S)
        tel = re.search(r'class="tel info-contact">(.*?)</div></div>', li, re.S)
        mail = re.search(r'class="email info-contact">(.*?)</div></div>', li, re.S)
        phone = re.sub(r"\D", "", clean(tel.group(1))) if tel else ""
        email = clean(mail.group(1)) if mail else ""
        rec = {
            "rank": clean(rank.group(1)) if rank else "",
            "address": clean(addr.group(1)).replace("\n", ", ") if addr else "",
            "phone": phone,
            "email": email if "@" in email else "",
        }
        key = norm_name(nm)
        # Prefer the entry that carries the most contact info for a given person.
        prev = out.get(key)
        score = bool(rec["email"]) + bool(rec["phone"])
        if not prev or score > (bool(prev["email"]) + bool(prev["phone"])):
            out[key] = rec
    return out


# ------------------------------------------------------------------- main

def main():
    print("Fetching MP list…")
    mps = parse_list(get(LIST_URL))
    print(f"  {len(mps)} MPs")

    print("Fetching SGDI directory…")
    sgdi = parse_sgdi(get(SGDI_URL))
    print(f"  {len(sgdi)} directory entries")

    print("Fetching detail pages…")

    def enrich(mp):
        try:
            mp.update(parse_detail(get(mp["detailUrl"])))
        except Exception as e:
            print(f"  FAILED {mp['slug']}: {e}", file=sys.stderr)
            mp.update({"links": {}, "officeHolding": [], "elected": [], "mps": []})
        return mp

    with ThreadPoolExecutor(max_workers=8) as pool:
        mps = list(pool.map(enrich, mps))

    matched = 0
    for mp in mps:
        rec = sgdi.get(norm_name(mp["name"]))
        if not rec:
            # Fall back to a surname+given-name subset match.
            want = set(norm_name(mp["name"]).split())
            best = None
            for k, v in sgdi.items():
                have = set(k.split())
                common = want & have
                if len(common) >= 2 and (common == want or common == have):
                    if best is None or len(common) > best[0]:
                        best = (len(common), v)
            rec = best[1] if best else None
        matched += bool(rec)

        mps_email = next((s["email"] for s in mp["mps"] if s.get("email")), "")
        mp["officialEmail"] = rec["email"] if rec else ""
        # Constituency (Meet-the-People) address is what residents should write to.
        mp["email"] = mps_email or mp["officialEmail"]
        mp["phone"] = rec["phone"] if rec else ""
        mp["officeAddress"] = rec["address"] if rec else ""
        mp["directoryRank"] = rec["rank"] if rec else ""

        # Current roles: office-holding appointments still running, plus the
        # headline designation when it isn't just a restatement of those.
        current = [a["title"] for a in mp["officeHolding"] if a["current"]]
        desig = mp["designation"]
        if desig and not any(desig in c or c in desig for c in current):
            current.insert(0, desig)
        elif desig and len(current) > 1 and all(c in desig for c in current):
            current = [desig]  # e.g. "PM & Minister for Finance" subsumes both rows
        mp["currentRoles"] = current
        mp["pastRoles"] = [a for a in mp["officeHolding"] if not a["current"]]
        mp["mpSince"] = mp["elected"][-1]["period"].split(" to ")[0] if mp["elected"] else ""
        mp["termsServed"] = len(mp["elected"])
        mp.pop("officeHolding", None)

    print(f"  matched {matched}/{len(mps)} to the government directory")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"mps": sorted(mps, key=lambda m: m["name"])}, f, ensure_ascii=False, indent=1)
    print(f"Wrote {OUT}")

    missing = [m["name"] for m in mps if not m["email"]]
    if missing:
        print(f"No email for {len(missing)}: {', '.join(missing)}")


if __name__ == "__main__":
    main()
