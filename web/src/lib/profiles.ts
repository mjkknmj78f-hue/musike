import { create } from "zustand";
import { capabilities } from "./api";

// Listener profiles (server/src/profiles.ts): each has its own library, history and daylist on the server.
// The chosen profile is remembered per device and sent with every API request as `x-musike-profile`.

export interface Profile {
  id: string;
  name: string;
  avatar: string;
  color: string;
}

const KEY = "musike:profile";

function stored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Adds the profile header to the app's own API calls. Runs once, before the app makes any. */
export function installProfileHeader() {
  const id = stored();
  if (!id || !capabilities.engineSettings) return;
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith("/") ? url : url.startsWith(location.origin) ? url.slice(location.origin.length) : "";
    if (!path.startsWith("/api/")) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("x-musike-profile", id);
    return original(input, { ...init, headers });
  };
}

/** Choosing or leaving a profile reloads the app, so every store starts fresh with the right library. */
export function chooseProfile(id: string | null) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the picker shows again next time */
  }
  location.reload();
}

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

interface ProfilesState {
  /** Off on builds without a server (Android) or a server without profile support. */
  enabled: boolean;
  profiles: Profile[];
  currentId: string | null;
  init: () => Promise<void>;
  create: (p: Omit<Profile, "id">) => Promise<Profile>;
  update: (id: string, p: Partial<Profile>) => Promise<void>;
}

export const useProfiles = create<ProfilesState>((set, get) => ({
  enabled: false,
  profiles: [],
  currentId: stored(),
  init: async () => {
    if (!capabilities.engineSettings) return;
    try {
      const { profiles } = await call<{ profiles: Profile[] }>("/api/profiles");
      const currentId = get().currentId;
      // A profile removed on the server, or none chosen yet with only one there: just use the first.
      if (profiles.length === 1 && currentId !== profiles[0]!.id) {
        try {
          localStorage.setItem(KEY, profiles[0]!.id);
        } catch {
          /* private mode */
        }
        set({ currentId: profiles[0]!.id });
      }
      set({ enabled: true, profiles });
    } catch {
      set({ enabled: false });
    }
  },
  create: async (p) => {
    const made = await call<Profile>("/api/profiles", "POST", p);
    set((s) => ({ profiles: [...s.profiles, made] }));
    return made;
  },
  update: async (id, p) => {
    const saved = await call<Profile>(`/api/profiles/${id}`, "PATCH", p);
    set((s) => ({ profiles: s.profiles.map((x) => (x.id === id ? saved : x)) }));
  },
}));

export const currentProfile = (s: ProfilesState) => s.profiles.find((p) => p.id === s.currentId) ?? null;

/** A square JPEG data URL, centre-cropped, small enough to keep in profiles.json. */
export function photoToAvatar(file: File, size = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.width, img.height);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      canvas.getContext("2d")!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => reject(new Error("That file isn't a picture."));
    img.src = URL.createObjectURL(file);
  });
}
