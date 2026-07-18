import { Popover } from "./views/popover";
import { IdleWindow } from "./views/idle/idle-window";
import { AboutWindow } from "./views/about/about-window";
import { NotificationWindow } from "./views/notify/notification-window";
import { ErrorBoundary } from "./error-boundary";

/** Which window this webview is — secondary windows load `index.html?win=…`. */
function windowKind(): "idle" | "about" | "notify" | "popover" {
  try {
    const win = new URLSearchParams(window.location.search).get("win");
    if (win === "idle") return "idle";
    if (win === "about") return "about";
    if (win === "notify") return "notify";
    return "popover";
  } catch {
    return "popover";
  }
}

function App() {
  switch (windowKind()) {
    case "idle":
      return (
        <ErrorBoundary area="Idle prompt">
          <IdleWindow />
        </ErrorBoundary>
      );
    case "about":
      return (
        <ErrorBoundary area="About">
          <AboutWindow />
        </ErrorBoundary>
      );
    case "notify":
      return (
        <ErrorBoundary area="Suggestion notification">
          <NotificationWindow />
        </ErrorBoundary>
      );
    default:
      return (
        <ErrorBoundary area="Popover">
          <Popover />
        </ErrorBoundary>
      );
  }
}

export default App;
