import { listeningStats, rng, sample } from "./daylist.js";
import * as library from "./library.js";
import { currentProfile } from "./profiles.js";
import { radio, search } from "./search.js";
import type { Track } from "./types.js";

/**
 * "Made for you" mixes, rebuilt once a day per listener profile:
 *  - "Because you listen to <song>": YouTube Music radio from one of the songs played most.
 *  - "<Artist> Radio": that artist's songs mixed with similar artists, for the artists played most.
 * They are ordinary library playlists with fixed ids (mix-because-N, mix-radio-N), so they play, save and show
 * like any other playlist.
 */

const COUNT = 3;
const SIZE = 40;
const PER_ARTIST = 3;
export const MIX_PREFIX = "mix-";

const mainArtist = (a: string) => a.split(/,| & | feat\.? /i)[0]!.trim().toLowerCase();
const today = () => new Date().toLocaleDateString("en-CA");

/** Adds tracks until full, skipping repeats and keeping any one artist from taking over. */
function filler(limitPerArtist: number) {
  const out: Track[] = [];
  const seen = new Set<string>();
  const perArtist = new Map<string, number>();
  const add = (t: Track, cap = limitPerArtist) => {
    if (out.length >= SIZE || seen.has(t.id) || t.kind !== "song") return;
    const a = mainArtist(t.artist);
    if ((perArtist.get(a) ?? 0) >= cap) return;
    seen.add(t.id);
    perArtist.set(a, (perArtist.get(a) ?? 0) + 1);
    out.push(t);
  };
  return { out, add };
}

async function safeRadio(id: string): Promise<Track[]> {
  try {
    return await radio(id);
  } catch {
    return [];
  }
}

async function becauseMix(seed: Track): Promise<Track[]> {
  const { out, add } = filler(PER_ARTIST);
  add({ ...seed, kind: "song" }, Infinity);
  const first = await safeRadio(seed.id);
  first.forEach((t) => add(t));
  // A short radio: carry on from a song it suggested.
  for (const next of first.slice(0, 3)) {
    if (out.length >= SIZE * 0.75) break;
    (await safeRadio(next.id)).forEach((t) => add(t));
  }
  return out;
}

async function artistMix(name: string, known: Track[]): Promise<Track[]> {
  const key = name.toLowerCase();
  let own = known.slice(0, 6);
  try {
    const found = (await search(name, "song")).filter((t) => mainArtist(t.artist) === key);
    own = [...own, ...found.filter((t) => !own.some((o) => o.id === t.id))].slice(0, 12);
  } catch {
    /* their songs from the library are enough to seed it */
  }
  if (!own.length) return [];
  const similar: Track[] = [];
  for (const s of own.slice(0, 3)) similar.push(...(await safeRadio(s.id)).filter((t) => mainArtist(t.artist) !== key));
  // One of theirs, then two similar, all the way down.
  const { out, add } = filler(PER_ARTIST);
  let o = 0;
  let s = 0;
  while (out.length < SIZE && (o < own.length || s < similar.length)) {
    if (o < own.length) add({ ...own[o++]!, kind: "song" }, Infinity);
    if (s < similar.length) add(similar[s++]!);
    if (s < similar.length) add(similar[s++]!);
  }
  return out;
}

const running = new Map<string, Promise<void>>();

/** Builds today's mixes for the current profile, unless they're already from today (or `force`). */
export function ensureMixes(force = false): Promise<void> {
  const profile = currentProfile();
  const busy = running.get(profile);
  if (busy) return busy;
  const job = build(force).finally(() => running.delete(profile));
  running.set(profile, job);
  return job;
}

async function build(force: boolean): Promise<void> {
  const lib = await library.getLibrary();
  const mine = lib.playlists.filter((p) => p.id.startsWith(MIX_PREFIX));
  if (!force && mine.length && mine.every((p) => new Date(p.updatedAt).toLocaleDateString("en-CA") === today())) return;

  const stats = await listeningStats();
  if (stats.songs.size < 5) return;
  const rand = rng(today() + (force ? String(Date.now()) : ""));

  // Seeds change day to day, drawn from the most played rather than always the very top.
  const topSongs = [...stats.songs.values()].sort((a, b) => b.score - a.score).slice(0, 15);
  const seeds: Track[] = [];
  for (const s of sample(topSongs.map((e) => ({ item: e.track, w: e.score })), 15, rand)) {
    if (seeds.length >= COUNT) break;
    if (!seeds.some((x) => mainArtist(x.artist) === mainArtist(s.artist))) seeds.push(s);
  }
  const topArtists = [...stats.artists.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 10);
  const artists = sample(topArtists.map(([k, a]) => ({ item: { key: k, name: a.name }, w: a.score })), COUNT, rand);

  const made = new Set<string>();
  for (const [i, seed] of seeds.entries()) {
    const tracks = await becauseMix(seed);
    if (tracks.length < 10) continue;
    const id = `${MIX_PREFIX}because-${i}`;
    await library.upsertPlaylist(id, `Because you listen to ${seed.title}`, tracks, true);
    made.add(id);
  }
  for (const [i, a] of artists.entries()) {
    const known = [...stats.songs.values()]
      .filter((e) => mainArtist(e.track.artist) === a.key)
      .sort((x, y) => y.score - x.score)
      .map((e) => e.track);
    const tracks = await artistMix(a.name, known);
    if (tracks.length < 10) continue;
    const id = `${MIX_PREFIX}radio-${i}`;
    await library.upsertPlaylist(id, `${a.name} Radio`, tracks, true);
    made.add(id);
  }
  // Yesterday's mixes that couldn't be rebuilt today are dropped rather than left stale.
  for (const p of mine) if (!made.has(p.id)) await library.deletePlaylist(p.id).catch(() => {});
}
