import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./brand.css";

// Tag the document with which window this is so the CSS can pick an opaque
// fill for the decorated main window vs. a transparent one for the frameless
// idle / about popups. WKWebView renders a transparent root as blank on a
// non-transparent (decorated) macOS window, so the main window must be opaque.
try {
  const win = new URLSearchParams(window.location.search).get("win");
  document.documentElement.dataset.win =
    win === "idle" ? "idle" : win === "about" ? "about" : "popover";
} catch {
  document.documentElement.dataset.win = "popover";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
