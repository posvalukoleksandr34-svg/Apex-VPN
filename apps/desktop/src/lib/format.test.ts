import { describe, expect, it } from "vitest";
import { bytes, DASH, duration, latency, latencyTone, loadTone, rate, relativeTime } from "./format";

describe("format", () => {
  it("never invents a number for a missing measurement", () => {
    expect(latency(null)).toBe(DASH);
    expect(latency(undefined)).toBe(DASH);
    expect(rate(null)).toBe(DASH);
    expect(rate(Number.NaN)).toBe(DASH);
    expect(latencyTone(null)).toBe("unknown");
    expect(loadTone(undefined)).toBe("unknown");
  });

  it("shows a measured zero as zero, not as missing", () => {
    expect(latency(0)).toBe("0 ms");
    expect(rate(0, "en")).toBe("0 bps");
    expect(latencyTone(0)).toBe("good");
  });

  it("formats sizes in binary units", () => {
    expect(bytes(0, "en")).toBe("0 B");
    expect(bytes(1023, "en")).toBe("1,023 B");
    expect(bytes(1536, "en")).toBe("1.5 KB");
    expect(bytes(5 * 1024 ** 3, "en")).toBe("5 GB");
    expect(bytes(1536, "de")).toBe("1,5 KB");
  });

  it("quotes speeds in bits per second", () => {
    expect(rate(125_000, "en")).toBe("1 Mbps");
    expect(rate(187_500, "en")).toBe("1.5 Mbps");
    // Ten and over rounds to whole units, as speed readouts usually do.
    expect(rate(12_500_000 / 8, "en")).toBe("13 Mbps");
  });

  it("formats durations as a clock", () => {
    expect(duration(0)).toBe("00:00");
    expect(duration(59_999)).toBe("00:59");
    expect(duration(61_000)).toBe("01:01");
    expect(duration(3_600_000 + 5_000)).toBe("1:00:05");
    expect(duration(-5_000)).toBe("00:00");
  });

  it("buckets latency and load for colouring", () => {
    expect([59, 60, 149, 150].map(latencyTone)).toEqual(["good", "ok", "ok", "poor"]);
    expect([49, 50, 79, 80].map(loadTone)).toEqual(["good", "ok", "ok", "poor"]);
  });

  it("describes times relative to now", () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now - 5 * 60_000, now, "en")).toBe("5 minutes ago");
    expect(relativeTime(now + 2 * 3_600_000, now, "en")).toBe("in 2 hours");
    expect(relativeTime(now - 86_400_000, now, "en")).toBe("yesterday");
  });
});
