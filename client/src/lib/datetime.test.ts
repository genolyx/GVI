import { describe, expect, it } from "vitest";
import { formatCount, formatDate, formatDateTime, formatSignatureTimestamp } from "./datetime";

const INSTANT = "2026-09-22T00:46:23.000Z";

describe("clinical date formatting", () => {
  it("renders English month names regardless of the host locale", () => {
    // The point of the module: a ko-KR machine must not produce "2026. 9. 22.".
    expect(formatDateTime(INSTANT)).toMatch(/Sep \d{1,2}, 2026/);
    expect(formatDate(INSTANT)).toMatch(/^Sep \d{1,2}, 2026$/);
  });

  it("omits the time when only the date matters", () => {
    expect(formatDate(INSTANT)).not.toMatch(/AM|PM|:/);
  });

  it("includes seconds and a timezone for signatures", () => {
    const signed = formatSignatureTimestamp(INSTANT);
    expect(signed).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    expect(signed).toMatch(/[A-Z]{2,5}|GMT[+-]\d/);
  });

  it("renders an em-dash for missing values instead of Invalid Date", () => {
    for (const empty of [null, undefined, "", "not a date"]) {
      expect(formatDateTime(empty as never)).toBe("—");
      expect(formatDate(empty as never)).toBe("—");
      expect(formatSignatureTimestamp(empty as never)).toBe("—");
    }
  });

  it("accepts Date, ISO string and epoch millis alike", () => {
    const date = new Date(INSTANT);
    expect(formatDate(date)).toBe(formatDate(INSTANT));
    expect(formatDate(date.getTime())).toBe(formatDate(INSTANT));
  });

  it("groups counts and guards non-finite input", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(null)).toBe("—");
    expect(formatCount(Number.NaN)).toBe("—");
  });
});
