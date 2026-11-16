import { existsSync } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import * as library from "./library.js";
import { radio } from "./search.js";
import type { Track } from "./types.js";

/**
 * Daylist: a playlist that changes with the time of day, like Spotify's. Built from a taste profile
 * (data/taste.json, written by tools/build-taste.py from imported Spotify playlists) and from what is played
 * in Musike at each time of day (data/daylist.json, learned here). About two thirds are songs you know that fit
 * the moment; the rest are new songs from YouTube Music radio seeded by them.
 */

export type Slot = "morning" | "afternoon" | "evening" | "night";
const SLOTS: Slot[] = ["morning", "afternoon", "evening", "night"];

interface TasteTrack {
  track: Track;
  /** How well the song fits each time of day, 0–1. */
  w: Partial<Record<Slot, number>>;
  /** Moods/genres from the playlists it came from, e.g. "classical", "rock". */
  tags: string[];
  liked?: boolean;
}

interface Taste {
  tracks: Record<string, TasteTrack>;
}

interface Learned {
  /** Plays per song per time of day. */
  plays: Record<string, { track: Track; n: Partial<Record<Slot, number>> }>;
  /** Plays per main artist per time of day. */
  artists: Record<string, Partial<Record<Slot, number>>>;
  current?: { key: string; name: string };
}

export const DAYLIST_ID = "daylist";
const SIZE = 40;
const NEW_SHARE = 1 / 3;

const tastePath = () => path.join(config.dataDir, "taste.json");
const learnedPath = () => path.join(config.dataDir, "daylist.json");

let taste: Taste = { tracks: {} };
let tasteMtime = 0;
let learned: Learned | null = null;
let busy: Promise<unknown> | null = null;

async function loadTaste(): Promise<Taste> {
  if (!existsSync(tastePath())) return taste;
  const m = (await stat(tastePath())).mtimeMs;
  if (m !== tasteMtime) {
    taste = JSON.parse(await readFile(tastePath(), "utf8")) as Taste;
    tasteMtime = m;
  }
  return taste;
}

async function loadLearned(): Promise<Learned> {
  if (learned) return learned;
  learned = existsSync(learnedPath())
    ? (JSON.parse(await readFile(learnedPath(), "utf8")) as Learned)
    : { plays: {}, artists: {} };
  return learned;
}

async function saveLearned() {
  const tmp = `${learnedPath()}.tmp`;
  await writeFile(tmp, JSON.stringify(learned));
  await rename(tmp, learnedPath());
}

/** Morning 5–12, afternoon 12–17, evening 17–22, night 22–5 (the night after midnight belongs to the day before). */
export function slotAt(d: Date): { slot: Slot; key: string; day: Date } {
  const h = d.getHours();
  const slot: Slot = h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 22 ? "evening" : "night";
  const day = new Date(d);
  if (h < 5) day.setDate(day.getDate() - 1);
  const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  return { slot, key: `${ymd}:${slot}`, day };
}

const mainArtist = (a: string) => a.split(/,| & | feat\.? /i)[0]!.trim().toLowerCase();

/** Learns from a play: this song, and this artist, suit this time of day. */
export async function recordPlay(track: Track) {
  const l = await loadLearned();
  const { slot } = slotAt(new Date());
  const p = (l.plays[track.id] ??= { track, n: {} });
  p.track = track;
  p.n[slot] = (p.n[slot] ?? 0) + 1;
  const a = (l.artists[mainArtist(track.artist)] ??= {});
  a[slot] = (a[slot] ?? 0) + 1;
  await saveLearned();
}

/** Small seeded PRNG, so a daylist stays the same for its whole time slot unless refreshed. */
function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/** Weighted sampling without replacement (Efraimidis–Spirakis). */
function sample<T>(items: { item: T; w: number }[], n: number, rand: () => number): T[] {
  return items
    .filter((x) => x.w > 0)
    .map((x) => ({ item: x.item, k: Math.pow(rand(), 1 / x.w) }))
    .sort((a, b) => b.k - a.k)
    .slice(0, n)
    .map((x) => x.item);
}

const LABEL: Record<Slot, string> = { morning: "morning", afternoon: "afternoon", evening: "evening", night: "night" };

async function build(salt = ""): Promise<{ key: string; name: string; tracks: Track[] }> {
  const t = await loadTaste();
  const l = await loadLearned();
  const now = new Date();
  const { slot, key, day } = slotAt(now);
  const rand = rng(key + salt);
  const recent = new Set((await library.getLibrary()).history.slice(0, 30).map((h) => h.id));

  const artistMax = Math.max(1, ...Object.values(l.artists).map((a) => a[slot] ?? 0));
  const pool = new Map<string, { track: Track; w: number; tags: string[] }>();
  for (const [id, tt] of Object.entries(t.tracks)) {
    let w = (tt.w[slot] ?? 0.3) * (tt.liked ? 1.5 : 1);
    pool.set(id, { track: tt.track, w, tags: tt.tags });
  }
  for (const [id, p] of Object.entries(l.plays)) {
    const e = pool.get(id) ?? { track: p.track, w: 0.3, tags: [] };
    e.w += 0.6 * Math.min(p.n[slot] ?? 0, 5) / 5;
    pool.set(id, e);
  }
  for (const e of pool.values()) {
    e.w += 0.4 * ((l.artists[mainArtist(e.track.artist)]?.[slot] ?? 0) / artistMax);
    if (recent.has(e.track.id)) e.w *= 0.25;
    e.w = e.w * e.w; // sharpen: favour what really fits this time of day
  }

  const knownCount = Math.round(SIZE * (1 - NEW_SHARE));
  const known = sample([...pool.values()].map((e) => ({ item: e, w: e.w })), knownCount, rand);

  // New music: YouTube Music radio from a few of the best fits.
  const fresh: Track[] = [];
  const taken = new Set([...pool.keys()]);
  for (const seed of known.slice(0, 5)) {
    try {
      const next = (await radio(seed.track.id)).filter((x) => x.kind === "song" && !taken.has(x.id));
      for (const x of next.slice(0, Math.ceil((SIZE - knownCount) / 5))) {
        taken.add(x.id);
        fresh.push(x);
      }
    } catch {
      /* radio is a bonus: the daylist works without it */
    }
  }

  // Two known songs, then one new one.
  const tracks: Track[] = [];
  let k = 0;
  let f = 0;
  while (k < known.length || f < fresh.length) {
    if (k < known.length) tracks.push(known[k++]!.track);
    if (k < known.length) tracks.push(known[k++]!.track);
    if (f < fresh.length) tracks.push(fresh[f++]!);
  }

  const tagCount = new Map<string, number>();
  for (const e of known) for (const tag of e.tags) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
  const top = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([tag]) => tag);
  const weekday = day.toLocaleDateString("en-GB", { weekday: "long" });
  const name = `daylist · ${weekday} ${LABEL[slot]}${top.length ? `: ${top.join(" & ")}` : ""}`;
  return { key, name, tracks };
}

/** Rebuilds the daylist playlist when the time slot has changed (or when forced). */
export async function ensureDaylist(force = false): Promise<{ key: string; name: string } | null> {
  if (busy) await busy.catch(() => {});
  const t = await loadTaste();
  const l = await loadLearned();
  if (!Object.keys(t.tracks).length && !Object.keys(l.plays).length) return null;
  const { key } = slotAt(new Date());
  const has = (await library.getLibrary()).playlists.some((p) => p.id === DAYLIST_ID);
  if (!force && has && l.current?.key === key) return l.current;
  const job = (async () => {
    const d = await build(force ? String(Date.now()) : "");
    await library.upsertPlaylist(DAYLIST_ID, d.name, d.tracks);
    l.current = { key: d.key, name: d.name };
    await saveLearned();
    return l.current;
  })();
  busy = job;
  try {
    return await job;
  } finally {
    busy = null;
  }
}

export function startDaylistTimer() {
  const tick = () => ensureDaylist().catch(() => {});
  setTimeout(tick, 10_000);
  setInterval(tick, 5 * 60_000).unref();
}

export { SLOTS };
