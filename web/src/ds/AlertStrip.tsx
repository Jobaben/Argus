export function AlertStrip({
  subject,
  message,
  when,
}: {
  subject: string;
  message: string;
  when?: string;
}) {
  return (
    <div
      role="status"
      className="flex w-full items-center gap-3.5 rounded-panel border border-fail/45 bg-gradient-to-r from-fail/20 to-fail/[0.06] px-5 py-3.5 shadow-[0_0_0_1px_rgb(255_87_101/0.12),0_8px_30px_rgb(255_87_101/0.10)]"
    >
      <span className="animate-[pulse_2.2s_ease-in-out_infinite] rounded-md border border-fail/50 bg-fail/20 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-fail">
        Failed
      </span>
      <span className="text-[17px] font-semibold">
        <b className="text-ink">{subject}</b>{" "}
        <span className="font-medium text-ink-dim">{message}</span>
      </span>
      {when && <span className="ml-auto font-mono text-[13px] text-ink-dim">{when}</span>}
    </div>
  );
}
