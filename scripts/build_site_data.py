#!/usr/bin/env python3
"""Join data/mps.json + data/electoral_boundary_2025.geojson into the files the site loads.

Outputs:
  docs/data/divisions.geojson  – boundaries, trimmed coordinate precision
  docs/data/mps.json           – MPs keyed by division, with local photo paths
  docs/assets/mp/<slug>.<ext>  – mugshots mirrored locally
"""
import json
import os
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA = os.path.join(ROOT, "data")
DOCS = os.path.join(ROOT, "docs")
PHOTOS = os.path.join(DOCS, "assets", "mp")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"
PRECISION = 6  # ~0.1 m at the equator; plenty for constituency outlines
PHOTO_WIDTH = 360  # rendered at ~160 px, 2x for retina


def norm(name):
    return re.sub(r"\s+(GRC|SMC)$", "", name.strip().upper())


def round_coords(node):
    if isinstance(node, list):
        if node and isinstance(node[0], (int, float)):
            return [round(v, PRECISION) for v in node]
        return [round_coords(v) for v in node]
    return node


def download_photos(mps):
    """Mirror each mugshot locally, re-encoded as a small portrait JPEG.

    The source images run to several MB each; the site only ever shows them at
    ~160 px, so downscaling keeps the repo (and the Pages payload) tiny.
    """
    from io import BytesIO
    from PIL import Image

    os.makedirs(PHOTOS, exist_ok=True)

    def grab(mp):
        url = mp.get("photo")
        if not url:
            return None
        rel = f"assets/mp/{mp['slug']}.jpg"
        dest = os.path.join(DOCS, rel)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            return rel
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": UA, "Referer": "https://www.parliament.gov.sg/"})
            with urllib.request.urlopen(req, timeout=90) as r:
                raw = r.read()
            img = Image.open(BytesIO(raw))
            if img.mode in ("RGBA", "LA", "P"):
                bg = Image.new("RGB", img.size, (255, 255, 255))
                img = img.convert("RGBA")
                bg.paste(img, mask=img.split()[-1])
                img = bg
            else:
                img = img.convert("RGB")
            img.thumbnail((PHOTO_WIDTH, PHOTO_WIDTH * 2), Image.LANCZOS)
            img.save(dest, "JPEG", quality=82, optimize=True, progressive=True)
        except Exception as e:
            print(f"  photo failed {mp['slug']}: {e}", file=sys.stderr)
            return None
        return rel

    with ThreadPoolExecutor(max_workers=8) as pool:
        for mp, rel in zip(mps, pool.map(grab, mps)):
            mp["photoLocal"] = rel


def main():
    geo = json.load(open(os.path.join(DATA, "electoral_boundary_2025.geojson"), encoding="utf-8"))
    mps = json.load(open(os.path.join(DATA, "mps.json"), encoding="utf-8"))["mps"]

    print(f"Mirroring {len(mps)} mugshots…")
    download_photos(mps)
    missing = [m["slug"] for m in mps if not m.get("photoLocal")]
    print(f"  {len(mps) - len(missing)} saved" + (f", missing: {missing}" if missing else ""))

    by_div = {}
    unelected = {"Nominated Member of Parliament": [], "Non-Constituency Member of Parliament": []}
    for mp in mps:
        key = norm(mp["constituency"])
        if mp["constituency"] in unelected:
            unelected[mp["constituency"]].append(mp)
        else:
            by_div.setdefault(key, []).append(mp)

    # Ministers and office-holders first, then alphabetically.
    def rank(mp):
        roles = " ".join(mp["currentRoles"]).lower()
        for i, kw in enumerate(["prime minister", "senior minister", "deputy prime minister",
                                "minister for", "minister,", "speaker", "minister of state",
                                "senior parliamentary secretary", "parliamentary secretary"]):
            if kw in roles:
                return (i, mp["name"])
        return (99, mp["name"])

    out_features = []
    for feat in geo["features"]:
        p = feat["properties"]
        key = norm(p["ED_DESC_FU"])
        members = sorted(by_div.get(key, []), key=rank)
        if not members:
            print(f"  WARNING: no MPs for {p['ED_DESC_FU']}", file=sys.stderr)
        out_features.append({
            "type": "Feature",
            "properties": {
                "id": key,
                "name": p["ED_DESC_FU"].title().replace("Grc", "GRC").replace("Smc", "SMC"),
                "shortName": p["ED_DESC"].title(),
                "type": "GRC" if p["ED_DESC_FU"].endswith("GRC") else "SMC",
                "code": p.get("NEW_ED", ""),
                "seats": len(members),
                "parties": sorted({m["party"].replace("’", "'") for m in members}),
            },
            "geometry": {"type": feat["geometry"]["type"],
                         "coordinates": round_coords(feat["geometry"]["coordinates"])},
        })

    os.makedirs(os.path.join(DOCS, "data"), exist_ok=True)

    geo_out = os.path.join(DOCS, "data", "divisions.geojson")
    with open(geo_out, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": out_features}, f, separators=(",", ":"))

    keep = ["slug", "name", "salutation", "constituency", "party", "yearOfBirth", "photoLocal",
            "email", "officialEmail", "phone", "currentRoles", "pastRoles", "mps", "links",
            "detailUrl", "officeAddress", "mpSince", "termsServed"]
    mp_out = os.path.join(DOCS, "data", "mps.json")
    with open(mp_out, "w", encoding="utf-8") as f:
        json.dump({
            "generated": os.environ.get("BUILD_DATE", ""),
            "byDivision": {k: [{f: m.get(f) for f in keep} for m in sorted(v, key=rank)]
                           for k, v in by_div.items()},
            "unelected": {k: [{f: m.get(f) for f in keep} for m in sorted(v, key=lambda m: m["name"])]
                          for k, v in unelected.items()},
        }, f, ensure_ascii=False, separators=(",", ":"))

    print(f"Wrote {geo_out} ({os.path.getsize(geo_out) // 1024} KB)")
    print(f"Wrote {mp_out} ({os.path.getsize(mp_out) // 1024} KB)")
    print(f"{len(out_features)} divisions, {sum(len(v) for v in by_div.values())} elected MPs, "
          f"{sum(len(v) for v in unelected.values())} NMP/NCMP")


if __name__ == "__main__":
    main()
