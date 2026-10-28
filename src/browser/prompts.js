// The prompt files every runtime reads (src/core/prompts), bundled as text by Vite. The
// judge's answer cache and the judgment signature hash them, so a prompt change is a new
// judgment.
import judgeMd from "../core/prompts/judge.md?raw";
import listwiseMd from "../core/prompts/listwise.md?raw";
import kitMd from "../core/prompts/kit.md?raw";
import faithfulMd from "../core/prompts/faithful.md?raw";
import pairwiseMd from "../core/prompts/pairwise.md?raw";

export const PROMPTS = { judge: judgeMd, listwise: listwiseMd, kit: kitMd, faithful: faithfulMd, pairwise: pairwiseMd };
