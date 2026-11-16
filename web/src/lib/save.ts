import { create } from "zustand";
import { getLang, getT } from "../i18n";
import { toast } from "../stores/ui";
import type { Track } from "./types";

// "Save to library": the server downloads tracks into a music folder (MUSIKE_SAVE_DIR) that Navidrome scans.
// Only a server with that folder set offers it; the Android build and plain installs never see the buttons.

export type SaveStatus = "queued" | "saving" | "done" | "exists" | "error";

export interface SaveJob {
  key: string;
  id: string;
  title: string;
  artist: string;
  album: string;
  status: SaveStatus;
  error?: string;
  file?: string;
  at: number;
}

export interface AlbumInfo {
  title: string;
  artist: string;
  year?: string;
}

interface SaveState {
  enabled: boolean;
  jobs: SaveJob[];
  /** Jobs of the current batch, for "Saving 3 of 12" and the summary when it ends. */
  batch: string[];
  init: () => Promise<void>;
  save: (tracks: Track[], album?: AlbumInfo, playlist?: string) => Promise<void>;
}

const isActive = (j: SaveJob) => j.status === "queued" || j.status === "saving";

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: { "x-musike-lang": getLang(), ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

let timer: ReturnType<typeof setTimeout> | null = null;

export const useSave = create<SaveState>((set, get) => {
  const poll = async () => {
    timer = null;
    try {
      const { jobs } = await call<{ enabled: boolean; jobs: SaveJob[] }>("/api/save");
      set({ jobs });
      const batch = jobs.filter((j) => get().batch.includes(j.key));
      if (batch.some(isActive)) {
        timer = setTimeout(poll, 1500);
        return;
      }
      if (get().batch.length) summarize(batch);
      set({ batch: [] });
    } catch {
      timer = setTimeout(poll, 5000);
    }
  };
  const watch = () => {
    if (!timer) timer = setTimeout(poll, 800);
  };

  return {
    enabled: false,
    jobs: [],
    batch: [],
    init: async () => {
      try {
        const r = await call<{ enabled: boolean; jobs: SaveJob[] }>("/api/save");
        set({ enabled: r.enabled, jobs: r.jobs });
      } catch {
        set({ enabled: false });
      }
    },
    save: async (tracks, album, playlist) => {
      const t = getT();
      if (!tracks.length) return;
      try {
        const r = await call<{ added: SaveJob[]; jobs: SaveJob[] }>("/api/save", { method: "POST", json: { tracks, album, playlist } });
        if (!r.added.length) {
          toast(t.save.alreadySaving);
          return;
        }
        set((s) => ({ jobs: r.jobs, batch: [...s.batch, ...r.added.map((j) => j.key)] }));
        toast(t.save.started(r.added.length));
        watch();
      } catch (e) {
        toast(t.save.failed((e as Error).message), "error");
      }
    },
  };
});

function summarize(batch: SaveJob[]) {
  const t = getT();
  const saved = batch.filter((j) => j.status === "done").length;
  const had = batch.filter((j) => j.status === "exists").length;
  const failed = batch.filter((j) => j.status === "error");
  if (failed.length) {
    toast(t.save.someFailed(saved, failed.length, failed[0]!.error ?? ""), "error");
  } else {
    toast(t.save.finished(saved, had));
  }
}

/** The year from YouTube Music's "Album • 1991" line. */
export const yearOf = (line: string) => line.match(/\b(19|20)\d\d\b/)?.[0];
