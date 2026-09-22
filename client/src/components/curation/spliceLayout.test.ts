import type { SpliceExon, SpliceViz } from "@shared/curation/viz";
import { describe, expect, it } from "vitest";
import {
  EXON_MIN_WIDTH,
  buildTrack,
  deriveScale,
  focusWindow,
  junctionHeading,
  ptcCaption,
  ptcCaptionFromMarker,
  ptcInWindow,
  pseudoExonWidth,
  scaleFor,
  skipHeading,
  solveWidths,
} from "./spliceLayout";

/** The AMT c.878-1G>A window from the regression baseline. */
const EXONS: SpliceExon[] = [
  { rank: 6, len_bp: 146, w: 0.2205 },
  { rank: 7, len_bp: 181, w: 0.2734 },
  { rank: 8, len_bp: 156, w: 0.2356 },
  { rank: 9, len_bp: 179, w: 0.2704 },
];

/**
 * Px per coding bp for the tests. The fixture exons are ~150 bp, so 2 px/bp puts every
 * box near 300px -- far enough above `EXON_MIN_WIDTH` that the clamp never fires and the
 * assertions test proportionality rather than the minimum.
 */
const SCALE = 2;

const BASE = {
  exons: EXONS,
  truncBefore: 5,
  truncAfter: 0,
  spliced: false,
  skipRank: null,
  skipAltRank: null,
  anchorRank: null,
  utrRank: null,
  startCodonRank: null,
  fadeAfterRank: null,
  dimNonAnchor: false,
  variantMarker: null,
  ptc: null,
  pseudo: null,
  internalCut: null,
  variantEnd: "acceptor" as const,
};

describe("deriveScale and solveWidths", () => {
  it("picks a scale that makes the cells fill the space", () => {
    const cells = [{ weight: 100 }, { weight: 300 }];
    const widths = solveWidths(cells, deriveScale(cells, 800));
    expect(widths[0] + widths[1]).toBeCloseTo(800, -1);
  });

  it("gives exons width in proportion to coding length", () => {
    const widths = solveWidths([{ weight: 100 }, { weight: 300 }], 2);
    expect(widths).toEqual([200, 600]);
  });

  it("reserves fixed cells before scaling the rest", () => {
    const cells = [{ fixed: 30 }, { weight: 1 }, { fixed: 30 }];
    const widths = solveWidths(cells, deriveScale(cells, 400));
    expect(widths[0]).toBe(30);
    expect(widths[2]).toBe(30);
    expect(widths[1]).toBeCloseTo(340, -1);
  });

  it("never shrinks an exon below the legible minimum", () => {
    // Ten exons cannot fit in 100px; the track is expected to overflow instead.
    const cells = Array.from({ length: 10 }, () => ({ weight: 1 }));
    const widths = solveWidths(cells, deriveScale(cells, 100));
    for (const width of widths) expect(width).toBeGreaterThanOrEqual(EXON_MIN_WIDTH);
  });

  it("falls back to an even split when no length is recorded", () => {
    const cells = [{ weight: 1 }, { weight: 1 }, { weight: 1 }];
    const widths = solveWidths(cells, deriveScale(cells, 600));
    expect(new Set(widths).size).toBe(1);
  });

  it("survives a row with nothing to scale", () => {
    expect(deriveScale([{ fixed: 40 }], 200)).toBe(1);
    expect(deriveScale([], 200)).toBe(1);
  });
});

describe("shared scale across a row", () => {
  /**
   * The load-bearing invariant of the whole map: an exon that survives splicing must
   * keep its width, so the reviewer reads the missing box as a deletion rather than as
   * the row re-flowing.
   */
  it("keeps a surviving exon the same width on both tracks", () => {
    const options = { ...BASE, skipRank: 8 };
    const scale = scaleFor(options, 600);
    const pre = buildTrack("pre-mrna", "Pre-mRNA", options, scale);
    const mrna = buildTrack("mrna", "mRNA", { ...options, spliced: true }, scale);

    const widthByRank = (track: ReturnType<typeof buildTrack>) =>
      new Map(
        track.cells
          .filter(cell => cell.kind === "exon")
          .map(cell => [cell.kind === "exon" ? cell.rank : 0, cell.width])
      );

    const before = widthByRank(pre);
    const after = widthByRank(mrna);
    expect([...after.keys()].sort()).toEqual([6, 7, 9]);
    for (const [rank, width] of after) expect(width).toBe(before.get(rank));
  });

  it("makes the spliced track narrower by exactly what was removed", () => {
    const options = { ...BASE, skipRank: 8 };
    const scale = scaleFor(options, 600);
    const pre = buildTrack("pre-mrna", "Pre-mRNA", options, scale);
    const mrna = buildTrack("mrna", "mRNA", { ...options, spliced: true }, scale);
    const exon8 = pre.cells.find(cell => cell.kind === "exon" && cell.rank === 8);
    const intronWidth = pre.cells
      .filter(cell => cell.kind === "intron")
      .reduce((sum, cell) => sum + cell.width, 0);
    expect(mrna.width).toBe(pre.width - (exon8?.width ?? 0) - intronWidth);
  });

  it("fills the space it was given when nothing hits the minimum", () => {
    const scale = scaleFor(BASE, 600);
    const pre = buildTrack("pre-mrna", "Pre-mRNA", BASE, scale);
    expect(pre.width).toBeCloseTo(600, -1);
  });
});

describe("buildTrack", () => {
  it("keeps introns and the skipped exon on the pre-mRNA track", () => {
    const track = buildTrack("pre-mrna", "Pre-mRNA", { ...BASE, skipRank: 8 }, SCALE
);
    const exons = track.cells.filter(c => c.kind === "exon");
    expect(exons.map(c => (c.kind === "exon" ? c.rank : 0))).toEqual([6, 7, 8, 9]);
    expect(track.cells.filter(c => c.kind === "intron")).toHaveLength(3);
    const skipped = exons.find(c => c.kind === "exon" && c.rank === 8);
    expect(skipped?.kind === "exon" && skipped.state).toBe("skipped");
  });

  it("removes the skipped exon and all introns from the mRNA track", () => {
    const track = buildTrack(
      "mrna",
      "mRNA",
      { ...BASE, spliced: true, skipRank: 8 },
      SCALE
    );
    const ranks = track.cells.filter(c => c.kind === "exon").map(c => (c.kind === "exon" ? c.rank : 0));
    expect(ranks).toEqual([6, 7, 9]);
    expect(track.cells.filter(c => c.kind === "intron")).toHaveLength(0);
  });

  it("renders truncation markers with the hidden exon count", () => {
    const track = buildTrack("pre-mrna", "Pre-mRNA", { ...BASE, truncAfter: 3 }, SCALE
);
    const ellipses = track.cells.filter(c => c.kind === "ellipsis");
    expect(ellipses).toHaveLength(2);
    expect(ellipses.map(c => (c.kind === "ellipsis" ? `${c.side}:${c.count}` : ""))).toEqual([
      "lo:5",
      "hi:3",
    ]);
  });

  it("places the variant diamond in the intron named by the marker", () => {
    const track = buildTrack(
      "pre-mrna",
      "Pre-mRNA",
      {
        ...BASE,
        variantMarker: { mode: "intron", upstream_exon: 7, downstream_exon: 8, exon_rank: null, fraction_in_exon: null },
      },
      SCALE
    );
    const withVariant = track.cells.filter(c => c.kind === "intron" && c.hasVariant);
    expect(withVariant).toHaveLength(1);
    const cell = withVariant[0];
    expect(cell.kind === "intron" && cell.leftRank).toBe(7);
    expect(cell.kind === "intron" && cell.rightRank).toBe(8);
    expect(cell.kind === "intron" && cell.variantEnd).toBe("acceptor");
  });

  it("puts the Ter tick only on the spliced product, at the engine's fraction", () => {
    const options = {
      ...BASE,
      ptc: { exon_rank: 8, fraction_in_exon: 0.3718, hgvs_p: "p.Gly293fsTer20", ptc_aa_position: 312 },
    };
    const pre = buildTrack("pre-mrna", "Pre-mRNA", options, SCALE
);
    expect(pre.cells.some(c => c.kind === "exon" && c.ptc)).toBe(false);

    const mrna = buildTrack("mrna", "mRNA", { ...options, spliced: true }, SCALE
);
    const exon8 = mrna.cells.find(c => c.kind === "exon" && c.rank === 8);
    expect(exon8?.kind === "exon" && exon8.ptc?.fraction).toBeCloseTo(0.3718, 4);
    expect(exon8?.kind === "exon" && exon8.ptc?.label).toBe("p.Gly293fsTer20");
  });

  it("clamps tick fractions away from the box edges", () => {
    const mrna = buildTrack(
      "mrna",
      "mRNA",
      { ...BASE, spliced: true, ptc: { exon_rank: 8, fraction_in_exon: 0, hgvs_p: null, ptc_aa_position: null } },
      SCALE
    );
    const exon8 = mrna.cells.find(c => c.kind === "exon" && c.rank === 8);
    expect(exon8?.kind === "exon" && exon8.ptc?.fraction).toBe(0.03);
  });

  it("inserts the pseudo-exon after its anchor on the spliced product only", () => {
    const pseudo = {
      afterRank: 7,
      nt: 120,
      accent: "green" as const,
      fiveLabel: "GT(+1)",
      threeLabel: "AG(+44)",
      isUtr: false,
      ptcFraction: 0.4,
      ptcLabel: "p.Ter",
    };
    const pre = buildTrack("pre-mrna", "Pre-mRNA", { ...BASE, pseudo }, SCALE
);
    expect(pre.cells.some(c => c.kind === "pseudoExon")).toBe(false);

    const mrna = buildTrack("mrna", "mRNA", { ...BASE, spliced: true, pseudo }, SCALE
);
    const index = mrna.cells.findIndex(c => c.kind === "pseudoExon");
    expect(index).toBeGreaterThan(-1);
    const before = mrna.cells[index - 1];
    expect(before.kind === "exon" && before.rank).toBe(7);
    const cell = mrna.cells[index];
    expect(cell.kind === "pseudoExon" && cell.nt).toBe(120);
    expect(cell.kind === "pseudoExon" && cell.ptc?.label).toBe("p.Ter");
  });

  it("carries the exon-internal cryptic cut onto the exon it splits", () => {
    const track = buildTrack(
      "mrna",
      "mRNA",
      {
        ...BASE,
        spliced: true,
        internalCut: { rank: 8, fraction: 0.62, side: "donor" },
      },
      SCALE
    );
    const exon8 = track.cells.find(c => c.kind === "exon" && c.rank === 8);
    expect(exon8?.kind === "exon" && exon8.internalCut).toEqual({
      fraction: 0.62,
      side: "donor",
      shadeExcised: true,
    });
    const others = track.cells.filter(c => c.kind === "exon" && c.rank !== 8);
    expect(others.every(c => c.kind === "exon" && c.internalCut === null)).toBe(true);
  });

  it("marks the excised half for shading only on the spliced product", () => {
    const options = { ...BASE, internalCut: { rank: 8, fraction: 0.62, side: "donor" as const } };
    const pre = buildTrack("pre-mrna", "Pre-mRNA", options, SCALE);
    const mrna = buildTrack("mrna", "mRNA", { ...options, spliced: true }, SCALE);
    const preCut = pre.cells.find(c => c.kind === "exon" && c.rank === 8);
    const mrnaCut = mrna.cells.find(c => c.kind === "exon" && c.rank === 8);
    expect(preCut?.kind === "exon" && preCut.internalCut?.shadeExcised).toBe(false);
    expect(mrnaCut?.kind === "exon" && mrnaCut.internalCut?.shadeExcised).toBe(true);
  });

  it("lays cells out left to right with no gaps or overlap", () => {
    const track = buildTrack("pre-mrna", "Pre-mRNA", { ...BASE, truncAfter: 2 }, SCALE);
    let expected = 0;
    for (const cell of track.cells) {
      expect(cell.x).toBe(expected);
      expected += cell.width;
    }
    expect(track.width).toBe(expected);
  });

  it("marks UTR and start-codon exons distinctly from a plain exon", () => {
    const track = buildTrack(
      "pre-mrna",
      "Pre-mRNA",
      { ...BASE, utrRank: 6, startCodonRank: 7 },
      SCALE
    );
    const utr = track.cells.find(c => c.kind === "exon" && c.rank === 6);
    const met = track.cells.find(c => c.kind === "exon" && c.rank === 7);
    expect(utr?.kind === "exon" && utr.state).toBe("utr");
    expect(met?.kind === "exon" && met.startCodon).toBe(true);
  });

  it("fades exons downstream of a resolved stop", () => {
    const track = buildTrack("mrna", "mRNA", { ...BASE, spliced: true, fadeAfterRank: 7 }, SCALE
);
    const states = track.cells
      .filter(c => c.kind === "exon")
      .map(c => (c.kind === "exon" ? [c.rank, c.state] : []));
    expect(states).toEqual([
      [6, "normal"],
      [7, "normal"],
      [8, "faded"],
      [9, "faded"],
    ]);
  });
});

describe("pseudoExonWidth", () => {
  it("scales with retained length inside legible bounds", () => {
    expect(pseudoExonWidth(40)).toBe(96);
    expect(pseudoExonWidth(200)).toBe(170);
    expect(pseudoExonWidth(5000)).toBe(300);
  });

  it("uses a default when the engine reports no length", () => {
    expect(pseudoExonWidth(null)).toBe(96);
    expect(pseudoExonWidth(0)).toBe(96);
  });
});

describe("focusWindow", () => {
  const full: SpliceExon[] = Array.from({ length: 20 }, (_, i) => ({
    rank: i + 1,
    len_bp: 100,
    w: 0.05,
  }));

  it("takes two exons either side and counts what it hid", () => {
    const window = focusWindow(full, 10);
    expect(window.exons.map(e => e.rank)).toEqual([8, 9, 10, 11, 12]);
    expect(window.truncBefore).toBe(7);
    expect(window.truncAfter).toBe(8);
  });

  it("clips at the transcript ends without inventing exons", () => {
    const first = focusWindow(full, 1);
    expect(first.exons.map(e => e.rank)).toEqual([1, 2, 3]);
    expect(first.truncBefore).toBe(0);

    const last = focusWindow(full, 20);
    expect(last.exons.map(e => e.rank)).toEqual([18, 19, 20]);
    expect(last.truncAfter).toBe(0);
  });

  it("returns nothing when there are no exons to window", () => {
    expect(focusWindow([], 5).exons).toEqual([]);
    expect(focusWindow(null, 5).exons).toEqual([]);
  });
});

describe("ptcInWindow", () => {
  it("is true only when the stop exon is on screen", () => {
    const ptc = { exon_rank: 8, fraction_in_exon: 0.4, hgvs_p: null, ptc_aa_position: null };
    expect(ptcInWindow(EXONS, ptc)).toBe(true);
    expect(ptcInWindow(EXONS, { ...ptc, exon_rank: 15 })).toBe(false);
    expect(ptcInWindow(EXONS, null)).toBe(false);
  });
});

describe("ptcCaption", () => {
  it("distinguishes a stop in a pseudo-exon from one in a coding exon", () => {
    expect(ptcCaption("pseudo_exon", "retained pseudo-exon", null, "p.Ter5")).toContain(
      "retained pseudo-exon"
    );
    expect(ptcCaption("coding_exon", "native coding exon 8", null, "p.Ter5")).toContain(
      "native coding exon 8"
    );
  });

  it("returns nothing when there is no stop to describe", () => {
    expect(ptcCaption(null, null, null, null)).toBeNull();
    expect(ptcCaption("coding_exon", null, "detail", null)).toBeNull();
  });

  it("builds a caption from a marker when no label was emitted", () => {
    const caption = ptcCaptionFromMarker({
      exon_rank: 8,
      fraction_in_exon: 0.3718,
      hgvs_p: "p.Gly293fsTer20",
      ptc_aa_position: 312,
    });
    expect(caption).toContain("native coding exon 8");
    expect(caption).toContain("~37%");
    expect(caption).toContain("p.Gly293fsTer20");
  });
});

describe("row headings", () => {
  const sv = (extra: Partial<SpliceViz>) => ({ target_rank: 8, ...extra }) as SpliceViz;

  it("says which product SpliceAI ranked first", () => {
    const primary = skipHeading(sv({ exon_skip_spliceai_primary: true }));
    expect(primary.map(p => p.text).join(" ")).toContain("loss primary");

    const parallel = skipHeading(sv({ junction_is_primary: true, junction_row: true }));
    expect(parallel.map(p => p.text).join(" ")).toContain("baseline if canonical site fails");
  });

  it("marks competing products so neither reads as settled", () => {
    const heading = skipHeading(sv({ competing: true, spliceai_gain_delta_exceeds_loss: true }));
    expect(heading.map(p => p.text).join(" ")).toContain("Parallel whole-exon skip");
  });

  it("names the gain mechanism and retained length", () => {
    const donor = junctionHeading(
      sv({ is_donor: true, junction_is_primary: true, pseudoexon_retained_nt: 120 })
    );
    const text = donor.map(p => p.text).join(" ");
    expect(text).toContain("Donor-gain (DS_DG)");
    expect(text).toContain("+120 nt pseudo-exon retained");
  });

  it("flags a 5' UTR insert as leaving the ORF intact", () => {
    const heading = junctionHeading(
      sv({ pre_atg_utr_pseudoexon: true, junction_row: true, pseudoexon_retained_nt: 66 })
    );
    expect(heading.map(p => p.text).join(" ")).toContain("ORF unchanged");
  });

  it("calls an in-frame deep intronic product exonization", () => {
    const heading = junctionHeading(
      sv({
        deep_intronic_products: true,
        junction_row: true,
        in_frame_exonization: true,
        pseudoexon_insert_nt: 99,
      })
    );
    expect(heading.map(p => p.text).join(" ")).toContain("exonization (+99 nt pseudo-exon, in-frame)");
  });
});
