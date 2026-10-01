import { afterEach, describe, expect, it } from "vitest";
import { browserUploadEndpoint } from "./storage";

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

  it("leaves localhost uploads on localhost", () => {
    process.env.AWS_ENDPOINT = "http://localhost:9000";
    expect(browserUploadEndpoint("localhost:3010")).toBeUndefined();
    expect(browserUploadEndpoint(undefined)).toBeUndefined();
  });
});
