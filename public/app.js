// Normies Offer Desk — frontend logic.
// Fetches offers for a given Normie token ID, then enriches the top 5 unique
// makers with OpenSea activity (for bot scoring) and Normies API holdings/burns.

const DISPLAY_TOP_N = 10;
// We enrich every displayed row — bot scoring is only useful if it's
// applied to all the offers a seller might reasonably accept.
const ENRICH_TOP_N = DISPLAY_TOP_N;
const NORMIES_CONTRACT = "0x9eb6e2025b64f340691e424b7fe7022ffde12438";

// Pure scoring/ranking helpers live in scoring.js (loaded just before this
// file in index.html) so the same logic can be unit-tested under Node without
// dragging in DOM globals. See public/scoring.js + tests/scoring.test.js.
const { offerDurationPoints, computeBotScore, compareOffersBySafety, findConcentratedListers } = window.NormiesScoring;

// Inline SVG used when an NFT has no image_url or the image fails to load.
// Encoded as a data URI so it works offline and never 404s. Matches the
// dark panel palette so the card still looks intentional rather than broken.
// Note: use the bare "data:image/svg+xml," form — the "+utf8" shorthand is
// non-standard and is rejected by some Chromium builds, leaving the broken
// image icon visible. Kept on one line and minified to avoid any encoding
// edge cases with whitespace.
const NFT_PLACEHOLDER =
  "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">' +
      '<rect width="96" height="96" rx="8" fill="#1f232c"/>' +
      '<path d="M20 68 L40 44 L54 60 L66 48 L80 68 Z" fill="#2a2f3a"/>' +
      '<circle cx="64" cy="32" r="6" fill="#2a2f3a"/>' +
      '<text x="48" y="86" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#8b93a7">no image</text>' +
    '</svg>'
  );

const fetchBtn = document.getElementById("fetchBtn");
const refreshBtn = document.getElementById("refreshBtn");
const freshnessEl = document.getElementById("freshness");
const tokenIdInput = document.getElementById("tokenId");
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const tableEl = document.getElementById("offerTable");
const bodyEl = document.getElementById("offerBody");
const nftCardEl = document.getElementById("nftCard");
const nftImageEl = document.getElementById("nftImage");
const nftNameEl = document.getElementById("nftName");
const nftMetaEl = document.getElementById("nftMeta");
const nftLinkEl = document.getElementById("nftLink");
const ctaBlockEl = document.getElementById("ctaBlock");
const ctaButtonEl = document.getElementById("ctaButton");
const sortModeEl = document.getElementById("sortMode");
const hideBotsEl = document.getElementById("hideBots");
const floorBtn = document.getElementById("floorBtn");
const floorStatusEl = document.getElementById("floorStatus");
const floorBannerEl = document.getElementById("floorBanner");
const floorTableEl = document.getElementById("floorTable");
const floorBodyEl = document.getElementById("floorBody");
const floorEmptyEl = document.getElementById("floorEmpty");

// Prime the preview img with the placeholder so the browser never has to
// resolve an empty src (which renders the broken-icon glyph).
nftImageEl.src = NFT_PLACEHOLDER;

// Persist whether each "primed" CTA has been used in this browser, so a
// returning user sees the calm default style instead of being re-prompted to
// do something they already know how to do. Keys live under a "normies:"
// prefix so they don't collide with other apps running on localhost.
const FETCH_DEMOTED_KEY = "normies:fetchDemoted";
const FLOOR_DEMOTED_KEY = "normies:floorDemoted";
// Restore demoted state synchronously on boot — before any user-visible
// interaction — so the button never flashes its pulsing state and then
// snaps to grey. NormiesUi.demoteCta is idempotent, so it's safe even on a
// freshly-loaded button that doesn't have the primed class yet.
if (NormiesUi.readDemoted(window.localStorage, FETCH_DEMOTED_KEY)) {
  NormiesUi.demoteCta(fetchBtn, { primedClass: "fetch-cta" });
}
if (NormiesUi.readDemoted(window.localStorage, FLOOR_DEMOTED_KEY)) {
  NormiesUi.demoteCta(floorBtn, {
    primedClass: "floor-cta",
    demotedClass: "refresh-btn",
    text: "Refresh",
    title: "Re-fetch the 10 cheapest listings (cached for 60s on the server).",
    hideEl: floorEmptyEl,
  });
}

// Track the most recently fetched token so the Refresh button can re-run
// against the same id without depending on what's currently in the input
// (the seller may be typing a new id while wanting to re-check the old one).
let currentTokenId = null;
let lastFetchedAt = 0;
let freshnessTimer = null;

// Per-maker enrichment cache. Refreshes typically see the same maker set
// (a handful of repeat bidders) so reusing recent enrichment cuts ~50 API
// calls down to ~10 on a typical refresh. 5-minute TTL — bot scores, holds,
// and burns don't change fast enough to matter on a tighter window.
const MAKER_CACHE_TTL_MS = 5 * 60 * 1000;
const makerCache = new Map(); // key: lowercased address → { data, fetchedAt }

// View state for the offers table. `allOffers` is the full server response
// (top-N after slicing); `applyViewState` derives what's actually rendered
// based on the sort dropdown and the "hide bots" checkbox. Promoted to
// module scope so the change handlers and the enrichment finisher can both
// trigger a re-render without re-hitting the network.
const state = { allOffers: [] };

fetchBtn.addEventListener("click", () => loadOffers());
refreshBtn.addEventListener("click", () => loadOffers({ isRefresh: true }));
tokenIdInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadOffers();
});
sortModeEl.addEventListener("change", applyViewState);
hideBotsEl.addEventListener("change", applyViewState);
floorBtn.addEventListener("click", () => loadFloor());

// Theme toggle — the initial theme is applied by the inline <head> script
// before paint to avoid a flash; this just handles user-driven flips and
// persists the choice. Glyph mirrors the *current* theme (sun in light mode,
// moon in dark) rather than the destination, which matches macOS / Windows.
const themeToggle = document.getElementById("themeToggle");
function syncThemeToggle() {
  const theme = document.documentElement.dataset.theme || "dark";
  themeToggle.textContent = theme === "light" ? "☀" : "☾";
}
syncThemeToggle();
themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch (_) { /* ignore */ }
  syncThemeToggle();
});

async function loadOffers(opts = {}) {
  const isRefresh = !!opts.isRefresh;
  // On refresh, re-run against the last successfully fetched token rather
  // than whatever is currently in the input box (the seller may be typing
  // a new id but still wanting to re-check the previous one).
  const tokenId = isRefresh
    ? currentTokenId
    : tokenIdInput.value.trim();
  if (!tokenId || !/^\d+$/.test(tokenId)) {
    setStatus("Please enter a valid token ID", "error");
    return;
  }

  setStatus(isRefresh ? "Refreshing offers…" : "Fetching offers…", "info");
  fetchBtn.disabled = true;
  refreshBtn.disabled = true;
  if (!isRefresh) {
    // Full reset only on a fresh fetch — refreshes keep the NFT card and
    // existing table visible so the page doesn't flash blank.
    tableEl.hidden = true;
    nftCardEl.hidden = true;
    ctaBlockEl.hidden = true;
    bodyEl.innerHTML = "";
    summaryEl.textContent = "";
    // NFT image/name never change for a given token, so skip the re-fetch
    // on refresh — saves one API call and avoids a brief preview flash.
    loadNftPreview(tokenId);
  }

  // Refresh the ETH/USD rate in parallel so renderRows has it when offers
  // come back. Non-blocking — if it fails the USD column just shows "—".
  ensureEthPrice();

  // Wire the CTA button to this Normie's OpenSea item page. Shown alongside
  // the offers because OpenSea has no deep link to a specific bid.
  ctaButtonEl.href = `https://opensea.io/item/ethereum/${NORMIES_CONTRACT}/${tokenId}`;

  try {
    const data = await fetchJson(`/api/offers/${tokenId}`);
    const offers = data.offers || [];

    if (offers.length === 0) {
      setStatus("No offers found for this Normie.", "info");
      // Still stamp the timestamp so the seller can see when we last checked.
      currentTokenId = tokenId;
      markFetched();
      return;
    }

    const shown = offers.slice(0, DISPLAY_TOP_N);
    const enrichCount = Math.min(
      ENRICH_TOP_N,
      new Set(shown.slice(0, ENRICH_TOP_N).map((o) => o.makerAddress)).size
    );
    const c = data.counts || {};
    const dropParts = [];
    if (c.droppedExpired) dropParts.push(`${c.droppedExpired} expired`);
    if (c.droppedCriteria) dropParts.push(`${c.droppedCriteria} off-token`);
    const dropNote = dropParts.length ? ` · hid ${dropParts.join(", ")}` : "";
    const moreNote = offers.length > shown.length
      ? ` · showing top ${shown.length} of ${offers.length}`
      : "";
    summaryEl.innerHTML =
      `<strong>${offers.length}</strong> offers for Normie #${data.tokenId} ` +
      `· ${c.item || 0} item · ${c.collection || 0} collection · ${c.trait || 0} trait` +
      `${dropNote}${moreNote} · enriching top ${enrichCount} makers…`;

    // Stash the full top-N for re-rendering when the sort/filter controls
    // change. Render once now via applyViewState so the initial paint already
    // honours the current dropdown/checkbox state (e.g. if the user toggled
    // "Hide bot-like" before clicking Fetch).
    state.allOffers = shown;
    applyViewState();
    tableEl.hidden = false;
    ctaBlockEl.hidden = false;
    setStatus("", "info");

    await enrichTopMakers(shown);
    // Re-render once enrichment is in so "Safest first" / "Hide bot-like"
    // reflect the scores we just learned. applyViewState re-paints from
    // the maker cache so no extra network calls happen.
    applyViewState();
    setStatus("Done.", "success");
    summaryEl.innerHTML = summaryEl.innerHTML.replace(/· enriching .*$/, "· enrichment complete");
    currentTokenId = tokenId;
    markFetched();
  } catch (err) {
    console.error(err);
    setStatus("Error: " + err.message, "error");
  } finally {
    fetchBtn.disabled = false;
    refreshBtn.disabled = false;
  }
}

// Called after every successful fetch/refresh. Stamps the time, reveals the
// Refresh button, demotes the primed Fetch CTA (the user has now discovered
// the action — no need to keep pulsing), and (re)starts the freshness ticker
// so the seller can see at a glance how stale the displayed offers are.
function markFetched() {
  lastFetchedAt = Date.now();
  refreshBtn.hidden = false;
  freshnessEl.hidden = false;
  demoteFetchCta();
  updateFreshness();
  if (freshnessTimer) clearInterval(freshnessTimer);
  freshnessTimer = setInterval(updateFreshness, 1000);
}

// Render the "Updated Ns ago" label and apply a colour class based on age.
// Thresholds match the rule of thumb that OpenSea offers can churn within
// a minute or two during active trading.
function updateFreshness() {
  if (!lastFetchedAt) return;
  const ageMs = Date.now() - lastFetchedAt;
  const ageSec = Math.floor(ageMs / 1000);
  let label;
  if (ageSec < 60) label = `Updated ${ageSec}s ago`;
  else if (ageSec < 3600) label = `Updated ${Math.floor(ageSec / 60)}m ago`;
  else label = `Updated ${Math.floor(ageSec / 3600)}h ago`;
  freshnessEl.textContent = label;
  freshnessEl.classList.remove("fresh-warn", "fresh-stale");
  if (ageMs >= 3 * 60 * 1000) freshnessEl.classList.add("fresh-stale");
  else if (ageMs >= 60 * 1000) freshnessEl.classList.add("fresh-warn");
}

// Build the Type cell. Badge text is always the bare type word
// ("item" / "collection" / "trait") so the column stays compact and
// scannable. The hover tooltip explains what that type means in plain
// English, and for trait offers it includes the specific trait=value
// the bidder is targeting when OpenSea exposes it.
function renderTypeCell(offer) {
  const t = offer.type;
  let title = "";
  if (t === "trait") {
    if (offer.traitValue) {
      const tt = offer.traitType ? `${offer.traitType} = ` : "";
      title = `Trait offer — the bidder will buy any Normie where ${tt}${offer.traitValue}.`;
    } else {
      title = "Trait offer — the bidder will buy any Normie matching a specific trait (e.g. Background = Blue).";
    }
  } else if (t === "item") {
    title = "Item offer — the bidder is targeting this specific Normie (or a small list of token IDs).";
  } else if (t === "collection") {
    title = "Collection offer — the bidder will buy any Normie from the collection at this price.";
  }
  return `<span class="badge badge-${t}" title="${escapeHtml(title)}">${t}</span>`;
}

// Derive the currently-visible offer list from state.allOffers using the
// sort/filter controls, render it, and re-paint enrichment from the maker
// cache so previously-fetched scores/holds/burns survive the re-render.
// Called on every control change and once after enrichment completes.
function applyViewState() {
  if (!state.allOffers.length) return;
  let visible = state.allOffers.slice();
  // Filter: hide rows whose adjusted score is ≥70. Rows that haven't been
  // scored yet (still loading) are treated as "not bot" so they stay
  // visible — better to leave a maybe-bot in than to hide a possibly-good bid.
  if (hideBotsEl.checked) {
    visible = visible.filter(
      (o) => !(typeof o._adjustedScore === "number" && o._adjustedScore >= 70)
    );
  }
  // Sort: default mirrors the server's price-desc ordering; "safest" sorts
  // adjusted score ascending with price desc as tiebreak so high human bids
  // beat low human bids when both score the same.
  if (sortModeEl.value === "safest") visible.sort(compareOffersBySafety);
  renderRows(visible);
  // Repaint enrichment cells from cache without re-hitting the network.
  const seen = new Set();
  for (const o of visible) {
    const addr = o.makerAddress;
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const cached = makerCache.get(key);
    if (cached) applyMakerEnrichment(addr, cached.data);
  }
}

function renderRows(offers) {
  bodyEl.innerHTML = "";
  // Per-unit price of the top offer (offers are already sorted desc by the
  // server), used to compute the percentage below for the rest of the list.
  const topPerUnit = offers.length
    ? Number(offers[0].priceWei) / Math.pow(10, offers[0].decimals || 18)
    : 0;
  offers.forEach((offer, i) => {
    const rank = i + 1;
    const perUnit = Number(offer.priceWei) / Math.pow(10, offer.decimals || 18);
    const price = formatPrice(offer.priceWei, offer.decimals);
    const qty = offer.quantity > 1 ? ` <span class="qty">× ${offer.quantity}</span>` : "";
    // USD value of the per-unit price (matches OpenSea's UI which shows USD on
    // the per-unit, not the total). Falls back to "—" if the rate isn't loaded.
    const usd = ethUsdPrice ? perUnit * ethUsdPrice : null;
    const usdCell = usd != null
      ? `<span class="usd">($${formatUsd(usd)})</span>`
      : "";
    // Delta from the top offer. Rank 1 gets "top"; everything else shows the
    // negative percentage so the seller can see at a glance how far below the
    // best bid each subsequent offer is.
    let deltaCell;
    if (rank === 1 || topPerUnit === 0) {
      deltaCell = `<span class="delta delta-top">top</span>`;
    } else {
      const pct = ((perUnit - topPerUnit) / topPerUnit) * 100;
      const cls = pct <= -20 ? "delta-far" : pct <= -5 ? "delta-mid" : "delta-near";
      deltaCell = `<span class="delta ${cls}">${pct.toFixed(1)}%</span>`;
    }
    const maker = offer.makerAddress || "";
    const makerShort = maker ? `${maker.slice(0, 6)}…${maker.slice(-4)}` : "—";
    const enriched = rank <= ENRICH_TOP_N;
    const durSec = Number(offer.durationSec) || 0;
    const durCell = `<span class="dur ${durationClass(durSec)}" title="${escapeHtml(durationTitle(durSec))}">${formatDuration(durSec)}</span>`;
    const tr = document.createElement("tr");
    if (maker) tr.dataset.maker = maker.toLowerCase();
    if (durSec) tr.dataset.durationSec = String(durSec);
    tr.innerHTML = `
      <td>${rank}</td>
      <td class="num">
        <div class="price-main">${price} ${offer.currency}${qty}</div>
        <div class="price-sub">${usdCell} ${deltaCell}</div>
      </td>
      <td>${renderTypeCell(offer)}</td>
      <td class="duration">${durCell}</td>
      <td class="maker">${maker
        ? `<a href="https://opensea.io/${maker}" target="_blank" rel="noopener">
             <span class="maker-name">${makerShort}</span>
           </a>`
        : "—"}</td>
      <td class="num holds">${enriched ? "…" : "—"}</td>
      <td class="num burns">${enriched ? "…" : "—"}</td>
      <td class="num bot-score">${enriched ? "…" : "—"}</td>
    `;
    bodyEl.appendChild(tr);
  });
}

// ─── Offer-duration helpers ───────────────────────────────────────────────────
// Lifetime of a single offer (endTime - startTime). Surfaced as its own column
// and folded into the per-row bot score: sub-hour expirations are the textbook
// "bot fingerprint" — they re-price as the floor moves rather than leaving
// long open exposure. Humans almost always take OpenSea's 7d/30d defaults.
function formatDuration(sec) {
  if (!sec || sec <= 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}
function durationClass(sec) {
  if (!sec) return "";
  if (sec < 3600) return "dur-short";   // <1h — bot-like
  if (sec < 86400) return "dur-mid";    // 1h–24h — unusual
  return "dur-long";                    // ≥24h — typical human
}
function durationTitle(sec) {
  if (!sec) return "Offer expiration unknown.";
  if (sec < 3600) return "Very short expiry (<1h) — common bot fingerprint, re-priced as the floor moves.";
  if (sec < 86400) return "Short expiry (<24h) — unusual for human bidders who typically use OpenSea's 7d/30d defaults.";
  return "Typical OpenSea default expiry.";
}
// offerDurationPoints lives in scoring.js — destructured at the top of this file.

// Format a USD value: < $10 keeps 2 decimals, < $1000 keeps 2 decimals with
// thousands separator, >= $1000 drops to whole dollars to save horizontal space.
function formatUsd(v) {
  if (v < 1000) return v.toFixed(2);
  return Math.round(v).toLocaleString("en-US");
}

// Module-level ETH/USD rate. Populated by ensureEthPrice() on first fetch and
// reused for the lifetime of the page; refreshed if older than 5 minutes.
let ethUsdPrice = null;
let ethUsdFetchedAt = 0;
const ETH_PRICE_STALE_MS = 5 * 60 * 1000;
async function ensureEthPrice() {
  if (ethUsdPrice && Date.now() - ethUsdFetchedAt < ETH_PRICE_STALE_MS) return;
  try {
    const data = await fetchJson("/api/eth-price");
    if (data && Number(data.usd) > 0) {
      ethUsdPrice = Number(data.usd);
      ethUsdFetchedAt = Date.now();
    }
  } catch (err) {
    console.warn("ETH price fetch failed:", err.message);
  }
}

// Map a 0–100 score to a short risk label that mirrors the legend in the
// "About the Bot score" panel.
function riskLabel(score) {
  if (score >= 70) return "bot-like";
  if (score >= 40) return "suspicious";
  return "likely human";
}

// Fetch the NFT's image + name from our /api/nft proxy and render the preview
// card. Runs in parallel with the offers fetch; failures are non-fatal — we
// just keep the card hidden so the rest of the page still works.
async function loadNftPreview(tokenId) {
  try {
    const nft = await fetchJson(`/api/nft/${tokenId}`);
    nftNameEl.textContent = nft.name || `Normie #${tokenId}`;
    nftMetaEl.textContent = `Token ID ${tokenId} · Normies (ERC-721)`;
    nftLinkEl.href = nft.openseaUrl || `https://opensea.io/item/ethereum/${NORMIES_CONTRACT}/${tokenId}`;
    nftImageEl.alt = nft.name || `Normie #${tokenId}`;
    // If OpenSea didn't return an image, use the placeholder up front.
    // If the URL is present but broken (404, CORS, slow CDN), fall back
    // on the error event. Null out onerror after swapping so we don't
    // loop if the placeholder itself ever fails to decode.
    if (nft.image) {
      nftImageEl.onerror = () => {
        nftImageEl.onerror = null;
        nftImageEl.src = NFT_PLACEHOLDER;
      };
      nftImageEl.src = nft.image;
    } else {
      nftImageEl.src = NFT_PLACEHOLDER;
    }
    nftCardEl.hidden = false;
  } catch (err) {
    console.warn("NFT preview failed:", err.message);
    // Still show the card with the placeholder so the layout doesn't jump.
    nftImageEl.src = NFT_PLACEHOLDER;
    nftNameEl.textContent = `Normie #${tokenId}`;
    nftMetaEl.textContent = `Token ID ${tokenId} · Normies (ERC-721)`;
    nftLinkEl.href = `https://opensea.io/item/ethereum/${NORMIES_CONTRACT}/${tokenId}`;
    nftCardEl.hidden = false;
  }
}

function formatPrice(wei, decimals) {
  if (!wei) return "0";
  const v = Number(wei) / Math.pow(10, decimals || 18);
  if (!isFinite(v)) return "?";
  return v.toFixed(4);
}

async function enrichTopMakers(offers) {
  const seen = new Set();
  const tasks = [];
  for (const offer of offers.slice(0, ENRICH_TOP_N)) {
    const addr = offer.makerAddress;
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push(enrichMaker(addr));
  }
  await Promise.all(tasks);
}

async function enrichMaker(address) {
  const key = address.toLowerCase();
  // Reuse a recent enrichment if we have one — typical refresh hits the
  // same makers so this avoids re-running ~5 API calls per maker.
  const cached = makerCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < MAKER_CACHE_TTL_MS) {
    applyMakerEnrichment(address, cached.data);
    return;
  }

  const [events, holders, burns, account] = await Promise.allSettled([
    // 3 pages × 50 events = up to 150 events. Needed so rate-based signals
    // (events/hour, median gap) have a meaningful sample on highly active
    // wallets — a single 50-event page can cover only a few minutes for bots.
    fetchJson(`/api/opensea/events/${address}?limit=50&pages=3`),
    fetchJson(`/api/normies/holders/${address}`),
    fetchJson(`/api/normies/burns/${address}`),
    fetchJson(`/api/opensea/account/${address}`),
  ]);

  // computeBotScore now returns { score, breakdown } so we can render a
  // per-signal mini bar. null when the events call itself failed.
  const result = events.status === "fulfilled" ? computeBotScore(events.value) : null;
  const score = result ? result.score : null;
  const breakdown = result ? result.breakdown : null;
  // Server normalises both endpoints to a `.count` field (see server.js).
  const holdsCount = holders.status === "fulfilled" ? holders.value.count : null;
  // For burns we prefer "tokens burned" over "commit count" since one
  // burn commitment can wrap up to 3 Normies — tokens burned is the
  // collector-loyalty signal we actually care about.
  const burnsCount = burns.status === "fulfilled"
    ? (burns.value.tokensBurned ?? burns.value.count)
    : null;
  const username = account.status === "fulfilled" ? account.value.username : null;

  const data = { score, breakdown, holdsCount, burnsCount, username };
  makerCache.set(key, { data, fetchedAt: Date.now() });
  applyMakerEnrichment(address, data);
}

// ─── Mini score-breakdown bar ─────────────────────────────────────────────────
// Inline visualisation of which signals contributed to the bot score, so the
// seller doesn't have to guess why e.g. Dan4play scores 70 despite holding
// Normies. Each segment's width is proportional to its max possible points;
// the inner fill shows how much of that max was scored, coloured green→red.
const SIGNAL_DEFS = [
  { key: "rate",       max: 35, label: "Activity rate" },
  { key: "cadence",    max: 25, label: "Cadence" },
  { key: "sprawl",     max: 20, label: "Collection sprawl" },
  { key: "cancel",     max: 10, label: "Cancel ratio" },
  { key: "buyThrough", max: 10, label: "No purchases" },
  { key: "duration",   max: 10, label: "Short expiry (this bid)" },
];
const SIGNAL_TOTAL = SIGNAL_DEFS.reduce((s, d) => s + d.max, 0); // 110

function renderScoreBar(breakdown, durationPoints) {
  const vals = { ...(breakdown || {}), duration: durationPoints || 0 };
  const tipParts = SIGNAL_DEFS.map(s => `${s.label}: ${vals[s.key] || 0}/${s.max}`);
  const segs = SIGNAL_DEFS.map(s => {
    const pts = vals[s.key] || 0;
    const segWidth = (s.max / SIGNAL_TOTAL) * 100;
    const ratio = Math.max(0, Math.min(pts / s.max, 1));
    const fillPct = ratio * 100;
    // 120° hue (green) at 0 fill → 0° (red) at full. Empty fills stay transparent
    // and the segment shows just its dark background, so unfired signals are
    // visibly distinguishable from low-fired ones.
    const hue = Math.round(120 - 120 * ratio);
    const color = pts > 0 ? `hsl(${hue}, 65%, 50%)` : "transparent";
    return `<div class="seg" style="width:${segWidth.toFixed(2)}%" title="${escapeHtml(s.label)}: ${pts}/${s.max}">` +
           `<div class="seg-fill" style="width:${fillPct.toFixed(2)}%;background:${color}"></div>` +
           `</div>`;
  }).join("");
  return `<div class="score-bar" title="${escapeHtml(tipParts.join("\n"))}">${segs}</div>`;
}

// Apply previously-fetched enrichment data to every row matching this maker.
// Split out from enrichMaker so cached entries can re-paint freshly-rendered
// rows on refresh without re-running the network calls. Also stamps the
// adjusted (maker + duration) score onto matching offer objects in
// state.allOffers so the sort/filter controls have something to read.
function applyMakerEnrichment(address, data) {
  const { score, breakdown, holdsCount, burnsCount, username } = data;
  const shortAddr = `${address.slice(0, 6)}…${address.slice(-4)}`;
  const keyAddr = address.toLowerCase();
  // Stash the adjusted score on every matching offer in state so sort/filter
  // can read it. The same maker can appear on multiple offers with different
  // durations, so each gets its own per-row score.
  if (score !== null && score !== undefined) {
    for (const o of state.allOffers) {
      if (o.makerAddress && o.makerAddress.toLowerCase() === keyAddr) {
        const durPts = offerDurationPoints(Number(o.durationSec) || 0);
        o._adjustedScore = Math.min(score + durPts, 100);
      }
    }
  }
  const rows = document.querySelectorAll(`tr[data-maker="${keyAddr}"]`);
  rows.forEach((row) => {
    row.querySelector(".holds").textContent = holdsCount ?? "?";
    row.querySelector(".burns").textContent = burnsCount ?? "?";
    // Swap the maker cell to show username + short address when OpenSea has
    // one on file — matches how the bid appears in OpenSea's UI so a seller
    // can identify it at a glance.
    if (username) {
      const a = row.querySelector(".maker a");
      if (a) {
        a.innerHTML =
          `<span class="maker-name">${escapeHtml(username)}</span>` +
          `<span class="maker-addr">${shortAddr}</span>`;
      }
    }
    const cell = row.querySelector(".bot-score");
    // Clear any stale risk class from a previous render before applying the
    // new one (cache replay onto a fresh row starts clean, but belt-and-braces).
    cell.classList.remove("risk-low", "risk-med", "risk-high");
    if (score === null) {
      cell.textContent = "?";
    } else {
      // Per-row score = per-maker rate score + this row's offer-duration bonus.
      // Same maker can show slightly different scores on different rows if
      // their bids have different expirations — which is the point.
      const durSec = Number(row.dataset.durationSec) || 0;
      const durPts = offerDurationPoints(durSec);
      const rowScore = Math.min(score + durPts, 100);
      const cls = rowScore >= 70 ? "risk-high" : rowScore >= 40 ? "risk-med" : "risk-low";
      cell.innerHTML =
        `<div class="score-head">${rowScore} <span class="label">${riskLabel(rowScore)}</span></div>` +
        renderScoreBar(breakdown, durPts);
      cell.classList.add(cls);
    }
  });
}

// Minimal HTML escape for usernames — OpenSea allows odd characters in
// display names so we sanitise before injecting into innerHTML.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function fetchJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// computeBotScore lives in scoring.js — destructured at the top of this file.

function setStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = type ? "status-" + type : "";
}

// ─── Floor Health panel ───────────────────────────────────────────────────────
// Behind a "Check the floor" button so a seller checking a single token's
// offers doesn't pay for ~30+ OpenSea calls they didn't ask for. Backend
// already dedupes by tokenId and trims to 10; this function renders, runs
// enrichment via the existing makerCache (so a lister that's also bidding on
// the seller's token gets scored once), and flags wallet concentration.
async function loadFloor() {
  floorBtn.disabled = true;
  floorStatusEl.hidden = false;
  floorStatusEl.textContent = "Fetching floor…";
  try {
    const data = await fetchJson("/api/floor");
    const listings = data.listings || [];
    // Successful response — demote the primed CTA to the standard refresh
    // affordance and drop the empty-state hint. Done before the empty-array
    // early-return so "no listings found" still counts as a completed action.
    demoteFloorCta();
    if (!listings.length) {
      floorStatusEl.textContent = "No active listings found.";
      floorTableEl.hidden = true;
      floorBannerEl.hidden = true;
      return;
    }
    renderFloorRows(listings);
    renderConcentrationBanner(listings);
    floorTableEl.hidden = false;
    floorStatusEl.textContent = `Enriching ${new Set(listings.map(l => l.makerAddress).filter(Boolean)).size} listers…`;
    // Reuse the offers-side enrichment — same maker cache, so a wallet that
    // also bid on the current token only pays one round of API calls.
    const seen = new Set();
    const tasks = [];
    for (const l of listings) {
      const addr = l.makerAddress;
      if (!addr) continue;
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push(enrichMaker(addr));
    }
    await Promise.all(tasks);
    floorStatusEl.textContent = "Done.";
  } catch (err) {
    console.error(err);
    floorStatusEl.textContent = "Error: " + err.message;
  } finally {
    floorBtn.disabled = false;
  }
}

// One-shot transition from the prominent "Check the floor" CTA to the muted
// "Refresh" button. Delegates the DOM mutation to NormiesUi.demoteCta (shared
// helper, unit-tested) and persists the demotion so the user isn't re-prompted
// on their next visit. Returns void; idempotent via the helper's primed-class
// guard.
function demoteFloorCta() {
  const changed = NormiesUi.demoteCta(floorBtn, {
    primedClass: "floor-cta",
    demotedClass: "refresh-btn",
    text: "Refresh",
    title: "Re-fetch the 10 cheapest listings (cached for 60s on the server).",
    hideEl: floorEmptyEl,
  });
  if (changed) NormiesUi.writeDemoted(window.localStorage, FLOOR_DEMOTED_KEY);
}

// Sibling for the primary Fetch button. No demotedClass — the default
// .controls button style already renders the right look once .fetch-cta is
// stripped (the pulse is the only thing the primed class adds).
function demoteFetchCta() {
  const changed = NormiesUi.demoteCta(fetchBtn, { primedClass: "fetch-cta" });
  if (changed) NormiesUi.writeDemoted(window.localStorage, FETCH_DEMOTED_KEY);
}

function renderFloorRows(listings) {
  floorBodyEl.innerHTML = "";
  listings.forEach((l, i) => {
    const rank = i + 1;
    const price = formatPrice(l.priceWei, l.decimals);
    const perUnit = Number(l.priceWei) / Math.pow(10, l.decimals || 18);
    const usd = ethUsdPrice ? perUnit * ethUsdPrice : null;
    const usdCell = usd != null ? `<span class="usd">($${formatUsd(usd)})</span>` : "";
    const durSec = Number(l.durationSec) || 0;
    const durCell = `<span class="dur ${durationClass(durSec)}" title="${escapeHtml(durationTitle(durSec))}">${formatDuration(durSec)}</span>`;
    const lister = l.makerAddress || "";
    const listerShort = lister ? `${lister.slice(0, 6)}…${lister.slice(-4)}` : "—";
    // Thumbnail + token id. The image is server-enriched from the shared
    // nftMetaCache; if missing or broken we fall back to the inline SVG
    // placeholder so the row layout stays stable (no shifting once images
    // resolve). onerror clears itself after swapping to avoid a loop if the
    // placeholder itself ever fails to decode.
    const imgSrc = l.image || NFT_PLACEHOLDER;
    const imgAlt = escapeHtml(l.name || (l.tokenId ? `Normie #${l.tokenId}` : "Normie"));
    const thumb = `<img class="floor-thumb" src="${imgSrc}" alt="${imgAlt}" onerror="this.onerror=null;this.src='${NFT_PLACEHOLDER}'" />`;
    const tokenLink = l.tokenId
      ? `<a href="https://opensea.io/item/ethereum/${NORMIES_CONTRACT}/${l.tokenId}" target="_blank" rel="noopener" title="${imgAlt}">${thumb}<span class="tid">#${l.tokenId}</span></a>`
      : "—";
    const tr = document.createElement("tr");
    // Tag with data-maker so applyMakerEnrichment's document-wide selector
    // paints this row too. Deliberately NOT setting data-duration-sec —
    // listing lifetime ≠ bid expiry; the bid-duration bonus shouldn't apply.
    if (lister) tr.dataset.maker = lister.toLowerCase();
    tr.innerHTML = `
      <td>${rank}</td>
      <td class="token-cell">${tokenLink}</td>
      <td class="num">
        <div class="price-main">${price} ${l.currency || "ETH"}</div>
        <div class="price-sub">${usdCell}</div>
      </td>
      <td class="duration">${durCell}</td>
      <td class="maker">${lister
        ? `<a href="https://opensea.io/${lister}" target="_blank" rel="noopener">
             <span class="maker-name">${listerShort}</span>
           </a>`
        : "—"}</td>
      <td class="num holds">…</td>
      <td class="num burns">…</td>
      <td class="num bot-score">…</td>
    `;
    floorBodyEl.appendChild(tr);
  });
}

// Flag wallet concentration on the floor — if a single wallet holds ≥3 of
// the 10 cheapest listings, that's a classic floor-wall pattern (one seller
// stacking the floor to suppress price or create a fake support level).
function renderConcentrationBanner(listings) {
  const stacked = findConcentratedListers(listings, 3);
  if (!stacked.length) {
    floorBannerEl.hidden = true;
    floorBannerEl.innerHTML = "";
    return;
  }
  const parts = stacked.map(([addr, n]) => {
    const short = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    return `<a href="https://opensea.io/${addr}" target="_blank" rel="noopener"><strong>${short}</strong></a> (${n} listings)`;
  });
  floorBannerEl.innerHTML =
    `⚠ Floor concentration detected: ${parts.join(", ")} — one wallet stacking ` +
    `multiple of the cheapest listings can suppress price or create a fake support wall.`;
  floorBannerEl.hidden = false;
}
