import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/features.css";
import App from "./App.jsx";

const root = createRoot(document.getElementById("root"));
// Design directions (web/src/directions) load only when asked for, so the app
// itself is unchanged: ?direction=lined-script, reel or contact-sheet.
const direction = new URLSearchParams(location.search).get("direction");
if (direction) {
  import("./directions/index.jsx").then(({ default: Directions }) =>
    root.render(
      <StrictMode>
        <Directions name={direction} />
      </StrictMode>
    )
  );
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
