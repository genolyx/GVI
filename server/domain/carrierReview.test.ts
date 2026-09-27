import { describe, expect, it } from "vitest";
import { carrierReviewBanner } from "@shared/carrierReview";

describe("carrier review banner", () => {
  it("counts pathogenic variants and names their genes", () => {
    const banner = carrierReviewBanner([
      { gene: "CFTR", classification: "Pathogenic" },
      { gene: "CFTR", classification: "Likely Pathogenic" },
      { gene: "HBB", classification: "VUS" },
      { gene: "GJB2", classification: "Benign" },
    ]);
    expect(banner.tone).toBe("detected");
    expect(banner.pathogenic).toBe(2);
    expect(banner.vus).toBe(1);
    expect(banner.genes).toEqual(["CFTR"]);
    expect(banner.title).toContain("2 pathogenic");
  });

  it("uses the uncertain banner when only VUS are classified", () => {
    const banner = carrierReviewBanner([
      { gene: "HBB", classification: "VUS" },
      { gene: "GJB2", classification: null },
    ]);
    expect(banner.tone).toBe("uncertain");
    expect(banner.vus).toBe(1);
  });

  it("uses the negative banner when nothing is pathogenic or uncertain", () => {
    const banner = carrierReviewBanner([
      { gene: "GJB2", classification: "Likely Benign" },
    ]);
    expect(banner.tone).toBe("negative");
  });
});
