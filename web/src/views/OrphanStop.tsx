import { useState } from "react";
import { Button } from "../ds";
import { useConfirm } from "../ds/useConfirm";

/**
 * Stop for one live instance of a pipeline that has since been deleted: the
 * only action left on it. It asks first, in place, because the instance's
 * in-progress work is discarded, and a refused stop is said beside the button
 * of the instance it was about.
 */
export function OrphanStop({
  pipelineName,
  instanceId,
  onAbort,
}: {
  pipelineName: string;
  instanceId: string;
  onAbort: (instanceId: string) => Promise<unknown>;
}) {
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const stop = () => {
    setError(null);
    onAbort(instanceId).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Button
        variant="danger"
        size="sm"
        icon="stop"
        aria-expanded={confirm.armed === instanceId}
        onClick={confirm.toggle(instanceId)}
      >
        Stop
      </Button>
      {error && <span className="text-caption text-fail-ink">{error}</span>}
      {confirm.armed === instanceId &&
        confirm.question(
          {
            title: `Stop this instance of the deleted pipeline “${pipelineName}”?`,
            detail: "In-progress work will be discarded.",
            confirm: "Stop instance",
            cancel: "Keep running",
            icon: "stop",
          },
          stop,
        )}
    </div>
  );
}
