import { describe, expect, it } from "vitest";
import { findMatches } from "./find-matches";

const found = (text: string, query: string) =>
  findMatches(text, query).map(([start, end]) => text.slice(start, end));

describe("findMatches", () => {
  it("finds nothing for an empty or blank search", () => {
    expect(findMatches("bias probe", "")).toEqual([]);
    expect(findMatches("bias probe", "   ")).toEqual([]);
  });

  it("finds every match whatever its case, trimming the search like the list", () => {
    const text = "Bias probe, then the BIAS PROBE again";
    expect(findMatches(text, "  bias probe ")).toEqual([
      [0, 10],
      [21, 31],
    ]);
    expect(found(text, "bias PROBE")).toEqual(["Bias probe", "BIAS PROBE"]);
  });

  it("doesn't count overlapping matches twice", () => {
    expect(findMatches("aaaa", "aa")).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it("finds nothing across two lines", () => {
    expect(findMatches("bias\nprobe", "bias probe")).toEqual([]);
    expect(findMatches("bias\nprobe", "s\np")).toEqual([]);
  });

  it("points into the text as written when lower case changes its length", () => {
    // "İ" becomes two characters in lower case.
    const text = "İstanbul bias, İzmir bias";
    expect(found(text, "bias")).toEqual(["bias", "bias"]);
    expect(found(text, "izmir")).toEqual([]);
    expect(found(text, "i̇zmir")).toEqual(["İzmir"]);
  });
});
