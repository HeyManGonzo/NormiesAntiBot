// Small UI-state helpers shared between the browser bundle and the Node test
// suite. Loaded as a plain <script> in index.html (attaches to
// window.NormiesUi) and require()'d directly from tests/ as CommonJS. Kept
// DOM-agnostic — the functions take an element-like target and only touch
// classList, textContent, title, and hidden, so a minimal mock is enough to
// exercise them under node:test without pulling in jsdom.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NormiesUi = factory();
}(typeof self !== "undefined" ? self : this, function () {

  // ─── demoteCta ────────────────────────────────────────────────────────────
  // One-shot transition from a "primed" attention-grabbing CTA (pulsing halo,
  // accent fill) to its calmer everyday form. Idempotent — once the button no
  // longer carries `primedClass`, repeat calls are no-ops, which keeps the
  // call sites in app.js simple (just call it after every successful action).
  //
  // opts:
  //   primedClass  – the class to remove (required). Used as the idempotency
  //                  guard: if the button doesn't have it, nothing happens.
  //   demotedClass – optional class to add after removal (e.g. "refresh-btn"
  //                  for the floor button, which needs a different visual; the
  //                  fetch button leaves this unset because its default style
  //                  is already correct once .fetch-cta comes off).
  //   text         – optional new textContent (e.g. "Refresh").
  //   title        – optional new title attribute (tooltip).
  //   hideEl       – optional sibling element to mark hidden (the dashed
  //                  "Click to load…" hint card that pairs with the CTA).
  //
  // Returns true if a transition was performed, false on the idempotent path.
  // The boolean is useful for the persistence wiring in app.js — we only want
  // to write to localStorage when an actual change happened.
  function demoteCta(btn, opts) {
    if (!btn || !opts || !opts.primedClass) return false;
    if (!btn.classList.contains(opts.primedClass)) return false;
    btn.classList.remove(opts.primedClass);
    if (opts.demotedClass) btn.classList.add(opts.demotedClass);
    if (opts.text != null) btn.textContent = opts.text;
    if (opts.title != null) btn.title = opts.title;
    if (opts.hideEl) opts.hideEl.hidden = true;
    return true;
  }

  // ─── localStorage helpers ────────────────────────────────────────────────
  // Thin wrappers that swallow access errors so the call sites don't have to
  // repeat try/catch (Safari private mode, disabled storage, etc.). Values are
  // stored as the literal "1" so the keys are self-describing in DevTools.
  function readDemoted(storage, key) {
    try { return !!storage && storage.getItem(key) === "1"; }
    catch (_) { return false; }
  }
  function writeDemoted(storage, key) {
    try { storage && storage.setItem(key, "1"); }
    catch (_) { /* ignore — non-fatal, the user just re-sees the CTA */ }
  }

  return { demoteCta: demoteCta, readDemoted: readDemoted, writeDemoted: writeDemoted };
}));
