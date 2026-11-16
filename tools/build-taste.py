#!/usr/bin/env python3
"""
Builds Musike's daylist taste profile (data/taste.json) from Exportify CSVs + matches.json (spotify-import.py).

  python3 build-taste.py <csv-dir> <out taste.json>

Each playlist gets moods from its name (MOODS below, first match wins). A mood says how well its songs fit each
time of day. A song takes the best fit of all the playlists it's in; liked songs count more. Songs only in
"taste" playlists (liked, discover weekly…) borrow the moods of their artist's other songs.
"""
import csv, glob, json, os, re, sys
from collections import Counter, defaultdict

d, out = sys.argv[1], sys.argv[2]
#                   morning afternoon evening night
SLOTS = ("morning", "afternoon", "evening", "night")
TAGS = {
    "classical":  (1.0, 0.5, 0.3, 0.8),
    "chill":      (0.9, 0.5, 0.3, 1.0),
    "sing-along": (0.8, 0.9, 0.7, 0.2),
    "rock":       (0.4, 1.0, 0.8, 0.3),
    "metal":      (0.1, 0.7, 1.0, 0.4),
    "dance":      (0.2, 0.5, 1.0, 0.6),
    "synthwave":  (0.3, 0.7, 0.8, 1.0),
    "asian pop":  (0.7, 0.7, 0.6, 0.5),
    "oldies":     (0.8, 0.7, 0.5, 0.5),
}
# (pattern on the CSV file name, moods). "taste" = a signal of what you like, no mood of its own;
# "mixed" = work/band/quiz lists: weak everywhere; "skip" = left out.
MOODS = [
    (r"^liked\.csv$|^daylist|discover_weekly|shazam|liked_from_radio", ["taste"]),
    (r"christmas|halloween", ["skip"]),
    (r"classical", ["classical"]),
    (r"jon_hopkins|foreign_family|flow_of_thoughts", ["chill"]),
    (r"synth|retrowave", ["synthwave"]),
    (r"metal|bite_night", ["metal"]),
    (r"club|trance|happy_hour", ["dance"]),
    (r"sing|shower|easy_00s|function_band|untitled", ["sing-along"]),
    (r"rock_anthems|rock_classics|twist_of_rock|nirvana|badass|beatles", ["rock"]),
    (r"暗殺|香港|kasih", ["asian pop"]),
    (r"ink_spots|java_jive", ["oldies"]),
    (r".", ["mixed"]),
]


def moods_for(name):
    for pat, tags in MOODS:
        if re.search(pat, name, re.I):
            return tags
    return ["mixed"]


matches = json.load(open(os.path.join(d, "matches.json")))
tracks, liked = {}, set()
weights = defaultdict(lambda: [0.0] * 4)
tags = defaultdict(set)
artist_tags = defaultdict(Counter)
taste_only = set()

for f in sorted(glob.glob(os.path.join(d, "*.csv"))):
    name = os.path.basename(f)
    if name == "saved_albums.csv":
        continue
    m = moods_for(name)
    if "skip" in m:
        continue
    for r in csv.DictReader(open(f, encoding="utf-8-sig")):
        mt = matches.get(r.get("Track URI", ""))
        if not mt or not mt["track"] or mt["score"] < 0.55:
            continue
        t = mt["track"]
        tid = t["id"]
        tracks[tid] = t
        if name == "liked.csv" or name.startswith("daylist"):
            liked.add(tid)
        if "taste" in m:
            taste_only.add(tid)
            continue
        w = weights[tid]
        for tag in m:
            sw = TAGS.get(tag, (0.35,) * 4)
            for i in range(4):
                w[i] = max(w[i], sw[i])
            if tag in TAGS:
                tags[tid].add(tag)
                artist_tags[t["artist"].split(",")[0].strip().lower()][tag] += 1

out_tracks = {}
for tid, t in tracks.items():
    w, tg = weights.get(tid), set(tags.get(tid, ()))
    if not w or max(w) <= 0.35:
        # only in taste/mixed lists: borrow the artist's moods, else neutral
        common = artist_tags.get(t["artist"].split(",")[0].strip().lower())
        if common:
            top = [tag for tag, _ in common.most_common(2)]
            w = [max(TAGS[tag][i] for tag in top) * 0.85 for i in range(4)]
            tg |= set(top)
        elif not w:
            w = [0.6] * 4
    out_tracks[tid] = {"track": t, "w": dict(zip(SLOTS, [round(x, 2) for x in w])), "tags": sorted(tg), "liked": tid in liked}

tmp = out + ".tmp"
json.dump({"tracks": out_tracks}, open(tmp, "w"), ensure_ascii=False)
os.replace(tmp, out)
c = Counter(tag for v in out_tracks.values() for tag in v["tags"])
print(f"{len(out_tracks)} songs, {sum(v['liked'] for v in out_tracks.values())} liked, moods: {dict(c.most_common())}")
