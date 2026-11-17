import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { HttpError } from "./types.js";

/**
 * Listener profiles, Netflix style: everyone who reaches the server is trusted (it sits behind the home login),
 * so a profile is a name and a picture, not an account. Each one has its own library, history and daylist.
 * The browser says which profile it is with the `x-musike-profile` header; unknown or missing means "default",
 * the first profile, which owns the files from before profiles existed.
 */

export interface Profile {
  id: string;
  name: string;
  /** An emoji, or a small image as a data: URL. */
  avatar: string;
  color: string;
}

const COLORS = ["#e9785d", "#5db0e9", "#9d7be8", "#5fcf8f", "#e9c25d", "#e85d9b"];
const MAX_PROFILES = 8;
const MAX_AVATAR = 300 * 1024;

const file = () => path.join(config.dataDir, "profiles.json");
let profiles: Profile[] | null = null;
const als = new AsyncLocalStorage<string>();

export const currentProfile = () => als.getStore() ?? "default";

/** Runs `fn` as `profile`: library and daylist calls inside it use that profile's data. */
export const runAs = <T>(profile: string, fn: () => T): T => als.run(profile, fn);

export async function listProfiles(): Promise<Profile[]> {
  if (profiles) return profiles;
  profiles = existsSync(file()) ? (JSON.parse(await readFile(file(), "utf8")) as Profile[]) : [];
  if (!profiles.length) profiles = [{ id: "default", name: "Me", avatar: "🎧", color: COLORS[0]! }];
  return profiles;
}

/** The profile id a request asks for, if it exists. */
export async function profileFor(header: unknown): Promise<string> {
  const id = typeof header === "string" ? header : "";
  return (await listProfiles()).some((p) => p.id === id) ? id : "default";
}

async function store() {
  const tmp = `${file()}.tmp`;
  await writeFile(tmp, JSON.stringify(profiles, null, 2));
  await rename(tmp, file());
}

function clean(input: Partial<Profile>, base: Profile): Profile {
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 40) : base.name;
  let avatar = base.avatar;
  if (typeof input.avatar === "string") {
    const ok = input.avatar.startsWith("data:image/") ? input.avatar.length <= MAX_AVATAR : [...input.avatar].length <= 8;
    if (ok && input.avatar) avatar = input.avatar;
  }
  const color = typeof input.color === "string" && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : base.color;
  return { ...base, name, avatar, color };
}

export async function createProfile(input: Partial<Profile>): Promise<Profile> {
  const list = await listProfiles();
  if (list.length >= MAX_PROFILES) throw new HttpError(400, "There are already 8 profiles.");
  const p = clean(input, { id: randomBytes(4).toString("hex"), name: "New profile", avatar: "🎵", color: COLORS[list.length % COLORS.length]! });
  list.push(p);
  await store();
  return p;
}

export async function updateProfile(id: string, input: Partial<Profile>): Promise<Profile> {
  const list = await listProfiles();
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) throw new HttpError(404, "Profile not found.");
  list[i] = clean(input, list[i]!);
  await store();
  return list[i]!;
}
