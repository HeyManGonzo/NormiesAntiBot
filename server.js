require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY || "";
const OPENSEA_BASE = "https://api.opensea.io/api/v2";
const NORMIES_BASE = "https://api.normies.art";
const NORMIES_SLUG = "normies";
const NORMIES_CONTRACT = "0x9eb6e2025b64f340691e424b7fe7022ffde12438";
// Tiny in-memory cache for NFT metadata so repeated lookups for the same
// token (image + name) don't re-hit OpenSea on every Fetch click.
const nftMetaCache = new Map();
// Cache OpenSea account profiles (username + image) per address. Usernames
// rarely change so a process-lifetime cache is fine and saves a lot of calls
// when fetching the same makers across multiple tokens.
const accountCache = new Map();

// ─── OpenSea helper ───────────────────────────────────────────────────────────
async function osGet(urlPath) {
  const res = await fetch(`${OPENSEA_BASE}${urlPath}`, {
    headers: { "x-api-key": OPENSEA_API_KEY, "accept": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenSea ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Parse OpenSea's `encoded_token_ids` criteria string and decide whether this
// specific token is covered. Accepts:
//   null / "" / "*"      → wildcard (applies to any token) → true
//   "6832"               → single id
//   "1,2,6831:6832,9999" → comma-separated list with optional inclusive ranges
function criteriaMatches(encoded, tokenId) {
  if (!encoded || encoded === "*") return true;
  const idStr = String(tokenId);
  const idNum = Number(tokenId);
  for (const raw of encoded.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    if (part === idStr) return true;
    const sep = part.includes(":") ? ":" : part.includes("-") ? "-" : null;
    if (sep) {
      const [a, b] = part.split(sep).map(Number);
      if (!isNaN(a) && !isNaN(b) && idNum >= a && idNum <= b) return true;
    }
  }
  return false;
}

// ─── Normalizer ───────────────────────────────────────────────────────────────
// OpenSea v2 offer shape (the bits we use):
//   protocol_data.parameters.offer[0].startAmount        → total WETH offered
//   protocol_data.parameters.consideration[0].startAmount → quantity of NFTs wanted
//   price.value                                          → same as offer[0].startAmount
//   criteria.encoded_token_ids                           → "*" | "id" | "1,2,5:7"
//   criteria.trait                                       → trait filter (if any)
// Critical: `price.value` is the TOTAL bid amount, not per-unit. A bid of
// 0.55 WETH for 5 NFTs (consideration startAmount = 5) has a per-unit price
// of 0.11 WETH. OpenSea's UI ranks by per-unit price, so we must too —
// otherwise bulk bids float to the top of our list incorrectly.
function normalizeOffer(o) {
  const price = o.price || {};
  const params = o.protocol_data?.parameters || {};
  const criteria = o.criteria || {};
  const encoded = criteria.encoded_token_ids;
  let type = "collection";
  if (criteria.trait) type = "trait";
  else if (encoded && encoded !== "*") type = "item";
  const totalWei = BigInt(price.value || params.offer?.[0]?.startAmount || "0");
  const qty = BigInt(params.consideration?.[0]?.startAmount || "1");
  const perUnitWei = qty > 0n ? totalWei / qty : totalWei;
  // Offer lifetime — endTime - startTime. Programmatic bidders frequently use
  // very short expirations (10–30 min) so they can re-price as the floor moves
  // without leaving long open exposure; humans accept OpenSea's defaults
  // (typically 7d/30d). We expose this so the frontend can show it as a
  // column and add a small per-row bonus to the bot score for sub-hour offers.
  const startTime = Number(params.startTime) || 0;
  const endTime = Number(params.endTime) || 0;
  const durationSec = startTime && endTime && endTime > startTime
    ? endTime - startTime
    : 0;
  return {
    orderHash: o.order_hash,
    type,
    priceWei: perUnitWei.toString(),
    totalPriceWei: totalWei.toString(),
    quantity: Number(qty),
    currency: price.currency || "WETH",
    decimals: price.decimals ?? 18,
    startTime,
    endTime,
    durationSec,
    makerAddress: (params.offerer || o.maker?.address || "").toLowerCase() || null,
    traitType: criteria.trait?.type ?? null,
    traitValue: criteria.trait?.value ?? null,
    encodedTokenIds: encoded ?? null,
  };
}

// ─── Listing normalizer ───────────────────────────────────────────────────────
// OpenSea v2 listing shape mirrors the offer shape but inverted:
//   protocol_data.parameters.offer[0]            → the NFT being sold (tokenId)
//   protocol_data.parameters.consideration[0]    → the payment item (price)
//   protocol_data.parameters.offerer             → the seller's address
// `price.value` here is the total price for the listing; ERC-721 listings are
// always quantity 1 so per-unit math collapses to the same number.
function normalizeListing(l) {
  const price = l.price?.current || l.price || {};
  const params = l.protocol_data?.parameters || {};
  const offerItem = params.offer?.[0] || {};
  const tokenId = offerItem.identifierOrCriteria || null;
  const priceWei = String(price.value || params.consideration?.[0]?.startAmount || "0");
  const startTime = Number(params.startTime) || 0;
  const endTime = Number(params.endTime) || 0;
  const durationSec = startTime && endTime && endTime > startTime
    ? endTime - startTime
    : 0;
  return {
    orderHash: l.order_hash,
    tokenId: tokenId ? String(tokenId) : null,
    priceWei,
    currency: price.currency || "ETH",
    decimals: price.decimals ?? 18,
    startTime,
    endTime,
    durationSec,
    makerAddress: (params.offerer || l.maker?.address || "").toLowerCase() || null,
  };
}

// ─── Serve static frontend ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, keyConfigured: !!OPENSEA_API_KEY });
});

// ─── Combined offers for a specific Normie token ID ───────────────────────────
// GET /api/offers/:tokenId
// Returns item offers + collection offers merged and sorted by price descending
app.get("/api/offers/:tokenId", async (req, res) => {
  const { tokenId } = req.params;

  if (!OPENSEA_API_KEY) {
    return res.status(500).json({ error: "OPENSEA_API_KEY not configured in .env" });
  }
  if (!/^\d+$/.test(tokenId)) {
    return res.status(400).json({ error: "Token ID must be a number" });
  }

  try {
    // OpenSea's /nfts/{tokenId} endpoint does NOT filter by token id — it
    // returns the whole collection's offer book. We apply two filters:
    //   1. Drop expired offers (endTime <= now)
    //   2. Drop offers whose criteria don't actually cover this token
    // After that we sort by PER-UNIT price (computed in normalizeOffer) so
    // bulk bids like "0.55 WETH for 5 Normies" rank as 0.11 WETH, matching
    // OpenSea's UI ordering instead of floating to the top.
    const data = await osGet(`/offers/collection/${NORMIES_SLUG}/nfts/${tokenId}?limit=100`);
    const raw = data.offers || [];
    const now = Math.floor(Date.now() / 1000);

    const normalized = raw.map(normalizeOffer);
    const afterTime = normalized.filter((o) => o.endTime > now);
    const afterCriteria = afterTime.filter((o) => criteriaMatches(o.encodedTokenIds, tokenId));

    const offers = afterCriteria.sort((a, b) => {
      const pa = Number(BigInt(a.priceWei)) / Math.pow(10, a.decimals);
      const pb = Number(BigInt(b.priceWei)) / Math.pow(10, b.decimals);
      return pb - pa;
    });

    const counts = {
      item: offers.filter((o) => o.type === "item").length,
      collection: offers.filter((o) => o.type === "collection").length,
      trait: offers.filter((o) => o.type === "trait").length,
      raw: raw.length,
      droppedExpired: normalized.length - afterTime.length,
      droppedCriteria: afterTime.length - afterCriteria.length,
    };

    res.json({ offers, tokenId, counts });
  } catch (err) {
    console.error("Offers error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ───  OpenSea proxy: account events (used for bot scoring) ─────────────────────
// Supports pagination so the frontend can fetch a larger window (e.g. 150
// events across 3 pages) — needed for rate-based bot scoring where a single
// 50-event page from a very active wallet only covers a few minutes and
// distorts the activity-rate calculation.
app.get("/api/opensea/events/:address", async (req, res) => {
  const { address } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, 50);
  const pages = Math.min(parseInt(req.query.pages) || 1, 3);
  if (!OPENSEA_API_KEY) {
    return res.status(500).json({ error: "OPENSEA_API_KEY not configured in .env" });
  }
  try {
    const merged = [];
    let next = null;
    for (let i = 0; i < pages; i++) {
      const cursor = next ? `&next=${encodeURIComponent(next)}` : "";
      const data = await osGet(`/events/accounts/${encodeURIComponent(address)}?limit=${limit}${cursor}`);
      const events = data.asset_events || data.events || [];
      merged.push(...events);
      next = data.next || null;
      if (!next || events.length === 0) break;
    }
    res.json({ asset_events: merged, next });
  } catch (err) {
    console.error("Events error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── OpenSea proxy: account profile (username/ENS shown on the bid in OS UI) ──
// Lets the seller eyeball-match a bid in our table to the one on OpenSea
// without having to compare 0x… strings. Cached for the lifetime of the
// process since usernames rarely change.
app.get("/api/opensea/account/:address", async (req, res) => {
  const { address } = req.params;
  if (!OPENSEA_API_KEY) {
    return res.status(500).json({ error: "OPENSEA_API_KEY not configured in .env" });
  }
  const key = address.toLowerCase();
  if (accountCache.has(key)) return res.json(accountCache.get(key));
  try {
    const data = await osGet(`/accounts/${encodeURIComponent(address)}`);
    // OpenSea returns { address, username, profile_image_url, ... }.
    // username may be empty for wallets that never set one — fall back to null
    // so the frontend can decide what to render.
    const out = {
      address: data.address || address,
      username: data.username || null,
      profileImage: data.profile_image_url || null,
    };
    accountCache.set(key, out);
    res.json(out);
  } catch (err) {
    // Don't fail the whole enrichment if a profile lookup 404s — return a
    // null shape and let the frontend fall back to the short address.
    const out = { address, username: null, profileImage: null };
    accountCache.set(key, out);
    res.json(out);
  }
});

// ─── Normies proxy: holdings count ────────────────────────────────────────────
// api.normies.art returns { address, tokenIds: [...] }. We normalise to
// { address, count, tokenIds } so the frontend doesn't need to guess shapes.
app.get("/api/normies/holders/:address", async (req, res) => {
  const { address } = req.params;
  try {
    const response = await fetch(`${NORMIES_BASE}/holders/${encodeURIComponent(address)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error || `HTTP ${response.status}` });
    }
    const tokenIds = Array.isArray(data.tokenIds) ? data.tokenIds : [];
    res.json({ address: data.address || address, count: tokenIds.length, tokenIds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── OpenSea proxy: NFT metadata (image + name) for the preview card ──────────
// Cached in-process; OpenSea's image_url is the IPFS-resolved canonical URL,
// display_image_url is OpenSea's CDN-rendered version (better for browsers).
async function getNftMeta(tokenId) {
  if (nftMetaCache.has(tokenId)) return nftMetaCache.get(tokenId);
  const data = await osGet(
    `/chain/ethereum/contract/${NORMIES_CONTRACT}/nfts/${tokenId}`
  );
  const n = data.nft || {};
  const out = {
    tokenId,
    name: n.name || `Normie #${tokenId}`,
    image: n.display_image_url || n.image_url || null,
    openseaUrl: n.opensea_url || `https://opensea.io/item/ethereum/${NORMIES_CONTRACT}/${tokenId}`,
  };
  nftMetaCache.set(tokenId, out);
  return out;
}
app.get("/api/nft/:tokenId", async (req, res) => {
  const { tokenId } = req.params;
  if (!/^\d+$/.test(tokenId)) {
    return res.status(400).json({ error: "Token ID must be a number" });
  }
  try {
    res.json(await getNftMeta(tokenId));
  } catch (err) {
    console.error("NFT meta error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Normies proxy: burn history ──────────────────────────────────────────────
// api.normies.art returns a raw array of burn-commitments. We normalise to
// { count, burns } so the frontend has a stable shape and can also drill in.
app.get("/api/normies/burns/:address", async (req, res) => {
  const { address } = req.params;
  try {
    const response = await fetch(`${NORMIES_BASE}/history/burns/address/${encodeURIComponent(address)}`);
    const data = await response.json().catch(() => ([]));
    if (!response.ok) {
      return res.status(response.status).json({ error: (data && data.error) || `HTTP ${response.status}` });
    }
    const burns = Array.isArray(data) ? data : [];
    // Tokens burned across all commitments (more meaningful than commit count
    // since one commitment can burn up to 3 Normies).
    const tokensBurned = burns.reduce((sum, b) => sum + (Number(b.tokenCount) || 0), 0);
    res.json({ address, count: burns.length, tokensBurned, burns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ETH/USD spot price (CoinGecko) ───────────────────────────────────────────
// Used by the frontend to show a dollar value next to each WETH offer.
// CoinGecko's free tier allows ~30 req/min without a key; we cache aggressively
// (60s) so a burst of clicks across multiple tokens doesn't hit the rate cap.
// WETH is 1:1 pegged to ETH so the same rate applies to both.
let ethPriceCache = { usd: null, fetchedAt: 0 };
const ETH_PRICE_TTL_MS = 60_000;
app.get("/api/eth-price", async (_req, res) => {
  const now = Date.now();
  if (ethPriceCache.usd && now - ethPriceCache.fetchedAt < ETH_PRICE_TTL_MS) {
    return res.json(ethPriceCache);
  }
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
    );
    const data = await r.json().catch(() => ({}));
    const usd = Number(data?.ethereum?.usd);
    if (!r.ok || !isFinite(usd) || usd <= 0) {
      // Keep serving the stale value if we have one; better than a hard fail.
      if (ethPriceCache.usd) return res.json(ethPriceCache);
      return res.status(502).json({ error: "CoinGecko returned no price" });
    }
    ethPriceCache = { usd, fetchedAt: now };
    res.json(ethPriceCache);
  } catch (err) {
    if (ethPriceCache.usd) return res.json(ethPriceCache);
    res.status(500).json({ error: err.message });
  }
});

// ─── OpenSea proxy: floor listings (10 cheapest active) ───────────────────────
// Powers the "Floor Health" panel — fetches the cheapest listings for the
// Normies collection so the same bot-scoring logic can be applied to the
// sellers, not just the bidders. OpenSea's /best endpoint is NOT deduplicated
// by token id (one token with three listings appears three times) so we over-
// fetch and dedupe to guarantee 10 unique tokens. Cached 60s — the floor
// doesn't churn every second and this is a user-initiated panel, not auto-polled.
let floorCache = { data: null, fetchedAt: 0 };
const FLOOR_TTL_MS = 60_000;
app.get("/api/floor", async (_req, res) => {
  const now = Date.now();
  if (floorCache.data && now - floorCache.fetchedAt < FLOOR_TTL_MS) {
    return res.json(floorCache.data);
  }
  try {
    const data = await osGet(`/listings/collection/${NORMIES_SLUG}/best?limit=30`);
    const raw = data.listings || [];
    const tsNow = Math.floor(Date.now() / 1000);
    const normalized = raw.map(normalizeListing).filter(
      (l) => l.tokenId && l.endTime > tsNow
    );
    // Dedupe by tokenId, keep the cheapest listing per token (the array is
    // already sorted by price ascending so the first occurrence wins).
    const seen = new Set();
    const unique = [];
    for (const l of normalized) {
      if (seen.has(l.tokenId)) continue;
      seen.add(l.tokenId);
      unique.push(l);
      if (unique.length >= 10) break;
    }
    // Enrich each listing with the NFT image/name so the floor table can show
    // a thumbnail per row. Fetched in parallel via the shared nftMetaCache so
    // repeat calls within the cache lifetime cost nothing. Failures are non-
    // fatal — a row without an image just falls back to the placeholder.
    await Promise.all(unique.map(async (l) => {
      try {
        const meta = await getNftMeta(l.tokenId);
        l.image = meta.image;
        l.name = meta.name;
      } catch (_) { /* leave image/name undefined; frontend handles fallback */ }
    }));
    const out = { listings: unique, fetchedAt: now };
    floorCache = { data: out, fetchedAt: now };
    res.json(out);
  } catch (err) {
    if (floorCache.data) return res.json(floorCache.data);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
// Only listen when run directly (`node server.js`). When require()'d from the
// test suite we just want to load the module to access the pure helpers
// exported below — starting a real listener would bind a port and leak it.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  Normies Bot Filter running at http://localhost:${PORT}`);
    if (!OPENSEA_API_KEY) {
      console.warn("  ⚠  OPENSEA_API_KEY is not set — add it to your .env file\n");
    } else {
      console.log("  ✓  OpenSea API key loaded\n");
    }
  });
}

// Default export is the Express `app` itself — Vercel's Node.js runtime
// invokes the file's module.exports as `(req, res) => …` for every request,
// and the Express app object is already a function with that signature.
// Exporting a bare `{…}` object (the previous shape) makes Vercel reject the
// deployment with "The default export must be a function or server."
// The test-only helpers are attached as properties so existing
// `const { normalizeOffer } = require("../server")` destructures still work.
module.exports = app;
module.exports.normalizeOffer = normalizeOffer;
module.exports.normalizeListing = normalizeListing;
module.exports.criteriaMatches = criteriaMatches;