import { ArrowsClockwiseIcon, ClockCounterClockwiseIcon, HeartIcon, MagnifyingGlassIcon, PlayIcon, SunHorizonIcon } from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { Artwork } from "../components/Artwork";
import { LogoMark } from "../components/Brand";
import { PageHeader, Section } from "../components/Page";
import { TrackList, TrackListSkeleton } from "../components/TrackList";
import { useT } from "../i18n";
import { capabilities } from "../lib/api";
import { DAYLIST_ID, refreshDaylist, syncDaylist } from "../lib/daylist";
import { paths } from "../lib/routes";
import type { Track } from "../lib/types";
import { usePlayer } from "../player/player";
import { useAppearance } from "../stores/appearance";
import { useLibrary } from "../stores/library";

function Shortcut({ to, label, tracks, cover }: { to: string; label: string; tracks: Track[]; cover: ReactNode }) {
  const playList = usePlayer((s) => s.playList);
  const t = useT();
  return (
    <div className="group relative flex h-14 items-center gap-3 overflow-hidden rounded-[12px] bg-surface-2 pr-2 transition-colors hover:bg-surface-3 md:h-16">
      <Link to={to} className="absolute inset-0" aria-label={label} />
      <span className="pointer-events-none size-14 shrink-0 overflow-hidden md:size-16">{cover}</span>
      <span className="pointer-events-none min-w-0 flex-1 truncate text-[13px] font-semibold md:text-sm">{label}</span>
      {tracks.length > 0 && (
        <button
          type="button"
          onClick={() => playList(tracks, 0)}
          aria-label={t.common.playX(label)}
          className="relative z-10 hidden size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-ink opacity-0 shadow-[0_6px_18px_rgb(0_0_0/0.35)] transition-[opacity,transform] duration-200 ease-out-expo group-hover:opacity-100 hover:scale-105 active:scale-95 md:grid"
        >
          <PlayIcon size={18} weight="fill" />
        </button>
      )}
    </div>
  );
}

function RecentCard({ track, onPlay }: { track: Track; onPlay: () => void }) {
  return (
    <button type="button" onClick={onPlay} className="group flex w-36 shrink-0 snap-start flex-col gap-2 text-left md:w-44">
      <span className="relative block">
        <Artwork src={track.art} fallback={track.thumb} className="aspect-square w-full rounded-[14px]" />
        <span className="absolute right-2 bottom-2 grid size-11 translate-y-1 place-items-center rounded-full bg-accent text-accent-ink opacity-0 shadow-[0_8px_20px_rgb(0_0_0/0.4)] transition-[opacity,transform] duration-200 ease-out-expo group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:opacity-100">
          <PlayIcon size={20} weight="fill" />
        </span>
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{track.title}</span>
        <span className="block truncate text-xs text-fg-2">{track.artist}</span>
      </span>
    </button>
  );
}

/** The time-of-day playlist: changes every morning, afternoon, evening and night. */
function DaylistCard() {
  const daylist = useLibrary((s) => s.playlists.find((p) => p.id === DAYLIST_ID));
  const load = useLibrary((s) => s.load);
  const playList = usePlayer((s) => s.playList);
  const [busy, setBusy] = useState(false);
  const t = useT();

  // The server rebuilds it when the time of day changes; pick up a newer one than the library we loaded.
  useEffect(() => {
    if (!capabilities.engineSettings) return;
    void syncDaylist().then((d) => {
      if (d && d.name !== useLibrary.getState().playlists.find((p) => p.id === DAYLIST_ID)?.name) void load();
    });
  }, [load]);

  if (!daylist?.tracks.length) return null;
  const [, title = daylist.name] = daylist.name.split(" · ");
  const covers = daylist.tracks.slice(0, 4);

  return (
    <div className="mx-4 mb-6 flex items-center gap-4 overflow-hidden rounded-[20px] bg-linear-to-br from-accent-soft to-surface-2 p-4 ring-1 ring-line md:mx-6 md:p-5">
      <Link to={paths.playlist(DAYLIST_ID)} className="grid size-20 shrink-0 grid-cols-2 overflow-hidden rounded-[14px] md:size-24">
        {covers.map((c) => (
          <Artwork key={c.id} src={c.thumb} className="size-full" />
        ))}
      </Link>
      <Link to={paths.playlist(DAYLIST_ID)} className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-xs font-medium text-accent-text">
          <SunHorizonIcon size={14} weight="bold" /> {t.daylist.label}
        </span>
        <span className="mt-0.5 block text-lg leading-tight font-semibold tracking-tight md:text-xl">{title}</span>
        <span className="mt-0.5 block text-[13px] text-fg-2">{t.daylist.count(daylist.tracks.length)}</span>
      </Link>
      <button
        type="button"
        disabled={busy}
        aria-label={t.daylist.refresh}
        title={t.daylist.refresh}
        onClick={async () => {
          setBusy(true);
          await refreshDaylist();
          await load();
          setBusy(false);
        }}
        className="grid size-11 shrink-0 place-items-center rounded-full bg-surface-3 hover:bg-surface-4 disabled:opacity-50"
      >
        <ArrowsClockwiseIcon size={18} className={busy ? "animate-spin" : ""} />
      </button>
      <button
        type="button"
        onClick={() => playList(daylist.tracks, 0)}
        aria-label={t.common.playX(title)}
        className="grid size-12 shrink-0 place-items-center rounded-full bg-accent text-accent-ink shadow-[0_6px_18px_rgb(0_0_0/0.3)] active:scale-95"
      >
        <PlayIcon size={20} weight="fill" />
      </button>
    </div>
  );
}

/** "Made for you": the server's daily mixes (server/src/mixes.ts), ordinary playlists with ids "mix-…". */
function MixCard({ id, name, tracks }: { id: string; name: string; tracks: Track[] }) {
  const playList = usePlayer((s) => s.playList);
  const t = useT();
  const because = name.startsWith("Because you listen to ");
  return (
    <div className="group w-40 shrink-0 snap-start md:w-44">
      <div className="relative">
        <Link to={paths.playlist(id)} className="grid aspect-square w-full grid-cols-2 overflow-hidden rounded-[14px] ring-1 ring-line">
          {tracks.slice(0, 4).map((c) => (
            <Artwork key={c.id} src={c.thumb} className="size-full" />
          ))}
        </Link>
        <button
          type="button"
          onClick={() => playList(tracks, 0)}
          aria-label={t.common.playX(name)}
          className="absolute right-2 bottom-2 grid size-11 place-items-center rounded-full bg-accent text-accent-ink shadow-[0_6px_18px_rgb(0_0_0/0.35)] transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
        >
          <PlayIcon size={18} weight="fill" />
        </button>
      </div>
      <Link to={paths.playlist(id)} className="block">
        <span className="mt-2 block text-xs font-medium text-fg-3">{because ? t.mixes.because : t.mixes.radio}</span>
        <span className="line-clamp-2 text-sm leading-snug font-semibold">
          {because ? name.slice("Because you listen to ".length) : name}
        </span>
      </Link>
    </div>
  );
}

function MadeForYou() {
  // Select the stable array and filter here: a selector returning a new array each time loops forever in zustand 5.
  const playlists = useLibrary((s) => s.playlists);
  const mixes = playlists.filter((p) => p.id.startsWith("mix-") && p.tracks.length);
  const load = useLibrary((s) => s.load);
  const t = useT();

  // Ask the server to build today's mixes; on the first day it takes a minute, so look again after that.
  useEffect(() => {
    if (!capabilities.engineSettings) return;
    void fetch("/api/mixes").catch(() => {});
    const timer = setTimeout(() => void load(), 60_000);
    return () => clearTimeout(timer);
  }, [load]);

  if (!mixes.length) return null;
  const ordered = [...mixes].sort((a, b) => a.id.localeCompare(b.id));
  return (
    <Section title={t.mixes.title}>
      <div className="no-scrollbar flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 md:scroll-px-6 md:px-6">
        {ordered.map((p) => (
          <MixCard key={p.id} id={p.id} name={p.name} tracks={p.tracks} />
        ))}
      </div>
    </Section>
  );
}

export default function Home() {
  const { favorites, playlists, history, status } = useLibrary();
  const playList = usePlayer((s) => s.playList);
  const navigate = useNavigate();
  const t = useT();
  const show = useAppearance();
  const empty = status === "ready" && !favorites.length && !playlists.length && !history.length;

  return (
    <div className="pb-8">
      <PageHeader />

      <div className="px-4 pt-2 pb-6 md:px-6 md:pt-8">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight md:text-4xl">{t.time.greeting(new Date().getHours())}</h1>
      </div>

      <DaylistCard />

      {status === "loading" && <TrackListSkeleton rows={6} />}

      {empty && (
        <div className="mx-4 flex flex-col items-start gap-5 rounded-[20px] bg-surface-2 p-6 ring-1 ring-line md:mx-6 md:flex-row md:items-center md:p-8">
          <span className="grid size-16 shrink-0 place-items-center rounded-[18px] bg-accent text-accent-ink">
            <LogoMark className="size-10" />
          </span>
          <div className="flex-1">
            <p className="text-xl font-semibold tracking-tight">{t.home.startTitle}</p>
            <p className="mt-1 max-w-[52ch] text-sm text-fg-2">{t.home.startBody}</p>
          </div>
          <button
            type="button"
            onClick={() => navigate(paths.search)}
            className="flex h-12 items-center gap-2 rounded-full bg-accent pr-6 pl-5 font-semibold text-accent-ink transition-transform active:scale-[0.97]"
          >
            <MagnifyingGlassIcon size={20} weight="bold" /> {t.common.searchMusic}
          </button>
        </div>
      )}

      {!empty && status === "ready" && (
        <div className="flex flex-col gap-10">
          {show.homeShortcuts && <div className="grid grid-cols-2 gap-2 px-4 md:px-6 lg:grid-cols-3 2xl:grid-cols-4">
            <Shortcut
              to={paths.favorites}
              label={t.nav.favorites}
              tracks={favorites}
              cover={
                <span className="grid size-full place-items-center bg-accent-soft text-accent-text">
                  <HeartIcon size={24} weight="fill" />
                </span>
              }
            />
            <Shortcut
              to={paths.history}
              label={t.nav.recentlyPlayed}
              tracks={history}
              cover={
                <span className="grid size-full place-items-center bg-surface-3 text-fg-2">
                  <ClockCounterClockwiseIcon size={24} />
                </span>
              }
            />
            {playlists.filter((p) => p.id !== DAYLIST_ID && !p.id.startsWith("mix-")).slice(0, 6).map((p) => (
              <Shortcut
                key={p.id}
                to={paths.playlist(p.id)}
                label={p.name}
                tracks={p.tracks}
                cover={<Artwork src={p.tracks[0]?.thumb} className="size-full" />}
              />
            ))}
          </div>}

          <MadeForYou />

          {show.homeRecent && history.length > 0 && (
            <Section
              title={t.nav.recentlyPlayed}
              action={
                <Link to={paths.history} className="text-sm font-medium text-fg-2 hover:text-fg">
                  {t.home.seeAll}
                </Link>
              }
            >
              <div className="no-scrollbar flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 md:scroll-px-6 md:px-6">
                {history.slice(0, 16).map((t, i) => (
                  <RecentCard key={t.id} track={t} onPlay={() => playList(history, i)} />
                ))}
              </div>
            </Section>
          )}

          {show.homeFavorites && favorites.length > 0 && (
            <Section
              title={t.home.yourFavorites}
              action={
                <Link to={paths.favorites} className="text-sm font-medium text-fg-2 hover:text-fg">
                  {t.home.seeAll}
                </Link>
              }
            >
              <div className="px-2 md:px-3">
                <TrackList tracks={favorites.slice(0, 5)} context={favorites} header={false} showAlbum={false} />
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
