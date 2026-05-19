// Unit tests for the UMD UI helpers. The functions are DOM-agnostic, so we
// stub out just enough of an element (classList Set + writable text/title/
// hidden) to exercise them — keeps the suite dependency-free (no jsdom).
//
// Run with: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { demoteCta, readDemoted, writeDemoted } = require("../public/ui-helpers");

// Minimal element stub. classList mirrors the DOMTokenList surface used by
// demoteCta (contains/add/remove) backed by a Set so we can assert on it.
function mockBtn(initialClasses) {
  const set = new Set(initialClasses || []);
  return {
    textContent: "",
    title: "",
    classList: {
      contains: (c) => set.has(c),
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      _set: set,
    },
  };
}
function mockStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

// ─── demoteCta ────────────────────────────────────────────────────────────
test("demoteCta: swaps primedClass for demotedClass, updates text/title, hides hint", () => {
  const btn = mockBtn(["floor-cta"]);
  const hint = { hidden: false };
  const changed = demoteCta(btn, {
    primedClass: "floor-cta",
    demotedClass: "refresh-btn",
    text: "Refresh",
    title: "Re-fetch the 10 cheapest listings.",
    hideEl: hint,
  });
  assert.equal(changed, true);
  assert.equal(btn.classList.contains("floor-cta"), false);
  assert.equal(btn.classList.contains("refresh-btn"), true);
  assert.equal(btn.textContent, "Refresh");
  assert.equal(btn.title, "Re-fetch the 10 cheapest listings.");
  assert.equal(hint.hidden, true);
});

test("demoteCta: idempotent — second call returns false and leaves the button alone", () => {
  const btn = mockBtn(["floor-cta"]);
  demoteCta(btn, { primedClass: "floor-cta", demotedClass: "refresh-btn", text: "Refresh" });
  const second = demoteCta(btn, { primedClass: "floor-cta", demotedClass: "refresh-btn", text: "SHOULD-NOT-APPLY" });
  assert.equal(second, false);
  assert.equal(btn.textContent, "Refresh", "text from the first call must be preserved");
});

test("demoteCta: works without demotedClass (fetch button keeps its default style)", () => {
  const btn = mockBtn(["fetch-cta"]);
  const changed = demoteCta(btn, { primedClass: "fetch-cta" });
  assert.equal(changed, true);
  assert.equal(btn.classList.contains("fetch-cta"), false);
  assert.equal(btn.classList._set.size, 0, "no other classes should have been added");
});

test("demoteCta: no-op when the button never had the primed class", () => {
  const btn = mockBtn(["some-other-class"]);
  const hint = { hidden: false };
  const changed = demoteCta(btn, { primedClass: "floor-cta", text: "Refresh", hideEl: hint });
  assert.equal(changed, false);
  assert.equal(btn.textContent, "", "text must not be touched on the no-op path");
  assert.equal(hint.hidden, false, "hint must stay visible if no demotion happened");
});

test("demoteCta: guards against missing args without throwing", () => {
  assert.equal(demoteCta(null, { primedClass: "x" }), false);
  assert.equal(demoteCta(mockBtn(["x"]), null), false);
  assert.equal(demoteCta(mockBtn(["x"]), {}), false, "no primedClass means no-op");
});

// ─── readDemoted / writeDemoted ───────────────────────────────────────────
test("readDemoted: returns false for missing key, true once written", () => {
  const s = mockStorage();
  assert.equal(readDemoted(s, "k"), false);
  writeDemoted(s, "k");
  assert.equal(readDemoted(s, "k"), true);
  assert.equal(s._map.get("k"), "1", "stored as the literal '1' for DevTools clarity");
});

test("readDemoted: returns false when storage throws (private mode, disabled)", () => {
  const throwing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => {} };
  assert.equal(readDemoted(throwing, "k"), false);
});

test("writeDemoted: swallows errors so the caller doesn't have to try/catch", () => {
  const throwing = { getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); } };
  assert.doesNotThrow(() => writeDemoted(throwing, "k"));
});

test("readDemoted/writeDemoted: tolerate a null storage (SSR-style absence)", () => {
  assert.equal(readDemoted(null, "k"), false);
  assert.doesNotThrow(() => writeDemoted(null, "k"));
});
