import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { config } from "./config.js";
import { tools } from "./tools.js";
import { msg } from "./i18n.js";
import { HttpError, VIDEO_ID, type Track } from "./types.js";
import { contentLength, getStream } from "./upstream.js";
import { invalidate, resolveStreams } from "./ytdlp.js";

/**
 * "Save to library": downloads tracks as tagged M4A files into a music folder (MUSIKE_SAVE_DIR) that a music
 * server such as Navidrome scans. Jobs run a couple at a time and live in memory; the files are the real record.
 */

export interface AlbumInfo {
  title: string;
  artist: string;
  year?: string;
}

export type SaveStatus = "queued" | "saving" | "done" | "exists" | "error";

export interface SaveJob {
  key: string;
  id: string;
  title: string;
  artist: string;
  album: string;
  status: SaveStatus;
  error?: string;
  /** Path inside the save folder. */
  file?: string;
  at: number;
}

interface Work {
  job: SaveJob;
  track: Track;
  albumArtist: string;
  trackNo?: number;
  trackTotal?: number;
  year?: string;
}

const CONCURRENCY = 2;
const KEEP_FINISHED = 300;

const jobs: SaveJob[] = [];
const pending: Work[] = [];
let active = 0;
let scanTimer: NodeJS.Timeout | null = null;
/** Playlists waiting for their songs: written as .m3u files once the queue empties. */
const playlists = new Map<string, string[]>();

export const saveEnabled = () => !!config.saveDir;

/** Safe on every filesystem a NAS might use: no reserved characters, no trailing dots or spaces. */
export function safeName(s: string, fallback: string): string {
  const clean = s
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .slice(0, 120)
    .trim();
  return clean || fallback;
}

/** "A, B & C" → "A": one folder per main artist, like a tagged CD rip. */
const mainArtist = (artists: string) => artists.split(/,| & | feat\.? | ft\.? /i)[0]?.trim() || artists;

export function targetPath(w: Pick<Work, "track" | "albumArtist" | "trackNo">): string {
  const artistDir = safeName(w.albumArtist, "Unknown Artist");
  const albumDir = safeName(w.track.album || "Singles", "Singles");
  const no = w.trackNo ? `${String(w.trackNo).padStart(2, "0")} - ` : "";
  return path.join(artistDir, albumDir, `${no}${safeName(w.track.title, w.track.id)}.m4a`);
}

export function listJobs(): SaveJob[] {
  return jobs;
}

export function clearFinished(): SaveJob[] {
  for (let i = jobs.length - 1; i >= 0; i--) {
    if (jobs[i]!.status !== "queued" && jobs[i]!.status !== "saving") jobs.splice(i, 1);
  }
  return jobs;
}

/** Queues tracks. With `album`, they're numbered in the order given and share its artist and year. */
export function enqueue(tracks: Track[], album?: AlbumInfo, playlist?: string): SaveJob[] {
  if (!config.saveDir) throw new HttpError(404, msg("routeNotFound"));
  const added: SaveJob[] = [];
  const files: string[] = [];
  tracks.forEach((t, i) => {
    if (!VIDEO_ID.test(t.id)) return;
    const track: Track = album ? { ...t, album: album.title || t.album } : t;
    const albumArtist = mainArtist(album?.artist || t.artist || "Unknown Artist");
    const work: Work = {
      track,
      albumArtist,
      trackNo: album ? i + 1 : undefined,
      trackTotal: album ? tracks.length : undefined,
      year: album?.year,
      job: undefined as unknown as SaveJob,
    };
    const file = targetPath(work);
    files.push(file);
    // The same file already queued or saving: don't download it twice.
    if (jobs.some((j) => j.file === file && (j.status === "queued" || j.status === "saving"))) return;
    work.job = {
      key: randomBytes(6).toString("hex"),
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: track.album || "Singles",
      status: "queued",
      file,
      at: Date.now(),
    };
    jobs.push(work.job);
    pending.push(work);
    added.push(work.job);
  });
  if (playlist) playlists.set(safeName(playlist, "Playlist"), files);
  trim();
  pump();
  if (playlist && !active && !pending.length) void finishBatch();
  return added;
}

function trim() {
  while (jobs.length > KEEP_FINISHED) {
    const i = jobs.findIndex((j) => j.status !== "queued" && j.status !== "saving");
    if (i < 0) break;
    jobs.splice(i, 1);
  }
}

function pump() {
  while (active < CONCURRENCY && pending.length) {
    const work = pending.shift()!;
    active++;
    save(work)
      .catch(() => {})
      .finally(() => {
        active--;
        if (!active && !pending.length) void finishBatch();
        pump();
      });
  }
}

async function save(w: Work) {
  const { job } = w;
  const dest = path.join(config.saveDir!, job.file!);
  if (existsSync(dest)) {
    job.status = "exists";
    return;
  }
  job.status = "saving";
  const tmp = path.join(config.cacheDir, "save", job.key);
  try {
    const audio = await downloadAudio(job.id, tmp);
    const cover = await fetchCover(w.track, tmp);
    const out = path.join(tmp, "out.m4a");
    await tag(audio, cover, out, w);
    await mkdir(path.dirname(dest), { recursive: true });
    // Copy then rename inside the library folder: the NAS is another filesystem, and a half-written file must
    // never be scanned.
    const part = `${dest}.part`;
    await copyFile(out, part);
    await rename(part, dest);
    // Navidrome and Jellyfin both use a cover.jpg next to the songs as the album's picture.
    const folderCover = path.join(path.dirname(dest), "cover.jpg");
    if (cover && !existsSync(folderCover)) await copyFile(cover, folderCover).catch(() => {});
    job.status = "done";
  } catch (e) {
    job.status = "error";
    job.error = (e as Error).message.slice(0, 300);
  } finally {
    job.at = Date.now();
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

const CHUNK = 10 * 1024 * 1024;

/**
 * Downloads a track's audio (the same stream Musike plays) into `dir`, in ranged chunks like yt-dlp, through the
 * retrying fetcher in upstream.ts. Re-resolves the stream once if googlevideo keeps refusing it.
 */
async function downloadAudio(id: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (let round = 0; round < 2; round++) {
    if (round) invalidate(id);
    const { audio } = await resolveStreams(id);
    const file = path.join(dir, audio.mime === "audio/webm" ? "audio.webm" : "audio.m4a");
    const total = contentLength(audio.url);
    const out = createWriteStream(file);
    try {
      if (!total) {
        const res = await getStream(audio.url, audio.headers);
        if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
        await pipeline(res, out);
        return file;
      }
      for (let start = 0; start < total; start += CHUNK) {
        const res = await getStream(audio.url, audio.headers, { start, end: Math.min(start + CHUNK, total) - 1 });
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          throw new Error(`YouTube refused the download (HTTP ${res.statusCode})`);
        }
        await pipeline(res, out, { end: false });
      }
      out.end();
      await new Promise<void>((r) => out.on("close", () => r()));
      return file;
    } catch (e) {
      out.destroy();
      if (round) throw e;
    }
  }
  throw new Error("unreachable");
}

/** The album art as a JPEG, or null: a song saves fine without one. */
async function fetchCover(t: Track, dir: string): Promise<string | null> {
  const url = t.art || t.thumb;
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const raw = path.join(dir, "cover.src");
    await writeFile(raw, Buffer.from(await res.arrayBuffer()));
    // Whatever YouTube served (JPEG, WebP), make it a square-ish JPEG every player reads.
    const jpg = path.join(dir, "cover.jpg");
    await ffmpeg(["-y", "-i", raw, "-frames:v", "1", "-q:v", "2", jpg]);
    return jpg;
  } catch {
    return null;
  }
}

async function tag(audio: string, cover: string | null, out: string, w: Work) {
  const isAac = audio.endsWith(".m4a") || audio.endsWith(".mp4");
  const meta: Record<string, string | undefined> = {
    title: w.track.title,
    artist: w.track.artist,
    album_artist: w.albumArtist,
    album: w.track.album || "Singles",
    track: w.trackNo ? `${w.trackNo}/${w.trackTotal}` : undefined,
    date: w.year,
    comment: `https://www.youtube.com/watch?v=${w.track.id}`,
  };
  const args = ["-y", "-i", audio];
  if (cover) args.push("-i", cover);
  args.push("-map", "0:a:0");
  if (cover) args.push("-map", "1:v:0", "-c:v", "copy", "-disposition:v:0", "attached_pic");
  // AAC is kept as it came (no quality lost); Opus is re-encoded, since M4A players expect AAC.
  args.push("-c:a", isAac ? "copy" : "aac", ...(isAac ? [] : ["-b:a", "192k"]));
  args.push("-map_metadata", "-1");
  for (const [k, v] of Object.entries(meta)) if (v) args.push("-metadata", `${k}=${v}`);
  args.push("-movflags", "+faststart", out);
  await ffmpeg(args);
}

function ffmpeg(args: string[]): Promise<void> {
  const bin = tools().ffmpeg;
  if (!bin) return Promise.reject(new Error("FFmpeg isn't installed, so songs can't be tagged."));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-hide_banner", "-loglevel", "error", ...args], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg: ${stderr.trim().slice(-240)}`))));
  });
}

async function finishBatch() {
  await writePlaylists().catch(() => {});
  scheduleScan();
}

/**
 * Writes each saved playlist as <save dir>/Playlists/<name>.m3u, listing the songs that made it to disk.
 * Navidrome imports .m3u files from its music folder as playlists, so the playlist shows up there too
 * (and in phone apps that download for offline listening).
 */
async function writePlaylists() {
  if (!playlists.size) return;
  const dir = path.join(config.saveDir!, "Playlists");
  await mkdir(dir, { recursive: true });
  for (const [name, files] of [...playlists]) {
    playlists.delete(name);
    const lines = files.filter((f) => existsSync(path.join(config.saveDir!, f))).map((f) => `../${f.split(path.sep).join("/")}`);
    if (!lines.length) continue;
    const dest = path.join(dir, `${name}.m3u`);
    await writeFile(`${dest}.part`, `#EXTM3U\n#PLAYLIST:${name}\n${lines.join("\n")}\n`);
    await rename(`${dest}.part`, dest);
  }
}

/** Asks Navidrome to rescan a few seconds after the queue empties, so one album triggers one scan. */
function scheduleScan() {
  const { url, user, pass } = config.navidrome;
  if (!url || !user || !pass) return;
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    scanTimer = null;
    const salt = randomBytes(8).toString("hex");
    const token = createHash("md5").update(pass + salt).digest("hex");
    const q = new URLSearchParams({ u: user, t: token, s: salt, v: "1.16.1", c: "musike", f: "json" });
    fetch(`${url}/rest/startScan?${q}`, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
  }, 5_000);
}
