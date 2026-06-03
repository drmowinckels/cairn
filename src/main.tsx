import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Self-hosted fonts (#146): vendored woff2 bundled by Vite, no Google
// Fonts CDN request at runtime. Newsreader uses its optical-size axis
// (normal + italic); Geist and Geist Mono are weight-axis variable.
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/newsreader/opsz-italic.css";
import "@fontsource-variable/geist/index.css";
import "@fontsource-variable/geist-mono/index.css";
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
