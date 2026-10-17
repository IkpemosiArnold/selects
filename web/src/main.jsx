import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/features.css";
import "./styles/reel.css";
import App from "./App.jsx";
import { api } from "./lib/api.js";

// The hosted build installs as an app and keeps its shell offline (src/browser/public/sw.js).
if (api.browser && api.registerApp && !import.meta.env.DEV) api.registerApp("/sw.js").catch?.(() => {});

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
