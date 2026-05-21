import { useCaptureJob } from '../capture/useCaptureJob';
import { CaptureForm } from '../capture/CaptureForm';
import { CaptureProgress } from '../capture/CaptureProgress';
import { CaptureResult } from '../capture/CaptureResult';
import type { CaptureJob } from '../api/types';

export default function Capture() {
  const { job, start, cancel, dismiss } = useCaptureJob();

  const isRunning = job?.phase === 'capturing' || job?.phase === 'parsing';
  const isTerminal = job?.phase === 'done' || job?.phase === 'failed' || job?.phase === 'cancelled';

  function handleResume(finished: CaptureJob) {
    start.mutate({
      code: finished.code,
      date: finished.date,
      allow_partial: finished.options.allow_partial,
      resume: true,
      capture_only: finished.options.capture_only,
    });
  }

  return (
    <div className="p-6 grid grid-cols-[320px_1fr] gap-3 h-full min-h-0">
      <CaptureForm
        disabled={isRunning}
        onStart={(args) => start.mutate(args)}
      />
      <div className="min-h-0">
        {!job && (
          <div className="text-[12px] text-fg-dim p-4">
            Fill in a Code and Date, then Start Capture.
          </div>
        )}
        {isRunning && <CaptureProgress job={job!} onCancel={() => cancel.mutate()} />}
        {isTerminal && <CaptureResult job={job!} onDismiss={() => dismiss.mutate()} onResume={handleResume} />}
      </div>
    </div>
  );
}
