import { readFileSync, readdirSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { ENGINE_HTML_KEYS, buildCurationSummary, curationDocumentSchema } from "./document";

/**
 * Cross-language contract conformance.
 *
 * `engine/tests/test_contract_adapter.py` runs SAM-VC's four golden `/api/analyze`
 * baselines through the Python adapter, validates each result with the Pydantic
 * models, and writes the serialised documents here. This suite parses those exact
 * bytes with the Zod schema. If the Python and TypeScript definitions drift apart,
 * one of the two test suites fails.
 *
 * Regenerate the fixtures with:
 *   engine/.venv/bin/python -m pytest engine/tests/test_contract_adapter.py
 */

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const fixtureDir = path.join(repoRoot, "engine", "tests", "contract_fixtures");
const schemaPath = path.join(repoRoot, "contracts", "curation-document.v1.json");

const fixtures = readdirSync(fixtureDir).filter(name => name.endsWith(".document.json"));

describe("CurationDocument v1 contract", () => {
  it("has fixtures generated from the engine regression baselines", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
  });

  it.each(fixtures)("accepts the Python-produced document for %s", name => {
    const raw = JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8"));
    const parsed = curationDocumentSchema.parse(raw);

    expect(parsed.contractVersion).toBe("1.0");
    expect(parsed.meta.referenceBuild).toBe("GRCh38");
    expect(parsed.variant.gene).toBeTruthy();
    expect(parsed.variant.hgvsC).toBeTruthy();
  });

  it("maps the engine's strength-suffixed PVS1 onto a base code plus strength", () => {
    const raw = JSON.parse(
      readFileSync(path.join(fixtureDir, "AMT_c.878-1G_A.document.json"), "utf8")
    );
    const parsed = curationDocumentSchema.parse(raw);

    const pvs1 = parsed.acmg.criteria.find(criterion => criterion.code === "PVS1_Strong");
    expect(pvs1).toBeDefined();
    expect(pvs1?.baseCode).toBe("PVS1");
    expect(pvs1?.strength).toBe("strong");
    expect(parsed.acmg.classification?.label).toBe("Likely Pathogenic");
  });

  it("rejects a document whose criterion carries an unknown strength", () => {
    const raw = JSON.parse(
      readFileSync(path.join(fixtureDir, "AMT_c.878-1G_A.document.json"), "utf8")
    );
    raw.acmg.criteria[0].strength = "quite_strong";
    expect(() => curationDocumentSchema.parse(raw)).toThrow();
  });

  it("carries the engine's whole fact sheet through to the client", () => {
    // The pass-through layer exists so SAM-VC's analysis arrives complete. A
    // document that only brought the typed core would silently lose most of it.
    const raw = JSON.parse(
      readFileSync(path.join(fixtureDir, "AMT_c.878-1G_A.document.json"), "utf8")
    );
    const parsed = curationDocumentSchema.parse(raw);

    expect(Object.keys(parsed.engine.parsedData).length).toBeGreaterThan(150);
    // Facts the typed core does not describe, which the Curation UI reads directly.
    expect(parsed.engine.parsedData).toHaveProperty("splice_frame_math");
    expect(parsed.engine.parsedData).toHaveProperty("junction_align_viz_ctx");
    expect(parsed.engine.parsedData).toHaveProperty("pm5_local_alleles");
    expect(parsed.engine.geneSummary).toBeTruthy();
  });

  it("accepts an engine fact it has never seen before", () => {
    // Engine releases add keys. That must not require a contract change, which is
    // the whole reason the pass-through layer is loosely typed.
    const raw = JSON.parse(
      readFileSync(path.join(fixtureDir, "AMT_c.878-1G_A.document.json"), "utf8")
    );
    raw.engine.parsedData.some_future_engine_fact = { nested: [1, 2, 3] };
    expect(() => curationDocumentSchema.parse(raw)).not.toThrow();
  });

  it("lists every engine HTML key exactly once", () => {
    expect(new Set(ENGINE_HTML_KEYS).size).toBe(ENGINE_HTML_KEYS.length);
  });

  it("rejects a document from a future contract version", () => {
    const raw = JSON.parse(
      readFileSync(path.join(fixtureDir, "AMT_c.878-1G_A.document.json"), "utf8")
    );
    raw.contractVersion = "2.0";
    expect(() => curationDocumentSchema.parse(raw)).toThrow();
  });

  it("agrees with the committed JSON Schema on the top-level sections", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const zodShape = Object.keys(curationDocumentSchema.shape).sort();

    expect(Object.keys(schema.properties).sort()).toEqual(zodShape);
    expect([...schema.required].sort()).toEqual(zodShape);
  });
});

describe("buildCurationSummary", () => {
  it("projects the fields the run list and queries need", () => {
    const raw = JSON.parse(
      readFileSync(path.join(fixtureDir, "AMT_c.878-1G_A.document.json"), "utf8")
    );
    const summary = buildCurationSummary(curationDocumentSchema.parse(raw));

    expect(summary.gene).toBe("AMT");
    expect(summary.criteriaCodes).toContain("PVS1_Strong");
    expect(summary.classification?.label).toBe("Likely Pathogenic");
    // The AMT baseline loses the canonical acceptor with DS_AL 0.98.
    expect(summary.spliceAiMax).toBeGreaterThan(0.9);
    expect(summary.sourcesDisabled).toEqual([]);
  });
});
