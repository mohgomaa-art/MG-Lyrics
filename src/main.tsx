import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { applyTheme, getTheme } from "./utils/theme";

// Hash routing: /#lyrics → floating lyrics overlay window.
// The main window imports App statically (no extra request waterfall on cold
// start); the overlay component is only fetched when this is the overlay window.
const isLyricsWindow = window.location.hash === "#lyrics";
const LyricsWindow = React.lazy(() => import("./LyricsWindow"));

// The overlay window keeps fixed dark tokens; only the main window follows the saved theme.
if (!isLyricsWindow) applyTheme(getTheme());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isLyricsWindow ? (
      <Suspense fallback={null}>
        <LyricsWindow />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>
);
