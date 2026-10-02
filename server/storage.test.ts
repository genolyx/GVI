import { afterEach, describe, expect, it } from "vitest";
import { browserUploadEndpoint, browserUploadPath } from "./storage";

describe("browserUploadEndpoint", () => {
  const previous = process.env.AWS_ENDPOINT;

  afterEach(() => {
    if (previous === undefined) delete process.env.AWS_ENDPOINT;
    else process.env.AWS_ENDPOINT = previous;
  });

  it("signs for the address the page was opened on", () => {
    process.env.AWS_ENDPOINT = "http://localhost:9000";
    expect(browserUploadEndpoint("192.168.123.107:3010")).toBe(
      "http://192.168.123.107:9000"
    );
  });

  it("sends browser uploads through the app instead of MinIO", () => {
    expect(
      browserUploadPath("organizations/1/cases/57/files/11111111-1111-1111-1111-111111111111-sample.vcf.gz")
    ).toBe(
      "/api/uploads/organizations/1/cases/57/files/11111111-1111-1111-1111-111111111111-sample.vcf.gz"
    );
  });

  it("leaves localhost uploads on localhost", () => {
    process.env.AWS_ENDPOINT = "http://localhost:9000";
    expect(browserUploadEndpoint("localhost:3010")).toBeUndefined();
    expect(browserUploadEndpoint(undefined)).toBeUndefined();
  });
});
