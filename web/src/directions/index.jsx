// Design directions for Selects, reachable as ?direction=lined-script,
// ?direction=reel or ?direction=contact-sheet. They sit beside the current
// app and share its data and fonts; nothing here replaces it.
import { useEffect } from "react";
import "./shared/base.css";
import LinedScript from "./lined-script/LinedScript.jsx";
import Reel from "./reel/Reel.jsx";
import ContactSheet from "./contact-sheet/ContactSheet.jsx";
import { params } from "./shared/data.js";

export const DIRECTIONS = [
  ["lined-script", "Lined script", LinedScript],
  ["reel", "Reel", Reel],
  ["contact-sheet", "Contact sheet", ContactSheet],
];

function Switcher({ current }) {
  if (params.get("bar") === "0") return null;
  const href = (name) => {
    const p = new URLSearchParams(location.search);
    if (name) p.set("direction", name);
    else p.delete("direction");
    return "?" + p.toString() + location.hash;
  };
  return (
    <nav className="dx-switch" aria-label="Design directions">
      {DIRECTIONS.map(([name, label]) => (
        <a key={name} href={href(name)} aria-current={name === current ? "page" : undefined}>
          {label}
        </a>
      ))}
      <a href={href(null)}>Current app</a>
    </nav>
  );
}

export default function Directions({ name }) {
  const found = DIRECTIONS.find(([n]) => n === name) || DIRECTIONS[0];
  const [key, label, View] = found;
  useEffect(() => {
    const theme = params.get("theme");
    if (theme === "dark" || theme === "light") document.documentElement.setAttribute("data-theme", theme);
    document.body.dataset.direction = key;
    document.title = `Selects, ${label.toLowerCase()} direction`;
  }, [key, label]);
  return (
    <>
      <View />
      <Switcher current={key} />
    </>
  );
}
