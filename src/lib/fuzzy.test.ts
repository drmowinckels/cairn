import { describe, expect, it } from "vitest";
import { rank, scoreFuzzy } from "./fuzzy";

describe("scoreFuzzy", () => {
  it("returns 0 for an empty query (matches everything)", () => {
    expect(scoreFuzzy("", "anything")).toBe(0);
    expect(scoreFuzzy("", "")).toBe(0);
  });

  it("returns null when no subsequence match exists", () => {
    expect(scoreFuzzy("xyz", "stop running timer")).toBeNull();
    expect(scoreFuzzy("abc", "")).toBeNull();
  });

  it("matches a contiguous substring", () => {
    expect(scoreFuzzy("stop", "stop")).not.toBeNull();
  });

  it("matches a non-contiguous subsequence", () => {
    // q "srt" appears as s_t_o_p subsequence? no — try 'srt' in 'start timer'
    expect(scoreFuzzy("srt", "start timer")).not.toBeNull();
  });

  it("is case-insensitive", () => {
    const a = scoreFuzzy("STOP", "Stop running timer");
    const b = scoreFuzzy("stop", "Stop running timer");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).toBe(b);
  });

  it("rewards start-of-word matches over mid-word ones", () => {
    // "sp" at "S(top) (P)roject" vs mid-word match in "displa-something"
    const startOfWord = scoreFuzzy("sp", "stop project");
    const midWord = scoreFuzzy("sp", "display open");
    expect(startOfWord).not.toBeNull();
    expect(midWord).not.toBeNull();
    expect(startOfWord! > midWord!).toBe(true);
  });

  it("rewards adjacent matches over scattered ones", () => {
    const adjacent = scoreFuzzy("st", "stop");
    const scattered = scoreFuzzy("st", "settings");
    expect(adjacent).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(adjacent! > scattered!).toBe(true);
  });

  it("treats dash/underscore/slash/dot/colon as separators for start-of-word", () => {
    const sep = scoreFuzzy("o", "open-rule");
    const noSep = scoreFuzzy("o", "color");
    expect(sep).not.toBeNull();
    expect(noSep).not.toBeNull();
    expect(sep! > noSep!).toBe(true);
  });

  it("favours shorter candidates as a tiebreaker", () => {
    const short = scoreFuzzy("stop", "stop");
    const long = scoreFuzzy(
      "stop",
      "stop the running timer immediately and confirm",
    );
    expect(short).not.toBeNull();
    expect(long).not.toBeNull();
    expect(short! > long!).toBe(true);
  });
});

describe("rank", () => {
  const ITEMS = [
    "Stop running timer",
    "Start timer for Cairn",
    "Start timer for ACME",
    "Switch view: Today",
    "Switch view: Reports",
    "Open settings: Privacy",
    "Open settings: Accessibility",
    "Open settings: Calendar",
    "Toggle rule: Cairn dev work",
    "Open log file",
  ];

  it("returns all items unchanged when the query is empty", () => {
    const out = rank("", ITEMS, (s) => s);
    expect(out).toEqual(ITEMS);
  });

  it("returns all items unchanged when the query is whitespace-only", () => {
    const out = rank("   ", ITEMS, (s) => s);
    expect(out).toEqual(ITEMS);
  });

  it("returns an empty array when no candidate matches", () => {
    const out = rank("zzz", ITEMS, (s) => s);
    expect(out).toEqual([]);
  });

  it("ranks exact start-of-word matches first", () => {
    const out = rank("stop", ITEMS, (s) => s);
    expect(out[0]).toBe("Stop running timer");
  });

  it("ranks 'start' so timer-start items beat 'settings'", () => {
    const out = rank("start", ITEMS, (s) => s);
    expect(out[0]?.startsWith("Start ")).toBe(true);
  });

  it("breaks ties by candidate length (shorter wins)", () => {
    const items = ["foo bar baz qux", "foo"];
    const out = rank("foo", items, (s) => s);
    expect(out[0]).toBe("foo");
  });

  it("returns a copy — does not mutate the input array", () => {
    const items = ["c", "a", "b"];
    const before = items.slice();
    rank("", items, (s) => s);
    expect(items).toEqual(before);
  });

  it("uses keyOf so the items can be objects", () => {
    const items = [{ label: "Stop timer" }, { label: "Start timer" }];
    const out = rank("stop", items, (o) => o.label);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("Stop timer");
  });

  it("subsequence match (non-contiguous query) is accepted", () => {
    const out = rank("srt", ITEMS, (s) => s);
    // 'Start timer for …' has s,t,a,r,t — 'srt' matches s(t)art → s,r,t
    expect(out.some((s) => s.startsWith("Start "))).toBe(true);
  });

  it("preserves original order on equal score (stable sort)", () => {
    const items = ["aa", "ab", "ac"];
    const out = rank("a", items, (s) => s);
    // All score the same; tiebreak then by length (equal), then index.
    expect(out).toEqual(items);
  });
});
