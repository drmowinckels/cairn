import { Popover } from "./views/popover";
import { IdleWindow } from "./views/idle/idle-window";
import { ErrorBoundary } from "./error-boundary";

/** The idle prompt window loads `index.html?win=idle` (#93). */
function isIdleWindow(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("win") === "idle";
  } catch {
    return false;
  }
}

function App() {
  if (isIdleWindow()) {
    return (
      <ErrorBoundary area="Idle prompt">
        <IdleWindow />
      </ErrorBoundary>
    );
  }
  return (
    <ErrorBoundary area="Popover">
      <Popover />
    </ErrorBoundary>
  );
}

export default App;
