import type { SignalCaptureStatus } from "./ipc";

interface CaptureBannerProps {
  status: SignalCaptureStatus;
  onStop: () => void;
}

/**
 * Persistent footer banner shown while the debug "Capture raw signals"
 * mode is on. Lives just above `pop-foot` so the existing footer copy
 * (today's total, active rules) stays untouched; renders nothing when
 * capture is inactive.
 *
 * Per `docs/PRIVACY.md` §"Debug Capture raw signals", this banner is
 * the user's only standing reminder that raw signals are being written
 * to disk — keep it loud and the `stop` action one click away.
 */
export function CaptureBanner({ status, onStop }: CaptureBannerProps) {
  if (!status.active) return null;
  return (
    <div
      className="capture-banner"
      role="status"
      aria-live="polite"
      data-testid="capture-banner"
    >
      <span className="capture-dot" aria-hidden="true" />
      <span className="capture-text">Capturing raw signals</span>
      <span className="capture-sep" aria-hidden="true">
        ·
      </span>
      <button type="button" className="link-btn capture-stop" onClick={onStop}>
        stop
      </button>
    </div>
  );
}
