import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import LyricsWindow from "./LyricsWindow";

// Hash routing: /#lyrics → floating lyrics overlay window
const isLyricsWindow = window.location.hash === "#lyrics";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isLyricsWindow ? <LyricsWindow /> : <App />}
  </React.StrictMode>
);
