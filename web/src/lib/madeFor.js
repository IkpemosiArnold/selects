// "Made for": the one preset on the home brief. It sets the clip lengths for
// where the clips will be posted. Sent as settings.madeFor, with minLen and
// maxLen spelled out, so a server that does not know madeFor still gets the
// right lengths. (Field name pending in notes/CONTRACTS.md.)
export const MADE_FOR = [
  { id: "shorts", label: "Shorts and Reels", short: "Shorts, Reels", minLen: 20, maxLen: 60 },
  { id: "linkedin", label: "LinkedIn", short: "LinkedIn", minLen: 30, maxLen: 90 },
  { id: "x", label: "X", short: "X", minLen: 15, maxLen: 45 },
  { id: "story", label: "Stories", short: "Story", minLen: 60, maxLen: 90 },
];

export const madeForById = (id) => MADE_FOR.find((m) => m.id === id) || null;
