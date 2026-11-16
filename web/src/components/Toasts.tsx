import { CheckCircleIcon, DownloadSimpleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useT } from "../i18n";
import { useSave } from "../lib/save";
import { useUi } from "../stores/ui";

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  const t = useT();
  // A primitive "done/total" string, so the pill only re-renders when the count changes.
  const counts = useSave((s) => {
    if (!s.batch.length) return "";
    const batch = s.jobs.filter((j) => s.batch.includes(j.key));
    const left = batch.filter((j) => j.status === "queued" || j.status === "saving").length;
    return left ? `${batch.length - left}/${batch.length}` : "";
  });
  const progress = counts ? { done: Number(counts.split("/")[0]), total: Number(counts.split("/")[1]) } : null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(140px+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-4 md:bottom-28"
    >
      <AnimatePresence initial={false}>
        {progress && (
          <motion.div
            key="save-progress"
            layout
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex items-center gap-2 rounded-full border border-line-strong bg-surface-2 px-3 py-1.5 text-[13px] text-fg-2 shadow-[0_8px_30px_rgb(0_0_0/0.3)]"
          >
            <DownloadSimpleIcon size={16} className="animate-pulse text-accent-text" />
            {t.save.progress(progress.done, progress.total)}
          </motion.div>
        )}
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 500, damping: 40 }}
            className="pointer-events-auto flex max-w-md items-center gap-2.5 rounded-full border border-line-strong bg-surface-3 py-1.5 pr-1.5 pl-3 text-sm shadow-[0_8px_30px_rgb(0_0_0/0.35)]"
          >
            <button type="button" onClick={() => dismiss(toast.id)} className="flex min-w-0 items-center gap-2.5 py-1 text-left" aria-label={t.toasts.dismiss(toast.message)}>
              {toast.tone === "error" ? (
                <WarningCircleIcon size={18} weight="fill" className="shrink-0 text-danger" />
              ) : (
                <CheckCircleIcon size={18} weight="fill" className="shrink-0 text-accent-text" />
              )}
              <span className="line-clamp-2">{toast.message}</span>
            </button>
            {toast.action ? (
              <button
                type="button"
                onClick={() => {
                  toast.action!.run();
                  dismiss(toast.id);
                }}
                className="h-8 shrink-0 rounded-full bg-accent px-3.5 text-[13px] font-semibold text-accent-ink transition-transform active:scale-95"
              >
                {toast.action.label}
              </button>
            ) : (
              <span className="w-1.5" />
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
