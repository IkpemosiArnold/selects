// "Made for": the one preset on the home brief, where the clips will be posted.
// Keys and lengths match src/core/madefor.mjs (MADE_FOR); the core fills in the
// lengths and the caption style from settings.madeFor, so the UI sends minLen
// and maxLen only when the person sets their own.
export const MADE_FOR = [
  { id: "shorts", label: "Shorts, Reels or TikTok", short: "Shorts, Reels", minLen: 20, maxLen: 60, hint: "Clips of 20 to 60 seconds, with large captions." },
  { id: "linkedin", label: "LinkedIn", short: "LinkedIn", minLen: 30, maxLen: 90, hint: "Clips of 30 to 90 seconds, with subtitle captions and a longer post caption." },
  { id: "x", label: "X", short: "X", minLen: 15, maxLen: 45, hint: "Clips of 15 to 45 seconds, with large captions and a short post." },
  { id: "story", label: "A story", short: "Story", minLen: 60, maxLen: 90, hint: "Clips of 60 to 90 seconds that tell a whole story, with a setup, a turn and an end." },
];

export const madeForById = (id) => MADE_FOR.find((m) => m.id === id) || null;
