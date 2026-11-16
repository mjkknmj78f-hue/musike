import type { IncomingMessage } from "node:http";
import https from "node:https";

/**
 * Fetching from googlevideo, robust to two things that break plain `fetch(url, { Range })`:
 *
 * 1. Some player clients' URLs (e.g. TVHTML5) refuse a `Range` header with 403 but accept the same range as a
 *    `&range=start-end` query parameter, which is what yt-dlp itself sends.
 * 2. Stream URLs are bound to the public IP that resolved them. Behind carrier-grade NAT with a pool of public
 *    IPs (common on 4G/5G home broadband), each new TCP connection can leave from a different IP, so a request
 *    may get 403 on one connection and 200 on the next. Every attempt here opens a fresh connection
 *    (`agent: false`) and a 403 is retried a few times before giving up.
 */

const ATTEMPTS = 10;

/** Total size of the stream, from the URL's `clen` parameter (googlevideo sets it on DASH formats). */
export function contentLength(url: string): number | null {
  const n = Number(new URL(url).searchParams.get("clen"));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function get(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, agent: false, signal }, resolve);
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("googlevideo timed out")));
  });
}

/**
 * GETs `url`, bytes `start`..`end` (inclusive) when given, retrying 403s on new connections.
 * Resolves with the last response; the caller checks `statusCode`.
 */
export async function getStream(
  url: string,
  headers: Record<string, string>,
  range?: { start: number; end: number },
  signal?: AbortSignal,
  /** Only for streams without a known size, where the query parameter can't be built: a raw Range header. */
  rangeHeader?: string,
): Promise<IncomingMessage> {
  const target = range ? `${url}&range=${range.start}-${range.end}` : url;
  // The Range header is what some clients refuse: never forward the caller's.
  const clean = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== "range"));
  if (rangeHeader && !range) clean.Range = rangeHeader;
  let res: IncomingMessage | null = null;
  for (let i = 0; i < ATTEMPTS; i++) {
    res = await get(target, clean, signal);
    if (res.statusCode !== 403) return res;
    res.resume(); // drain and drop this connection, then try another
  }
  return res!;
}
