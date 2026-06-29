export function ConnectionPill({ live }: { live: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 font-mono text-xs font-semibold uppercase tracking-[0.08em] ${
        live
          ? "border-ok/40 bg-ok/10 text-ok"
          : "border-idle/40 bg-idle/10 text-idle"
      }`}
    >
      <span className="relative h-2 w-2 rounded-full bg-current">
        {live && (
          <span className="absolute -inset-1 animate-[ping-ring_1.8s_ease-out_infinite] rounded-full bg-current opacity-50" />
        )}
      </span>
      {live ? "Live" : "Reconnecting…"}
    </span>
  );
}
