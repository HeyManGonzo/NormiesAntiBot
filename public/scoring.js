// Pure scoring + ranking helpers, shared between the browser bundle and the
// Node test suite. Loaded as a plain <script> in index.html (attaches to
// window.NormiesScoring) and required directly from tests/ as CommonJS.
// Keep this file free of DOM access and network calls so both consumers can
// import the same source of truth.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NormiesScoring = factory();
}(typeof self !== "undefined" ? self : this, function () {

  // ─── Per-offer duration bonus ───────────────────────────────────────────────
  // Up to +10 points added to the maker's base bot score for this specific
  // bid. Per-offer (not per-maker) so the same wallet can show different scores
  // on different rows when their bids have different expirations. Thresholds
  // mirror the explainer panel in the UI.
  function offerDurationPoints(sec) {
    if (!sec || sec <= 0) return 0;
    if (sec < 300) return 10;     // <5m   — almost certainly automated
    if (sec < 1800) return 7;     // <30m  — bot-like
    if (sec < 7200) return 4;     // <2h
    if (sec < 21600) return 1;    // <6h
    return 0;
  }

  // ─── Heuristic bot score (0–100) from OpenSea account events ────────────────
  // Returns { score, breakdown }. The previous count-based version under-scored
  // wallets like Dan4Play that fire offers across many collections every few
  // seconds; this version is rate-based — events/hr, inter-event cadence, and
  // collection sprawl over the same window. Sub-minute cadence across multiple
  // collections is the fingerprint we want to catch.
  //
  // Signals (max points):
  //   • Activity rate              (35)
  //   • Inter-event cadence        (25)
  //   • Collection sprawl / hour   (20)
  //   • Cancel ratio               (10)
  //   • No purchases despite       (10)
  //     heavy bidding
  function computeBotScore(eventsPayload) {
    const events =
      eventsPayload.asset_events ||
      eventsPayload.events ||
      (Array.isArray(eventsPayload) ? eventsPayload : []);

    let offerCount = 0;
    let cancelCount = 0;
    let saleCount = 0;
    const collections = new Set();
    const timestamps = [];

    for (const e of events) {
      const type = (e.event_type || e.type || "").toLowerCase();
      const slug =
        (e.nft && e.nft.collection) ||
        (e.asset && e.asset.collection && e.asset.collection.slug) ||
        e.collection ||
        e.collection_slug;
      const isOffer = type === "order" || type === "offer" || type === "order_made";
      const isCancel = type === "cancel" || type === "order_cancelled";
      const isSale = type === "sale" || type === "successful";
      if (isOffer) offerCount++;
      else if (isCancel) cancelCount++;
      else if (isSale) saleCount++;
      if (isOffer || isCancel) {
        if (slug) collections.add(slug);
        const ts = e.event_timestamp || e.created_date || e.closing_date;
        if (ts) {
          const t = typeof ts === "number" ? ts * 1000 : new Date(ts).getTime();
          if (!isNaN(t)) timestamps.push(t);
        }
      }
    }

    timestamps.sort((a, b) => a - b);
    const spanMs = timestamps.length >= 2
      ? timestamps[timestamps.length - 1] - timestamps[0]
      : 0;
    // Guard against a same-timestamp batch op — treat as 1 minute so a burst
    // of 50 simultaneous orders still yields a huge rate (the right signal).
    const spanHours = Math.max(spanMs / 3_600_000, 1 / 60);
    const eventsPerHour = timestamps.length >= 5 ? timestamps.length / spanHours : 0;
    const collectionsPerHour = timestamps.length >= 5 ? collections.size / spanHours : 0;
    let medianGapSec = Infinity;
    if (timestamps.length >= 5) {
      const gaps = [];
      for (let i = 1; i < timestamps.length; i++) {
        gaps.push((timestamps[i] - timestamps[i - 1]) / 1000);
      }
      gaps.sort((a, b) => a - b);
      medianGapSec = gaps[Math.floor(gaps.length / 2)];
    }

    const breakdown = { rate: 0, cadence: 0, sprawl: 0, cancel: 0, buyThrough: 0 };
    if (eventsPerHour > 100) breakdown.rate = 35;
    else if (eventsPerHour > 30) breakdown.rate = 25;
    else if (eventsPerHour > 10) breakdown.rate = 12;
    else if (eventsPerHour > 3) breakdown.rate = 4;
    if (medianGapSec < 5) breakdown.cadence = 25;
    else if (medianGapSec < 20) breakdown.cadence = 15;
    else if (medianGapSec < 60) breakdown.cadence = 8;
    if (collections.size >= 3) {
      if (collectionsPerHour > 20) breakdown.sprawl = 20;
      else if (collectionsPerHour > 8) breakdown.sprawl = 14;
      else if (collectionsPerHour > 3) breakdown.sprawl = 7;
    }
    const cancelRatio = cancelCount / Math.max(offerCount, 1);
    if (cancelRatio > 0.7) breakdown.cancel = 10;
    else if (cancelRatio > 0.4) breakdown.cancel = 5;
    if (offerCount > 15 && saleCount === 0) breakdown.buyThrough = 10;
    else if (offerCount > 15 && saleCount / offerCount < 0.05) breakdown.buyThrough = 5;

    const score = Math.min(
      breakdown.rate + breakdown.cadence + breakdown.sprawl + breakdown.cancel + breakdown.buyThrough,
      100
    );
    return { score, breakdown };
  }

  // ─── "Safest first" comparator for the offers table ─────────────────────────
  // Sorts ascending by adjusted score (lower = more human-like), with price
  // desc as tiebreak so high human bids beat low human bids when they tie.
  // Offers without an _adjustedScore (still loading) sink to the bottom via
  // the 999 sentinel — better than mixing them into the human-bid band.
  function compareOffersBySafety(a, b) {
    const sa = typeof a._adjustedScore === "number" ? a._adjustedScore : 999;
    const sb = typeof b._adjustedScore === "number" ? b._adjustedScore : 999;
    if (sa !== sb) return sa - sb;
    return Number(b.priceWei) - Number(a.priceWei);
  }

  // ─── Floor concentration ────────────────────────────────────────────────────
  // Returns the wallets that hold ≥ threshold of the supplied listings, as
  // [address, count] pairs. Used to flag a single seller stacking multiple of
  // the cheapest listings — a classic floor-wall pattern.
  function findConcentratedListers(listings, threshold = 3) {
    const counts = new Map();
    for (const l of listings) {
      if (!l || !l.makerAddress) continue;
      const k = String(l.makerAddress).toLowerCase();
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n >= threshold);
  }

  return { offerDurationPoints, computeBotScore, compareOffersBySafety, findConcentratedListers };
}));
