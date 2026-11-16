#!/usr/bin/env python3
"""
Imports Exportify CSV playlists into Musike: matches every track on YouTube Music through Musike's own search,
then creates one Musike playlist per CSV and adds liked.csv to Favorites.

  python3 spotify-import.py match  <csv-dir> [--server http://localhost:4180]   # slow, resumable
  python3 spotify-import.py create <csv-dir> [--server ...]                       # playlists + favorites
  python3 spotify-import.py report <csv-dir>                                      # unmatched / doubtful

Progress lives in <csv-dir>/matches.json, so `match` can be stopped and restarted.
"""
import csv, difflib, glob, json, os, re, sys, threading, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

args = [a for a in sys.argv[1:] if not a.startswith("--")]
SERVER = "http://localhost:4180"
if "--server" in sys.argv:
    SERVER = sys.argv[sys.argv.index("--server") + 1]
    args.remove(SERVER)
cmd, d = args[0], args[1]
MATCHES = os.path.join(d, "matches.json")
SKIP = {"saved_albums.csv"}


def playlists():
    for f in sorted(glob.glob(os.path.join(d, "*.csv"))):
        name = os.path.basename(f)
        if name in SKIP:
            continue
        rows = list(csv.DictReader(open(f, encoding="utf-8-sig")))
        yield name, [r for r in rows if r.get("Track URI", "").startswith("spotify:track:") and r.get("Track Name")]


def pretty(name):
    if name == "liked.csv":
        return "Liked Songs"
    base = os.path.splitext(name)[0].replace("_", " ").strip()
    return (base[:1].upper() + base[1:]) if base else "Untitled playlist"


def api(path, body=None, method=None):
    req = urllib.request.Request(SERVER + path, method=method or ("POST" if body is not None else "GET"))
    req.add_header("x-musike-lang", "en")
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, data, timeout=60) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


NOISE = re.compile(r"\s*[\(\[][^)\]]*(remaster|live|version|edit|mono|stereo|feat|ft\.|mix|deluxe|bonus|from |original)[^)\]]*[\)\]]", re.I)


def norm(s):
    s = NOISE.sub("", s or "")
    s = re.split(r"\s+-\s+(?=.*(remaster|live|version|edit|mono|stereo|mix))", s, flags=re.I)[0]
    return re.sub(r"[^\w]+", " ", s.lower()).strip()


def score(row, t):
    title = difflib.SequenceMatcher(None, norm(row["Track Name"]), norm(t["title"])).ratio()
    want_artists = [a.strip().lower() for a in re.split(r",|;", row["Artist Name(s)"]) if a.strip()]
    got = (t.get("artist") or "").lower()
    artist = 1.0 if any(a and a in got for a in want_artists) else difflib.SequenceMatcher(None, want_artists[0] if want_artists else "", got).ratio()
    want_s = int(row.get("Track Duration (ms)") or 0) / 1000
    diff = abs(want_s - (t.get("duration") or 0)) if want_s and t.get("duration") else 30
    dur = 1.0 if diff <= 3 else 0.7 if diff <= 10 else 0.3 if diff <= 30 else 0.0
    return title * 0.45 + artist * 0.35 + dur * 0.20


def match_one(row):
    first_artist = re.split(r",|;", row["Artist Name(s)"])[0].strip()
    q = f'{row["Track Name"]} {first_artist}'[:190]
    best, best_s = None, -1
    for kind in ("song", "video"):
        try:
            res = api(f"/api/search?q={urllib.parse.quote(q)}&type={kind}")["tracks"][:6]
        except Exception as e:
            time.sleep(5)
            res = []
        for t in res:
            s = score(row, t)
            if s > best_s:
                best, best_s = t, s
        if best_s >= 0.8:
            break
    return {"track": best, "score": round(best_s, 3), "query": q}


def load_matches():
    return json.load(open(MATCHES)) if os.path.exists(MATCHES) else {}


if cmd == "match":
    matches = load_matches()
    todo = {}
    for _, rows in playlists():
        for r in rows:
            if r["Track URI"] not in matches:
                todo.setdefault(r["Track URI"], r)
    print(f"{len(matches)} matched already, {len(todo)} to go", flush=True)
    lock = threading.Lock()
    done = [0]

    def work(item):
        uri, row = item
        m = match_one(row)
        with lock:
            matches[uri] = m
            done[0] += 1
            if done[0] % 25 == 0:
                json.dump(matches, open(MATCHES + ".tmp", "w"))
                os.replace(MATCHES + ".tmp", MATCHES)
                print(f"{done[0]}/{len(todo)}", flush=True)

    with ThreadPoolExecutor(3) as pool:
        list(pool.map(work, todo.items()))
    json.dump(matches, open(MATCHES + ".tmp", "w"))
    os.replace(MATCHES + ".tmp", MATCHES)
    print("MATCH DONE", flush=True)

elif cmd == "create":
    matches = load_matches()
    existing = {p["name"] for p in api("/api/library")["playlists"]}
    for name, rows in sorted(playlists(), key=lambda x: x[0] != "liked.csv"):
        tracks, seen = [], set()
        for r in rows:
            m = matches.get(r["Track URI"])
            if m and m["track"] and m["score"] >= 0.55 and m["track"]["id"] not in seen:
                seen.add(m["track"]["id"])
                tracks.append(m["track"])
        if name == "liked.csv":
            for i in range(0, len(tracks), 500):
                api("/api/favorites", {"tracks": tracks[i : i + 500]})
            print(f"Favorites: +{len(tracks)}")
            continue
        title = pretty(name)
        if title in existing:
            print(f"skip (exists): {title}")
            continue
        p = api("/api/playlists", {"name": title, "tracks": tracks[:500]})
        for i in range(500, len(tracks), 500):
            api(f"/api/playlists/{p['id']}/tracks", {"tracks": tracks[i : i + 500]})
        print(f"{title}: {len(tracks)}/{len(rows)}")

elif cmd == "report":
    matches = load_matches()
    rows = {r["Track URI"]: r for _, rs in playlists() for r in rs}
    bad = sorted(((m["score"], uri) for uri, m in matches.items()), key=lambda x: x[0])
    missing = [u for u, (s) in ((u, m["score"]) for u, m in matches.items()) if s < 0.55]
    doubtful = [u for u, m in matches.items() if 0.55 <= m["score"] < 0.75]
    print(f"total {len(matches)}  good {len(matches)-len(missing)-len(doubtful)}  doubtful {len(doubtful)}  skipped {len(missing)}")
    for label, uris in (("SKIPPED (no good match)", missing), ("DOUBTFUL (kept, check)", doubtful)):
        print(f"\n## {label}")
        for u in uris:
            r, m = rows.get(u), matches[u]
            if not r:
                continue
            got = f'{m["track"]["title"]} — {m["track"]["artist"]}' if m["track"] else "nothing"
            print(f'{r["Track Name"]} — {r["Artist Name(s)"]}  =>  {got}  ({m["score"]})')
