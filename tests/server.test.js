// Server-side unit tests. Covers the three pure helpers used by the Express
// routes: normalizeOffer, normalizeListing, criteriaMatches. The route
// handlers themselves talk to OpenSea and are exercised manually via the
// browser smoke tests — kept out of this suite to avoid network coupling.
//
// Run with: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeOffer, normalizeListing, criteriaMatches } = require("../server");

// ─── criteriaMatches ──────────────────────────────────────────────────────────
test("criteriaMatches: wildcards and null are collection-wide", () => {
  assert.equal(criteriaMatches(null, 5), true);
  assert.equal(criteriaMatches("", 5), true);
  assert.equal(criteriaMatches("*", 5), true);
});

test("criteriaMatches: single id", () => {
  assert.equal(criteriaMatches("2601", 2601), true);
  assert.equal(criteriaMatches("2601", "2601"), true);
  assert.equal(criteriaMatches("2601", 2602), false);
});

test("criteriaMatches: comma-separated list", () => {
  assert.equal(criteriaMatches("1,5,9", 5), true);
  assert.equal(criteriaMatches("1,5,9", 6), false);
  assert.equal(criteriaMatches("1, 5 , 9", 5), true, "tolerates whitespace");
});

test("criteriaMatches: colon ranges are inclusive at both ends", () => {
  assert.equal(criteriaMatches("10:20", 10), true);
  assert.equal(criteriaMatches("10:20", 20), true);
  assert.equal(criteriaMatches("10:20", 15), true);
  assert.equal(criteriaMatches("10:20", 9), false);
  assert.equal(criteriaMatches("10:20", 21), false);
});

test("criteriaMatches: hyphen ranges treated like colon ranges", () => {
  assert.equal(criteriaMatches("100-200", 150), true);
  assert.equal(criteriaMatches("100-200", 100), true);
  assert.equal(criteriaMatches("100-200", 99), false);
});

test("criteriaMatches: mixed list of ids and ranges", () => {
  const enc = "1,2,6831:6832,9999";
  assert.equal(criteriaMatches(enc, 1), true);
  assert.equal(criteriaMatches(enc, 6832), true, "upper range bound included");
  assert.equal(criteriaMatches(enc, 6830), false, "below range");
  assert.equal(criteriaMatches(enc, 9999), true);
  assert.equal(criteriaMatches(enc, 5000), false);
});

// ─── normalizeOffer ───────────────────────────────────────────────────────────
// Minimal builder for OpenSea v2 offer shapes. Only the fields normalizeOffer
// actually reads — anything extra would just be noise.
function makeOffer({
  totalWei = "1000000000000000000", qty = "1", encoded = null, trait = null,
  startTime = 1_000_000, endTime = 2_000_000, offerer = "0xAbC",
  priceValue = null, currency = "WETH", decimals = 18, orderHash = "0xhash",
} = {}) {
  return {
    order_hash: orderHash,
    price: { value: priceValue ?? totalWei, currency, decimals },
    protocol_data: {
      parameters: {
        offer: [{ startAmount: totalWei }],
        consideration: [{ startAmount: qty }],
        startTime: String(startTime),
        endTime: String(endTime),
        offerer,
      },
    },
    criteria: { encoded_token_ids: encoded, trait },
  };
}

test("normalizeOffer: item offer keeps per-unit price equal to total for qty=1", () => {
  const o = normalizeOffer(makeOffer({ totalWei: "550000000000000000", qty: "1", encoded: "2601" }));
  assert.equal(o.type, "item");
  assert.equal(o.priceWei, "550000000000000000");
  assert.equal(o.quantity, 1);
});

test("normalizeOffer: bulk offer divides total / quantity (OpenSea ranks by per-unit)", () => {
  const o = normalizeOffer(makeOffer({ totalWei: "550000000000000000", qty: "5" }));
  // 0.55 WETH for 5 NFTs → per-unit 0.11 WETH = 110000000000000000 wei
  assert.equal(o.priceWei, "110000000000000000");
  assert.equal(o.quantity, 5);
  assert.equal(o.type, "collection", "no encoded id + no trait = collection offer");
});

test("normalizeOffer: trait offer wins over encoded ids when both present", () => {
  const o = normalizeOffer(makeOffer({ trait: { type: "Background", value: "Blue" }, encoded: "1,2,3" }));
  assert.equal(o.type, "trait");
  assert.equal(o.traitType, "Background");
  assert.equal(o.traitValue, "Blue");
});

test("normalizeOffer: collection offer when criteria is wildcard or absent", () => {
  assert.equal(normalizeOffer(makeOffer({ encoded: "*" })).type, "collection");
  assert.equal(normalizeOffer(makeOffer({ encoded: null })).type, "collection");
});

test("normalizeOffer: duration = endTime − startTime, exposed in seconds", () => {
  const o = normalizeOffer(makeOffer({ startTime: 1000, endTime: 1900 }));
  assert.equal(o.durationSec, 900);
  assert.equal(o.startTime, 1000);
  assert.equal(o.endTime, 1900);
});

test("normalizeOffer: durationSec is 0 when endTime ≤ startTime (malformed input)", () => {
  assert.equal(normalizeOffer(makeOffer({ startTime: 5000, endTime: 5000 })).durationSec, 0);
  assert.equal(normalizeOffer(makeOffer({ startTime: 5000, endTime: 1000 })).durationSec, 0);
});

test("normalizeOffer: makerAddress lowercased so cache keys are stable", () => {
  const o = normalizeOffer(makeOffer({ offerer: "0xAbCdEf1234567890" }));
  assert.equal(o.makerAddress, "0xabcdef1234567890");
});

// ─── normalizeListing ─────────────────────────────────────────────────────────
function makeListing({
  tokenId = "2601", priceWei = "300000000000000000",
  startTime = 1_000_000, endTime = 2_000_000, offerer = "0xSeller",
  orderHash = "0xhash",
} = {}) {
  return {
    order_hash: orderHash,
    price: { current: { value: priceWei, currency: "ETH", decimals: 18 } },
    protocol_data: {
      parameters: {
        offer: [{ identifierOrCriteria: tokenId }],
        consideration: [{ startAmount: priceWei }],
        startTime: String(startTime),
        endTime: String(endTime),
        offerer,
      },
    },
  };
}

test("normalizeListing: extracts tokenId, price, currency and lowercases lister", () => {
  const l = normalizeListing(makeListing({ tokenId: "1712", priceWei: "250000000000000000", offerer: "0xABCD" }));
  assert.equal(l.tokenId, "1712");
  assert.equal(l.priceWei, "250000000000000000");
  assert.equal(l.currency, "ETH");
  assert.equal(l.makerAddress, "0xabcd");
});

test("normalizeListing: durationSec mirrors normalizeOffer rules", () => {
  assert.equal(normalizeListing(makeListing({ startTime: 100, endTime: 700 })).durationSec, 600);
  assert.equal(normalizeListing(makeListing({ startTime: 700, endTime: 100 })).durationSec, 0);
});

test("normalizeListing: tokenId null when OpenSea omits identifierOrCriteria", () => {
  const raw = makeListing();
  delete raw.protocol_data.parameters.offer[0].identifierOrCriteria;
  assert.equal(normalizeListing(raw).tokenId, null);
});
