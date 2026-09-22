import {
  junctionAlignSchema,
  literatureSchema,
  readVizPayload,
  spliceVizSchema,
} from "@shared/curation/viz";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Contract-conformance for the visualization payloads.
 *
 * The four files in `engine/tests/contract_fixtures` are real engine output for the
 * regression baselines, so parsing them proves the lenient schemas actually accept what
 * the engine emits rather than what this repo assumes it emits. The leniency tests below
 * then prove the reverse: an engine change must not blank a panel.
 */

const FIXTURE_DIR = join(process.cwd(), "engine/tests/contract_fixtures");

const fixtures = readdirSync(FIXTURE_DIR)
  .filter(name => name.endsWith(".document.json"))
  .map(name => ({
    name: name.replace(".document.json", ""),
    parsedData: (
      JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as {
        engine: { parsedData: Record<string, unknown> };
      }
    ).engine.parsedData,
  }));

describe("engine visualization fixtures", () => {
  it("found the baseline documents to test against", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
  });

  it.each(fixtures)("parses splice_viz for $name", ({ parsedData }) => {
    const sv = readVizPayload(parsedData, "splice_viz", spliceVizSchema);
    expect(sv).not.toBeNull();
    expect(sv?.eligible).toBe(true);
    // Something must be drawable: an exon list and a target the map can centre on.
    expect(sv?.exons_full?.length || sv?.exons?.length).toBeGreaterThan(0);
    expect(sv?.target_rank).toBeTypeOf("number");
  });

  it.each(fixtures)("keeps every splice_viz key through the schema for $name", ({ parsedData }) => {
    const raw = parsedData.splice_viz as Record<string, unknown>;
    const parsed = readVizPayload(parsedData, "splice_viz", spliceVizSchema);
    // Passthrough is what lets the engine add facts without a contract change; a key
    // silently dropped here would be a fact the reviewer never sees.
    expect(Object.keys(parsed || {}).sort()).toEqual(Object.keys(raw).sort());
  });

  it.each(fixtures)("parses junction_align_viz for $name", ({ parsedData }) => {
    const ja = readVizPayload(parsedData, "junction_align_viz", junctionAlignSchema);
    expect(ja).not.toBeNull();
    if (ja?.eligible === false) return;
    expect(ja?.tracks?.length).toBeGreaterThan(0);
    for (const track of ja?.tracks || []) {
      expect(track.title).toBeTruthy();
      // Either bases to draw, or a span explaining why there are none.
      expect((track.bases?.length || 0) + (track.spans?.length || 0)).toBeGreaterThan(0);
    }
  });

  it.each(fixtures)("reads a reference track wide enough to align to for $name", ({ parsedData }) => {
    const ja = readVizPayload(parsedData, "junction_align_viz", junctionAlignSchema);
    const reference = ja?.tracks?.find(track => track.id === "reference");
    if (!reference) return;
    expect(reference.bases?.length).toBeGreaterThan(0);
    // Every ruler tick must land on a base, or labels float past the sequence.
    for (const tick of ja?.ruler || []) {
      expect(Number(tick.index)).toBeLessThan(reference.bases?.length || 0);
    }
  });

  it.each(fixtures)("reads span bounds as half-open and non-empty for $name", ({ parsedData }) => {
    const ja = readVizPayload(parsedData, "junction_align_viz", junctionAlignSchema);
    for (const track of ja?.tracks || []) {
      const length = track.bases?.length || 0;
      for (const span of track.spans || []) {
        expect(Number(span.start)).toBeGreaterThanOrEqual(0);
        expect(Number(span.end)).toBeGreaterThan(Number(span.start));
        // A span may run past the last visible base: NLRP3 c.2798G>T excises 38 nt from
        // a 27-base window, so `exon_skip` ends at 51. Half-open containment clips it to
        // what is on screen and the span's own label reports the true extent.
        if (length) expect(Number(span.start)).toBeLessThan(length);
      }
      for (const marker of track.markers || []) {
        if (marker.index === null || marker.index === undefined) continue;
        expect(Number(marker.index)).toBeGreaterThanOrEqual(0);
        // Markers point at a single base, so an out-of-range index would be invisible.
        if (length) expect(Number(marker.index)).toBeLessThan(length);
      }
    }
  });
});

describe("schema leniency", () => {
  it("survives an unknown key the engine adds later", () => {
    const parsed = spliceVizSchema.parse({
      eligible: true,
      target_rank: 4,
      brand_new_engine_field: { nested: [1, 2, 3] },
    });
    expect(parsed.target_rank).toBe(4);
    expect(parsed.brand_new_engine_field).toEqual({ nested: [1, 2, 3] });
  });

  it("coerces ranks the engine emits as strings", () => {
    const parsed = spliceVizSchema.parse({ target_rank: "8", exons: [{ rank: "3", len_bp: "150" }] });
    expect(parsed.target_rank).toBe(8);
    expect(parsed.exons?.[0].rank).toBe(3);
    expect(parsed.exons?.[0].len_bp).toBe(150);
  });

  it("nulls a field of the wrong type rather than rejecting the payload", () => {
    const parsed = spliceVizSchema.parse({
      eligible: true,
      target_rank: { unexpected: "object" },
      row_order: "ref_skip_junction",
    });
    expect(parsed.target_rank).toBeNull();
    expect(parsed.row_order).toBe("ref_skip_junction");
  });

  it("drops a malformed nested block without losing its siblings", () => {
    const parsed = spliceVizSchema.parse({
      target_rank: 8,
      focus_primary: "not an object",
      variant_marker: { mode: "intron", upstream_exon: 7, downstream_exon: 8 },
    });
    expect(parsed.focus_primary).toBeNull();
    expect(parsed.variant_marker?.mode).toBe("intron");
  });

  it("returns null for a missing or non-object payload instead of throwing", () => {
    expect(readVizPayload({}, "splice_viz", spliceVizSchema)).toBeNull();
    expect(readVizPayload({ splice_viz: "nope" }, "splice_viz", spliceVizSchema)).toBeNull();
    expect(readVizPayload(null, "splice_viz", spliceVizSchema)).toBeNull();
    expect(readVizPayload(undefined, "splice_viz", spliceVizSchema)).toBeNull();
  });

  it("reads the literature block the engine attaches after analysis", () => {
    const parsed = literatureSchema.parse({
      status: "ok",
      clinical_summary: "<p>Two families reported.</p>",
      local_index: { query: "AMT splice", hit_count: 9, pmids: [11139253, "25525159"] },
    });
    expect(parsed.status).toBe("ok");
    expect(parsed.local_index?.pmids).toEqual(["11139253", "25525159"]);
  });

  it("keeps a literature failure distinguishable from an empty result", () => {
    const failed = literatureSchema.parse({ status: "download_failed", error: "HTTP 429" });
    expect(failed.status).toBe("download_failed");
    expect(failed.error).toBe("HTTP 429");

    const empty = literatureSchema.parse({ status: "ok" });
    expect(empty.error).toBeFalsy();
  });
});
