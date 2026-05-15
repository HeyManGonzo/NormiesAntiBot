// Normies Offer Desk — frontend logic
// Fetches offers for a given Normie token ID, then enriches the top 5 unique
// makers with OpenSea activity (for bot scoring) and Normies API holdings/burns.

const DISPLAY_TOP_N = 10;
// We enrich every displayed row — bot scoring is only useful if it's
// applied to all the offers a seller might reasonably accept.
const ENRICH_TOP_N = DISPLAY_TOP_N;
const NORMIES_CONTRACT = "0x9eb6e2025b64f340691e424b7fe7022ffde12438";

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

// Prime the preview img with the placeholder so the browser never has to
// resolve an empty src (which renders the broken-icon glyph).
nftImageEl.src = NFT_PLACEHOLDER;

fetchBtn.addEventListener("click", loadOffers);
tokenIdInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadOffers();
});

async function loadOffers() {
  const tokenId = tokenIdInput.value.trim();
  if (!/^\d+$/.test(tokenId)) {
    setStatus("Please enter a valid token ID", "error");
    return;
  }

  setStatus("Fetching offers…", "info");
  fetchBtn.disabled = true;
  tableEl.hidden = true;
  nftCardEl.hidden = true;
  ctaBlockEl.hidden = true;
  bodyEl.innerHTML = "";
  summaryEl.textContent = "";

  // Kick off the NFT preview in parallel with offers so the seller can see
  // the artwork while offers/enrichment load.
  loadNftPreview(tokenId);

  // Wire the CTA button to this Normie's OpenSea item page. Shown alongside
  // the offers because OpenSea has no deep link to a specific bid.
  ctaButtonEl.href = `https://opensea.io/item/ethereum/${NORMIES_CONTRACT}/${tokenId}`;

  try {
    const data = await fetchJson(`/api/offers/${tokenId}`);
    const offers = data.offers || [];

    if (offers.length === 0) {
      setStatus("No offers found for this Normie.", "info");
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

    renderRows(shown);
    tableEl.hidden = false;
    ctaBlockEl.hidden = false;
    setStatus("", "info");

    await enrichTopMakers(shown);
    setStatus("Done.", "success");
    summaryEl.innerHTML = summaryEl.innerHTML.replace(/· enriching .*$/, "· enrichment complete");
  } catch (err) {
    console.error(err);
    setStatus("Error: " + err.message, "error");
  } finally {
    fetchBtn.disabled = false;
  }
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

function renderRows(offers) {
  bodyEl.innerHTML = "";
  offers.forEach((offer, i) => {
    const rank = i + 1;
    const price = formatPrice(offer.priceWei, offer.decimals);
    const qty = offer.quantity > 1 ? ` <span class="qty">× ${offer.quantity}</span>` : "";
    const maker = offer.makerAddress || "";
    const makerShort = maker ? `${maker.slice(0, 6)}…${maker.slice(-4)}` : "—";
    const enriched = rank <= ENRICH_TOP_N;
    const tr = document.createElement("tr");
    if (maker) tr.dataset.maker = maker.toLowerCase();
    tr.innerHTML = `
      <td>${rank}</td>
      <td class="num">${price} ${offer.currency}${qty}</td>
      <td>${renderTypeCell(offer)}</td>
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
  const [events, holders, burns, account] = await Promise.allSettled([
    // 3 pages × 50 events = up to 150 events. Needed so rate-based signals
    // (events/hour, median gap) have a meaningful sample on highly active
    // wallets — a single 50-event page can cover only a few minutes for bots.
    fetchJson(`/api/opensea/events/${address}?limit=50&pages=3`),
    fetchJson(`/api/normies/holders/${address}`),
    fetchJson(`/api/normies/burns/${address}`),
    fetchJson(`/api/opensea/account/${address}`),
  ]);

  const score = events.status === "fulfilled" ? computeBotScore(events.value) : null;
  // Server normalises both endpoints to a `.count` field (see server.js).
  const holdsCount = holders.status === "fulfilled" ? holders.value.count : null;
  // For burns we prefer "tokens burned" over "commit count" since one
  // burn commitment can wrap up to 3 Normies — tokens burned is the
  // collector-loyalty signal we actually care about.
  const burnsCount = burns.status === "fulfilled"
    ? (burns.value.tokensBurned ?? burns.value.count)
    : null;
  const username = account.status === "fulfilled" ? account.value.username : null;
  const shortAddr = `${address.slice(0, 6)}…${address.slice(-4)}`;

  const rows = document.querySelectorAll(`tr[data-maker="${address.toLowerCase()}"]`);
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
    if (score === null) {
      cell.textContent = "?";
    } else {
      const cls = score >= 70 ? "risk-high" : score >= 40 ? "risk-med" : "risk-low";
      cell.innerHTML = `${score} <span class="label">${riskLabel(score)}</span>`;
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

// Heuristic bot score (0–100). Higher = more bot-like.
//
// The previous version was purely count-based, which under-scores wallets
// like "Dan4Play" that fire offers across many collections every few
// seconds: in a 50-event sample they look indistinguishable from a busy
// collector. The rewrite is rate-based — we measure events *per hour*,
// inter-event gaps, and how many distinct collections are touched in
// that window. Sub-minute cadence across multiple collections is the
// fingerprint we actually want to catch.
//
// Signals (max points in parentheses):
//   • Activity rate              (35) — order-related events per hour
//   • Inter-event cadence        (25) — median seconds between consecutive events
//   • Collection sprawl per hour (20) — unique collections / hour
//   • Cancel ratio               (10) — cancels / offers
//   • No purchases despite       (10) — buy-through gap
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
  const timestamps = []; // ms, only for order/offer/cancel events

  for (const e of events) {
    const type = (e.event_type || e.type || "").toLowerCase();
    const slug =
      e.nft?.collection ||
      e.asset?.collection?.slug ||
      e.collection ||
      e.collection_slug;

    const isOffer = type === "order" || type === "offer" || type === "order_made";
    const isCancel = type === "cancel" || type === "order_cancelled";
    const isSale = type === "sale" || type === "successful";

    if (isOffer) offerCount++;
    else if (isCancel) cancelCount++;
    else if (isSale) saleCount++;

    // Only track timestamps + collections for bidding-related activity —
    // transfers/mints inflate the rate without reflecting bot behaviour.
    if (isOffer || isCancel) {
      if (slug) collections.add(slug);
      const ts = e.event_timestamp || e.created_date || e.closing_date;
      if (ts) {
        const t = typeof ts === "number" ? ts * 1000 : new Date(ts).getTime();
        if (!isNaN(t)) timestamps.push(t);
      }
    }
  }

  // Need at least a few datapoints before rate signals are meaningful.
  timestamps.sort((a, b) => a - b);
  const spanMs = timestamps.length >= 2
    ? timestamps[timestamps.length - 1] - timestamps[0]
    : 0;
  // Guard: if the span is 0 (all same timestamp = batch op) treat as 1 minute
  // so we don't divide by zero. A burst of 50 simultaneous orders still
  // yields a huge rate, which is the right signal.
  const spanHours = Math.max(spanMs / 3_600_000, 1 / 60);

  const eventsPerHour = timestamps.length >= 5 ? timestamps.length / spanHours : 0;
  const collectionsPerHour = timestamps.length >= 5 ? collections.size / spanHours : 0;

  // Median inter-event gap in seconds.
  let medianGapSec = Infinity;
  if (timestamps.length >= 5) {
    const gaps = [];
    for (let i = 1; i < timestamps.length; i++) {
      gaps.push((timestamps[i] - timestamps[i - 1]) / 1000);
    }
    gaps.sort((a, b) => a - b);
    medianGapSec = gaps[Math.floor(gaps.length / 2)];
  }

  let score = 0;

  // Activity rate — the strongest single signal. >100/hr = clearly automated.
  if (eventsPerHour > 100) score += 35;
  else if (eventsPerHour > 30) score += 25;
  else if (eventsPerHour > 10) score += 12;
  else if (eventsPerHour > 3) score += 4;

  // Inter-event cadence — humans don't click every few seconds for hours.
  if (medianGapSec < 5) score += 25;
  else if (medianGapSec < 20) score += 15;
  else if (medianGapSec < 60) score += 8;

  // Collection sprawl per hour — Dan4Play's signature: multiple unrelated
  // collections per minute. Only meaningful if we actually have spread.
  if (collections.size >= 3) {
    if (collectionsPerHour > 20) score += 20;
    else if (collectionsPerHour > 8) score += 14;
    else if (collectionsPerHour > 3) score += 7;
  }

  // Cancel ratio — bots cancel-and-replace as the floor moves.
  const cancelRatio = cancelCount / Math.max(offerCount, 1);
  if (cancelRatio > 0.7) score += 10;
  else if (cancelRatio > 0.4) score += 5;

  // Buy-through gap — heavy bidder that never actually buys.
  if (offerCount > 15 && saleCount === 0) score += 10;
  else if (offerCount > 15 && saleCount / offerCount < 0.05) score += 5;

  return Math.min(score, 100);
}

function setStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = type ? "status-" + type : "";
}
