import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { LibraryStorage } from "./library.js";

/** The library as data/library.json, replaced atomically (write a temp file, then rename over). */
export function fileStorage(dir = config.dataDir): LibraryStorage {
  // The first profile keeps the original file name, so a server without profiles is unchanged.
  const fileOf = (profile: string) => path.join(dir, profile === "default" ? "library.json" : `library-${profile}.json`);
  return {
    read: async (profile) => (existsSync(fileOf(profile)) ? readFile(fileOf(profile), "utf8") : null),
    write: async (json, profile) => {
      const file = fileOf(profile);
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, json, "utf8");
      await rename(tmp, file);
    },
  };
}
