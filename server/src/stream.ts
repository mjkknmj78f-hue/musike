import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import { msg } from "./i18n.js";
import { HttpError } from "./types.js";
import { contentLength, getStream } from "./upstream.js";
import { invalidate, resolveStreams, type StreamFormat } from "./ytdlp.js";

const PASS_HEADERS = ["last-modified"];

/** Largest slice sent per request; the media element asks for the rest as it plays. */
const CHUNK = 16 * 1024 * 1024;

/** A browser `Range: bytes=…` against a stream of `total` bytes, or null when absent or unreadable. */
function parseRange(header: unknown, total: number): { start: number; end: number } | null {
  const m = typeof header === "string" ? /bytes=(\d*)-(\d*)/.exec(header) : null;
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const n = Number(m[2]);
    return { start: Math.max(0, total - n), end: total - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  return { start, end };
}

/** Start of the next tracks' audio, fetched while the current one plays so the switch has no wait. */
const HEAD_BYTES = 1024 * 1024;
const heads = new Map<string, { url: string; total: number; data: Buffer }>();

export async function warmHead(id: string): Promise<void> {
  if (heads.has(id)) return;
  const { audio } = await resolveStreams(id);
  const total = contentLength(audio.url);
  if (!total) return;
  const res = await getStream(audio.url, audio.headers, { start: 0, end: Math.min(HEAD_BYTES, total) - 1 });
  if (res.statusCode !== 200 && res.statusCode !== 206) {
    res.resume();
    return;
  }
  const parts: Buffer[] = [];
  for await (const c of res) parts.push(c as Buffer);
  heads.set(id, { url: audio.url, total, data: Buffer.concat(parts) });
  while (heads.size > 6) heads.delete(heads.keys().next().value!);
}

/**
 * Proxies a googlevideo stream with seeking. googlevideo URLs are bound to the IP that resolved them, so the bytes
 * must flow through this server; see upstream.ts for why ranges go in the query string and 403s are retried.
 */
export async function proxyStream(req: FastifyRequest, reply: FastifyReply, id: string, kind: "audio" | "video") {
  const pick = async (fresh: boolean): Promise<StreamFormat> => {
    if (fresh) invalidate(id);
    const resolved = await resolveStreams(id);
    const fmt = kind === "audio" ? resolved.audio : resolved.video;
    if (!fmt) throw new HttpError(404, msg("noSdVideo"));
    return fmt;
  };

  const controller = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });

  const open = async (fmt: StreamFormat) => {
    const total = contentLength(fmt.url);
    if (!total) {
      // Size unknown (e.g. some progressive formats): pass the browser's Range through as a header.
      const res = await getStream(fmt.url, fmt.headers, undefined, controller.signal, req.headers.range);
      return { res, total: null, slice: null };
    }
    const wanted = parseRange(req.headers.range, total) ?? { start: 0, end: total - 1 };
    if (wanted.start >= total) return { res: null, total, slice: null };
    const slice = { start: wanted.start, end: Math.min(wanted.end, wanted.start + CHUNK - 1) };
    const res = await getStream(fmt.url, fmt.headers, slice, controller.signal);
    return { res, total, slice };
  };

  let fmt = await pick(false);

  // The opening bytes were fetched ahead of time: answer from memory, the browser asks for the rest.
  const head = kind === "audio" ? heads.get(id) : undefined;
  if (head && head.url === fmt.url) {
    const wanted = parseRange(req.headers.range, head.total) ?? { start: 0, end: head.total - 1 };
    if (wanted.start < head.data.length) {
      const end = Math.min(wanted.end, head.data.length - 1);
      reply.code(206);
      reply.header("content-type", fmt.mime);
      reply.header("cache-control", "no-store");
      reply.header("accept-ranges", "bytes");
      reply.header("content-range", `bytes ${wanted.start}-${end}/${head.total}`);
      reply.header("content-length", end - wanted.start + 1);
      return reply.send(head.data.subarray(wanted.start, end + 1));
    }
  }

  let up = await open(fmt);
  // Expired, or still refused after retries on fresh connections: resolve again once.
  if (up.res && (up.res.statusCode === 403 || up.res.statusCode === 410)) {
    up.res.resume();
    fmt = await pick(true);
    up = await open(fmt);
  }
  if (up.total && !up.res) {
    reply.code(416).header("content-range", `bytes */${up.total}`);
    return reply.send();
  }
  const res = up.res!;
  const status = res.statusCode ?? 502;
  if (status < 200 || status >= 300) {
    res.resume();
    throw new HttpError(502, msg("streamRefused", { status }), "maybe_outdated");
  }

  reply.header("content-type", fmt.mime);
  reply.header("cache-control", "no-store");
  reply.header("accept-ranges", "bytes");
  for (const h of PASS_HEADERS) {
    const v = res.headers[h];
    if (typeof v === "string") reply.header(h, v);
  }
  if (up.total && up.slice) {
    const { start, end } = up.slice;
    const partial = typeof req.headers.range === "string" || end < up.total - 1;
    reply.code(partial ? 206 : 200);
    if (partial) reply.header("content-range", `bytes ${start}-${end}/${up.total}`);
    reply.header("content-length", end - start + 1);
  } else {
    reply.code(status);
    for (const h of ["content-length", "content-range"]) {
      const v = res.headers[h];
      if (typeof v === "string") reply.header(h, v);
    }
  }
  res.on("error", () => res.destroy());
  return reply.send(res);
}

/** Serves a local file with byte-range support (used for cached HD video). */
export async function serveFile(req: FastifyRequest, reply: FastifyReply, file: string, mime: string) {
  const { size } = await stat(file);
  const range = typeof req.headers.range === "string" ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null;

  reply.header("content-type", mime);
  reply.header("accept-ranges", "bytes");
  reply.header("cache-control", "no-store");

  if (!range) {
    reply.header("content-length", size);
    return reply.send(createReadStream(file));
  }

  let start = range[1] ? Number(range[1]) : NaN;
  let end = range[2] ? Number(range[2]) : size - 1;
  if (Number.isNaN(start)) {
    // suffix range: bytes=-N
    start = Math.max(0, size - end);
    end = size - 1;
  }
  end = Math.min(end, size - 1);
  if (start > end || start >= size) {
    reply.code(416).header("content-range", `bytes */${size}`);
    return reply.send();
  }

  reply.code(206);
  reply.header("content-range", `bytes ${start}-${end}/${size}`);
  reply.header("content-length", end - start + 1);
  return reply.send(createReadStream(file, { start, end }));
}
