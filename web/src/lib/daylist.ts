// Daylist: the server keeps a playlist with id "daylist" that changes with the time of day (server/src/daylist.ts).
// Only the server build has it; on Android these calls fail quietly and nothing shows.

export const DAYLIST_ID = "daylist";

async function call(path: string, method = "GET"): Promise<{ key: string; name: string } | null> {
  try {
    const res = await fetch(path, { method });
    if (!res.ok) return null;
    return ((await res.json()) as { daylist: { key: string; name: string } | null }).daylist;
  } catch {
    return null;
  }
}

/** Makes sure the daylist matches the current time of day. */
export const syncDaylist = () => call("/api/daylist");
/** A different mix for the same time of day. */
export const refreshDaylist = () => call("/api/daylist/refresh", "POST");
