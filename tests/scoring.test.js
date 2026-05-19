// Frontend scoring/ranking unit tests. The helpers live in public/scoring.js
// behind a UMD wrapper so they can be loaded both as a browser <script> and
// require()'d here from Node without DOM globals.
//
// Run with: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  offerDurationPoints,
  computeBotScore,
  compareOffersBySafety,
  findConcentratedListers,
} = require("../public/scoring");

// ─── offerDurationPoints — threshold ladder for the per-row bot-score bonus ──
test("offerDurationPoints: 0 for missing or non-positive input", () => {
  assert.equal(offerDurationPoints(0), 0);
  assert.equal(offerDurationPoints(-1), 0);
  assert.equal(offerDurationPoints(null), 0);
  assert.equal(offerDurationPoints(undefined), 0);
});

test("offerDurationPoints: maps each band to the documented bonus", () => {
  // <5m  → +10  (almost certainly automated)
  assert.equal(offerDurationPoints(60), 10);
  assert.equal(offerDurationPoints(299), 10);
  // <30m → +7   (bot-like)
  assert.equal(offerDurationPoints(300), 7, "5min boundary lands in the next band, not <5m");
  assert.equal(offerDurationPoints(1799), 7);
  // <2h  → +4
  assert.equal(offerDurationPoints(1800), 4);
  assert.equal(offerDurationPoints(7199), 4);
  // <6h  → +1
  assert.equal(offerDurationPoints(7200), 1);
  assert.equal(offerDurationPoints(21599), 1);
  // ≥6h  → 0   (typical human / OpenSea defaults)
  assert.equal(offerDurationPoints(21600), 0);
  assert.equal(offerDurationPoints(86400 * 7), 0, "7-day OpenSea default");
});

// ─── compareOffersBySafety — Safest-first sort comparator ────────────────────
// Hides three guarantees: lower adjusted score sorts first, ties break by
// price (higher first), and unscored offers (still loading) sink to the bottom.
test("compareOffersBySafety: lower adjusted score sorts first", () => {
  const offers = [
    { _adjustedScore: 70, priceWei: "100" },
    { _adjustedScore: 10, priceWei: "100" },
    { _adjustedScore: 40, priceWei: "100" },
  ];
  offers.sort(compareOffersBySafety);
  assert.deepEqual(offers.map(o => o._adjustedScore), [10, 40, 70]);
});

test("compareOffersBySafety: equal scores break ties by price descending", () => {
  const offers = [
    { _adjustedScore: 25, priceWei: "100" },
    { _adjustedScore: 25, priceWei: "500" },
    { _adjustedScore: 25, priceWei: "300" },
  ];
  offers.sort(compareOffersBySafety);
  assert.deepEqual(offers.map(o => o.priceWei), ["500", "300", "100"]);
});

test("compareOffersBySafety: unscored offers sink to the bottom (999 sentinel)", () => {
  const offers = [
    { priceWei: "1000" },                       // unscored
    { _adjustedScore: 85, priceWei: "10" },     // bot-like, but still scored
    { _adjustedScore: 5, priceWei: "10" },      // safest
  ];
  offers.sort(compareOffersBySafety);
  assert.equal(offers[0]._adjustedScore, 5);
  assert.equal(offers[1]._adjustedScore, 85);
  assert.equal(offers[2]._adjustedScore, undefined, "unscored row lands last");
});

// ─── findConcentratedListers — floor-wall detection ──────────────────────────
test("findConcentratedListers: returns empty when nobody hits the threshold", () => {
  const listings = [
    { makerAddress: "0xA" }, { makerAddress: "0xB" }, { makerAddress: "0xC" },
    { makerAddress: "0xA" }, { makerAddress: "0xB" },
  ];
  assert.deepEqual(findConcentratedListers(listings, 3), []);
});

test("findConcentratedListers: flags wallets with ≥ threshold listings", () => {
  const listings = [
    { makerAddress: "0xWall" }, { makerAddress: "0xWall" }, { makerAddress: "0xWall" },
    { makerAddress: "0xOther" }, { makerAddress: "0xWall" },
  ];
  const result = findConcentratedListers(listings, 3);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], ["0xwall", 4]);
});

test("findConcentratedListers: case-insensitive — same wallet across mixed casing counts once", () => {
  const listings = [
    { makerAddress: "0xABCD" }, { makerAddress: "0xabcd" }, { makerAddress: "0xAbCd" },
  ];
  const result = findConcentratedListers(listings, 3);
  assert.equal(result.length, 1);
  assert.equal(result[0][1], 3);
});

test("findConcentratedListers: ignores listings without makerAddress", () => {
  const listings = [
    { makerAddress: null }, { makerAddress: undefined }, {},
    { makerAddress: "0xA" }, { makerAddress: "0xA" },
  ];
  assert.deepEqual(findConcentratedListers(listings, 2), [["0xa", 2]]);
});

test("findConcentratedListers: threshold defaults to 3", () => {
  const listings = [
    { makerAddress: "0xA" }, { makerAddress: "0xA" },
  ];
  assert.deepEqual(findConcentratedListers(listings), [], "two of the same wallet is not yet a wall");
});

// ─── computeBotScore — rate-based bot heuristic ─────────────────────────────
// The function reads events with multiple shape variants (asset_events,
// events, or a bare array) and returns { score, breakdown }. Tests below
// validate signal isolation: each scenario only fires the signal it targets,
// so a regression in one threshold doesn't get masked by another.

// Helper: build N order events spaced `gapSec` apart across `collections`.
function buildEvents({ n = 50, gapSec = 3, collections = ["normies"], type = "order", saleCount = 0 } = {}) {
  const events = [];
  const t0 = Date.parse("2026-01-01T00:00:00Z") / 1000;
  for (let i = 0; i < n; i++) {
    events.push({
      event_type: type,
      event_timestamp: t0 + i * gapSec,
      nft: { collection: collections[i % collections.length] },
    });
  }
  for (let i = 0; i < saleCount; i++) {
    events.push({ event_type: "sale", event_timestamp: t0 + 10_000 + i });
  }
  return { asset_events: events };
}

test("computeBotScore: returns 0 score for an empty payload (no signals can fire)", () => {
  const { score, breakdown } = computeBotScore({ asset_events: [] });
  assert.equal(score, 0);
  assert.deepEqual(breakdown, { rate: 0, cadence: 0, sprawl: 0, cancel: 0, buyThrough: 0 });
});

test("computeBotScore: fires rate + cadence for a sub-5s spammer in one collection", () => {
  // 50 events 3s apart across 1 collection: rate ≈ 1200/hr, median gap 3s.
  // Expected: rate=35, cadence=25, sprawl=0 (only one collection), cancel=0, buyThrough=10 (50 offers, 0 sales).
  const { score, breakdown } = computeBotScore(buildEvents({ n: 50, gapSec: 3 }));
  assert.equal(breakdown.rate, 35, "rate maxes out above 100/hr");
  assert.equal(breakdown.cadence, 25, "median gap <5s maxes cadence");
  assert.equal(breakdown.sprawl, 0, "single collection → sprawl never fires");
  assert.equal(breakdown.buyThrough, 10, "15+ offers and zero sales = buy-through max");
  assert.equal(score, 70);
});

test("computeBotScore: Dan4Play-shape — multi-collection sprawl fires the sprawl signal", () => {
  const { breakdown } = computeBotScore(buildEvents({ n: 50, gapSec: 3, collections: ["a", "b", "c", "d", "e"] }));
  assert.ok(breakdown.sprawl >= 14, "≥5 collections at high rate = strong sprawl signal");
});

test("computeBotScore: a slow, single-collection bidder scores low", () => {
  // 6 events 1 hour apart = ~1/hr, median gap 3600s — below every threshold.
  const { score } = computeBotScore(buildEvents({ n: 6, gapSec: 3600 }));
  assert.equal(score, 0);
});

test("computeBotScore: accepts the bare-array event shape too", () => {
  const arr = buildEvents({ n: 50, gapSec: 3 }).asset_events;
  const { score } = computeBotScore(arr);
  assert.ok(score > 0, "array payload should produce the same scoring path");
});
