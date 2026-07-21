import { describe, expect, it } from "vitest";
import { buildDedupeKey, isDuplicateDelivery } from "./idempotency.js";

describe("buildDedupeKey", () => {
  it("uses eventId as the dedupe key when provided", () => {
    expect(buildDedupeKey("PROJ-1", "evt-123")).toBe("evt-123");
  });

  it("falls back to ticketKey when no eventId is given", () => {
    expect(buildDedupeKey("PROJ-1")).toBe("PROJ-1");
  });
});

describe("isDuplicateDelivery", () => {
  it("treats the first delivery as new and a repeat as a duplicate", () => {
    const key = `unique-test-key-${Math.random()}`;

    expect(isDuplicateDelivery(key)).toBe(false);
    expect(isDuplicateDelivery(key)).toBe(true);
  });

  it("treats different keys independently", () => {
    const keyA = `key-a-${Math.random()}`;
    const keyB = `key-b-${Math.random()}`;

    expect(isDuplicateDelivery(keyA)).toBe(false);
    expect(isDuplicateDelivery(keyB)).toBe(false);
  });
});
