import { describe, expect, it } from "vitest";
import { computeSignature, diagnoseSignature, verifySignature } from "./signature";

// Vector computed independently in Python with the documented steps:
// hmac.new(secret.encode(), f"{ts}.{base64.b64encode(raw_body).decode()}".encode(), sha256).hexdigest()
const BODY =
  '{"subdomain":"demo-practice","event_name":"patient_created","data":{"patients":[{"id":7,"updated_at":"2026-11-17T18:59:58.000Z","note":"café"}]}}';
const TS = "2026-11-17T19:00:00.000Z";
const SECRET = "NArWk7gdI96Bdn";
const EXPECTED = "4bf6019215fd8211f53b1a548143431b2474d0f9bc9abd985d1a3251b42689ef";
const NOW = new Date("2026-11-17T19:00:30.000Z");

describe("computeSignature", () => {
  it("matches the vector computed from the documented algorithm", () => {
    expect(computeSignature(BODY, TS, SECRET)).toBe(EXPECTED);
  });

  it("gives the same result for a Buffer and a string of the same bytes", () => {
    expect(computeSignature(Buffer.from(BODY, "utf8"), TS, SECRET)).toBe(EXPECTED);
  });
});

describe("verifySignature", () => {
  it("accepts the untouched body", () => {
    expect(verifySignature(BODY, TS, EXPECTED, SECRET, { now: NOW })).toEqual({ ok: true });
  });

  it("accepts an upper-case hex signature with surrounding whitespace", () => {
    expect(verifySignature(BODY, TS, ` ${EXPECTED.toUpperCase()} `, SECRET, { now: NOW }).ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const tampered = BODY.replace('"id":7', '"id":8');
    expect(verifySignature(tampered, TS, EXPECTED, SECRET, { now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a changed timestamp header", () => {
    expect(verifySignature(BODY, "2026-11-17T19:00:01.000Z", EXPECTED, SECRET, { now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a re-serialized body even though the JSON is equivalent", () => {
    const pretty = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(JSON.parse(pretty)).toEqual(JSON.parse(BODY));
    expect(verifySignature(pretty, TS, EXPECTED, SECRET, { now: NOW }).ok).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    const forged = computeSignature(BODY, TS, "not-the-secret");
    expect(verifySignature(BODY, TS, forged, SECRET, { now: NOW }).ok).toBe(false);
  });

  it("rejects a signature of a different length without throwing", () => {
    expect(verifySignature(BODY, TS, "abc", SECRET, { now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("reports missing headers", () => {
    expect(verifySignature(BODY, null, EXPECTED, SECRET)).toEqual({ ok: false, reason: "missing_header" });
    expect(verifySignature(BODY, TS, undefined, SECRET)).toEqual({ ok: false, reason: "missing_header" });
    expect(verifySignature(BODY, "", "", SECRET)).toEqual({ ok: false, reason: "missing_header" });
  });

  it("rejects a valid signature with a stale timestamp", () => {
    const later = new Date("2026-11-17T19:10:00.000Z");
    expect(verifySignature(BODY, TS, EXPECTED, SECRET, { now: later })).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  it("rejects timestamps too far in the future as well", () => {
    const earlier = new Date("2026-11-17T18:50:00.000Z");
    expect(verifySignature(BODY, TS, EXPECTED, SECRET, { now: earlier }).ok).toBe(false);
  });

  it("lets the tolerance be configured or turned off", () => {
    const later = new Date("2026-11-17T19:10:00.000Z");
    expect(verifySignature(BODY, TS, EXPECTED, SECRET, { now: later, toleranceSec: 900 }).ok).toBe(true);
    expect(verifySignature(BODY, TS, EXPECTED, SECRET, { now: later, toleranceSec: 0 }).ok).toBe(true);
  });

  it("reports an unparseable timestamp that was nonetheless signed", () => {
    const ts = "not-a-date";
    const sig = computeSignature(BODY, ts, SECRET);
    expect(verifySignature(BODY, ts, sig, SECRET)).toEqual({ ok: false, reason: "invalid_timestamp" });
  });

  it("refuses to run with an empty secret", () => {
    expect(() => verifySignature(BODY, TS, EXPECTED, "")).toThrow(/secret/);
  });
});

describe("diagnoseSignature", () => {
  const hmac = async (message: string, encoding: "hex" | "base64") =>
    (await import("node:crypto")).createHmac("sha256", SECRET).update(message).digest(encoding);

  it("recognises the documented algorithm", () => {
    expect(diagnoseSignature(BODY, TS, EXPECTED, SECRET)).toBe("documented");
  });

  it("spots a base64 digest instead of hex", async () => {
    const sig = await hmac(`${TS}.${Buffer.from(BODY).toString("base64")}`, "base64");
    expect(diagnoseSignature(BODY, TS, sig, SECRET)).toBe("base64_digest");
  });

  it("spots a signature over the plain body", async () => {
    const sig = await hmac(`${TS}.${BODY}`, "hex");
    expect(diagnoseSignature(BODY, TS, sig, SECRET)).toBe("body_not_base64_encoded");
  });

  it("spots a sender that signed a compact re-serialization of the body", () => {
    const pretty = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(diagnoseSignature(pretty, TS, EXPECTED, SECRET)).toBe("reserialized_compact_json");
  });

  it("returns none when nothing matches, including non-JSON bodies", () => {
    expect(diagnoseSignature("not json", TS, EXPECTED, SECRET)).toBe("none");
  });
});
