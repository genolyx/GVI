import { describe, expect, it } from "vitest";
import { interpretDarkGenes } from "./darkGenes";

const detailed = `SAMPLE: NA12878
========================================
!!! QUALITY WARNINGS !!!
  WARNING: Median depth below 15x in Alpha-Cluster (1) or SMA (0).

SMAca CHECK (Silent Carrier + Coverage):
  SMN1_CN=1
  SMN2_CN=2
  SilentCarrier=False

CYP21A2 ANALYSIS (CAH - Dosage):
  Est_CN=0
  WARNING: Possible Deletion Detected (Depth Proxy)

EXPANSION HUNTER (Fragile X / FMR1):
  FMR1:18/62

CFTR IVS9:
  Raw EH REPCN  : CFTR_TG=12/11  CFTR_polyT=5/7
`;

describe("dark gene interpretation", () => {
  it("turns a pipeline report into portal sections and severity", () => {
    const result = interpretDarkGenes({ detailedText: detailed });
    expect(result.status).toBe("ready");
    const byTitle = Object.fromEntries(
      result.detailed_sections.map(section => [section.title, section.kind])
    );
    expect(byTitle["QUALITY WARNINGS"]).toBe("alert");
    expect(byTitle["SMAca CHECK (Silent Carrier + Coverage)"]).toBe("warning");
    expect(byTitle["CYP21A2 ANALYSIS (CAH - Dosage)"]).toBe("warning");
    expect(byTitle["EXPANSION HUNTER (Fragile X / FMR1)"]).toBe("warning");
    expect(byTitle["CFTR IVS9"]).toBe("warning");
    expect(result.cftr_ivs9_eh).toMatchObject({
      display_t: "5T/7T",
      display_tg: "TG12/TG11",
      risk_level: "high",
    });
  });

  it("leaves a two-copy SMN1 section normal and skips an empty report", () => {
    const normal = interpretDarkGenes({
      detailedText: "SMAca CHECK:\n  SMN1_CN=2\n  SMN2_CN=2\n",
    });
    expect(normal.detailed_sections[0]?.kind).toBe("normal");
    expect(interpretDarkGenes({ summaryText: "  ", detailedText: "" })).toEqual({
      status: "absent",
      detailed_sections: [],
      cftr_ivs9_eh: null,
    });
  });
});
