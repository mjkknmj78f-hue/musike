import { ImageIcon, PencilSimpleIcon, PlusIcon, UsersIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useT } from "../i18n";
import { cn } from "../lib/format";
import { chooseProfile, currentProfile, photoToAvatar, useProfiles, type Profile } from "../lib/profiles";
import { toast } from "../stores/ui";
import { Modal } from "./Modal";

const EMOJIS = ["🎧", "🎵", "🌸", "🦊", "🐱", "🐶", "🦉", "🌙", "☀️", "🌻", "🍓", "🎸", "🎹", "🥁", "👑", "⭐"];
const COLORS = ["#e9785d", "#5db0e9", "#9d7be8", "#5fcf8f", "#e9c25d", "#e85d9b"];

export function Avatar({ profile, size }: { profile: Pick<Profile, "avatar" | "color" | "name">; size: number }) {
  const isPhoto = profile.avatar.startsWith("data:image/");
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full"
      style={{ width: size, height: size, background: profile.color, fontSize: size * 0.5 }}
      aria-hidden="true"
    >
      {isPhoto ? <img src={profile.avatar} alt="" className="size-full object-cover" /> : profile.avatar || profile.name.slice(0, 1)}
    </span>
  );
}

/** "Who's listening?": shown until this device has picked a profile, when there is more than one. */
export function ProfilePicker() {
  const t = useT();
  const { enabled, profiles, currentId } = useProfiles();
  if (!enabled || profiles.length < 2 || profiles.some((p) => p.id === currentId)) return null;
  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-10 bg-bg px-4">
      <h1 className="text-center text-3xl font-bold tracking-tight md:text-5xl">{t.profiles.whoIsListening}</h1>
      <div className="flex flex-wrap justify-center gap-6 md:gap-10">
        {profiles.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => chooseProfile(p.id)}
            className="group flex w-28 flex-col items-center gap-3 md:w-36"
          >
            <span className="rounded-full ring-0 ring-fg transition-all group-hover:ring-4 group-focus-visible:ring-4">
              <Avatar profile={p} size={112} />
            </span>
            <span className="max-w-full truncate text-base font-medium text-fg-2 group-hover:text-fg">{p.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ProfileEditor({ profile, onClose }: { profile: Profile | null; onClose: () => void }) {
  const t = useT();
  const { create, update } = useProfiles();
  const [name, setName] = useState(profile?.name ?? "");
  const [avatar, setAvatar] = useState(profile?.avatar ?? "🎵");
  const [color, setColor] = useState(profile?.color ?? COLORS[1]!);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      if (profile) {
        await update(profile.id, { name, avatar, color });
        toast(t.profiles.saved);
        onClose();
      } else {
        const made = await create({ name, avatar, color });
        chooseProfile(made.id);
      }
    } catch (e) {
      toast(t.profiles.failed((e as Error).message), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={profile ? t.profiles.editTitle : t.profiles.newTitle}>
      <div className="flex flex-col gap-5">
        <div className="flex justify-center">
          <Avatar profile={{ avatar, color, name: name || "?" }} size={96} />
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-fg-3">{t.profiles.name}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            autoFocus
            className="h-11 rounded-xl bg-surface-1 px-3 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-accent"
          />
        </label>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-fg-3">{t.profiles.picture}</span>
          <div className="flex flex-wrap gap-2">
            {EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => setAvatar(e)}
                className={cn("size-10 rounded-full bg-surface-3 text-xl", avatar === e && "ring-2 ring-accent")}
              >
                {e}
              </button>
            ))}
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className={cn(
                "flex h-10 items-center gap-2 rounded-full bg-surface-3 px-4 text-sm font-medium",
                avatar.startsWith("data:") && "ring-2 ring-accent",
              )}
            >
              <ImageIcon size={18} /> {t.profiles.upload}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                try {
                  setAvatar(await photoToAvatar(f));
                } catch (err) {
                  toast((err as Error).message, "error");
                }
              }}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-fg-3">{t.profiles.color}</span>
          <div className="flex gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                onClick={() => setColor(c)}
                className={cn("size-9 rounded-full", color === c && "ring-2 ring-fg ring-offset-2 ring-offset-surface-2")}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-11 rounded-full px-5 text-sm font-medium text-fg-2 hover:text-fg">
            {t.profiles.cancel}
          </button>
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => void submit()}
            className="h-11 rounded-full bg-accent px-6 text-sm font-semibold text-accent-ink disabled:opacity-60"
          >
            {t.profiles.save}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Settings: who is listening, with switch, edit and add. */
export function ProfileSection() {
  const t = useT();
  const state = useProfiles();
  const me = currentProfile(state);
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  if (!state.enabled) return null;

  const row = "flex h-11 items-center gap-2 rounded-full bg-surface-3 px-4 text-sm font-medium hover:bg-surface-4";
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium text-fg-3">{t.profiles.section}</h3>
      {me && (
        <div className="flex items-center gap-3">
          <Avatar profile={me} size={44} />
          <span className="truncate text-base font-semibold">{me.name}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {state.profiles.length > 1 && (
          <button type="button" className={row} onClick={() => chooseProfile(null)}>
            <UsersIcon size={18} /> {t.profiles.switch}
          </button>
        )}
        {me && (
          <button type="button" className={row} onClick={() => setEditing(me)}>
            <PencilSimpleIcon size={18} /> {t.profiles.edit}
          </button>
        )}
        <button type="button" className={row} onClick={() => setEditing("new")}>
          <PlusIcon size={18} /> {t.profiles.add}
        </button>
      </div>
      {editing && <ProfileEditor profile={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}
