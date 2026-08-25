"use strict";

/* ============================================================
   Offline support — cache the app shell so it opens with no signal on site.
   Silently no-ops where service workers aren't available (e.g. served over plain
   http:// or opened as a local file) rather than erroring.
   ============================================================ */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

/* ============================================================
   Theme toggle
   ============================================================ */
(function initTheme() {
  const stored = localStorage.getItem("geogrid-theme");
  if (stored) document.documentElement.setAttribute("data-theme", stored);
  updateThemeIcons();

  document.getElementById("themeToggle").addEventListener("click", () => {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const current = document.documentElement.getAttribute("data-theme") || (prefersDark ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("geogrid-theme", next);
    updateThemeIcons();
    // Everything else on the page re-themes itself via CSS custom properties, but the 3D view is
    // drawn to a <canvas> imperatively — it only reads the new theme's colours (getComputedStyle,
    // inside render3D) the next time something explicitly redraws it. Without this, staying on
    // that tab and toggling theme leaves it showing the OLD theme's colours until an unrelated
    // redraw happens to come along (switching tabs away and back, editing a lift, etc).
    if (typeof render3D === "function" && window.__geogridResults) render3D(window.__geogridResults);
  });

  function updateThemeIcons() {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const current = document.documentElement.getAttribute("data-theme") || (prefersDark ? "dark" : "light");
    // Plain `.hidden = ...` doesn't reliably reflect to the `hidden` attribute on an <svg> root
    // element the way it does on ordinary HTML elements — toggleAttribute sets the attribute
    // itself, so the global [hidden]{display:none} rule actually matches.
    document.getElementById("themeIconDark").toggleAttribute("hidden", current === "dark");
    document.getElementById("themeIconLight").toggleAttribute("hidden", current !== "dark");
  }
})();

/* ============================================================
   Install-tracking — "installed" lifts and "cut" rolls persist per project
   (keyed by project name) so a foreman can close the browser mid-job and
   pick up where they left off. Keyed by RL / roll number, not array index,
   since those are the identifiers already printed on-screen and on paper.
   ============================================================ */
function progressKey() {
  const name = (document.getElementById("projectName").value || "").trim() || "default";
  return `geogrid-progress::${name}`;
}
function loadProgress() {
  try {
    const raw = JSON.parse(localStorage.getItem(progressKey()));
    return raw && typeof raw === "object" ? { lifts: raw.lifts || {}, rolls: raw.rolls || {} } : { lifts: {}, rolls: {} };
  } catch {
    return { lifts: {}, rolls: {} };
  }
}
function saveProgress(progress) {
  try {
    localStorage.setItem(progressKey(), JSON.stringify(progress));
  } catch {
    /* storage full or unavailable — progress just won't persist across reloads */
  }
}
function isLiftInstalled(rl) {
  return !!loadProgress().lifts[rl];
}
function setLiftInstalled(rl, val) {
  const p = loadProgress();
  if (val) p.lifts[rl] = true;
  else delete p.lifts[rl];
  saveProgress(p);
}
function isRollCut(rollNum) {
  return !!loadProgress().rolls[rollNum];
}
function setRollCut(rollNum, val) {
  const p = loadProgress();
  if (val) p.rolls[rollNum] = true;
  else delete p.rolls[rollNum];
  saveProgress(p);
}

/** Refresh the Lifts installed / Rolls cut bars in the summary panel from current results + tracked state. */
function updateProgressStats() {
  const results = window.__geogridResults || [];
  const rolls = window.__geogridRolls || [];
  const liftsDone = results.filter((r) => isLiftInstalled(r.row.dataset.liftId)).length;
  const rollsDone = rolls.filter((_, i) => isRollCut(i + 1)).length;

  const liftsPct = results.length ? (liftsDone / results.length) * 100 : 0;
  const rollsPct = rolls.length ? (rollsDone / rolls.length) * 100 : 0;

  document.getElementById("progressLiftsValue").textContent = `${liftsDone} / ${results.length}`;
  document.getElementById("progressLiftsBar").style.width = `${liftsPct}%`;
  document.getElementById("progressRollsValue").textContent = `${rollsDone} / ${rolls.length}`;
  document.getElementById("progressRollsBar").style.width = `${rollsPct}%`;
}

/* ============================================================
   Core geogrid strip-layout math
   ============================================================ */

/**
 * Fewest full-width strips spanning face length L with overlap >= oMin,
 * with the resulting slack spread evenly across every seam.
 */
function calcLift(L, w, oMin) {
  if (!(L > 0) || !(w > 0) || oMin < 0 || oMin >= w) return null;

  if (L <= w) {
    return { n: 1, overlap: 0, materialWidth: w, excessWidth: w - L };
  }
  const pitch = w - oMin;
  const n = Math.max(1, Math.ceil((L - oMin) / pitch));
  const overlap = n > 1 ? (n * w - L) / (n - 1) : 0;
  const materialWidth = n * w;
  return { n, overlap, materialWidth, excessWidth: materialWidth - L };
}

/**
 * The "pack from one side" alternative to calcLift's default (spread the leftover evenly) and the
 * Extend-face-length setting (grow the reported face length): every strip is full width w — never
 * trimmed narrower, since cutting a roll down by however many mm on site to close a gap is real
 * lost time for no structural benefit — at exactly oMin overlap, starting flush against whichever
 * `side` is chosen (strip 1 is always the one flush against that side, the first the crew rolls
 * out). Full-width strips step in at the exact pitch as long as the next one still fits; the very
 * last strip is instead pinned flush against the OPPOSITE edge (still full width), so its overlap
 * with its neighbour absorbs whatever's left over instead of any strip's width changing — provably
 * always >= oMin, since it can only be pulled back at most one strip-width from where exact-pitch
 * placement would have put it. Every strip is genuinely full width; only that one seam's overlap
 * varies from the rest. Returns per-strip start/width arrays (used directly as station/width in
 * computeCutPlan, or just as widths for a manually-typed length, which has no boundary to clip
 * against).
 */
function packStripsFromSide(L, w, oMin, side) {
  if (!(L > 0) || !(w > 0) || oMin < 0 || oMin >= w) return null;
  if (L <= w) return { n: 1, starts: [0], widths: [w], overlap: 0, materialWidth: w, excessWidth: w - L };

  const pitch = w - oMin;
  const starts = [];
  let cursor = 0;
  while (cursor + w <= L + 1e-9) {
    starts.push(cursor);
    cursor += pitch;
  }
  const remaining = L - cursor;
  if (remaining > 1e-6) {
    // One more full-width strip, pulled back to sit flush with the far edge rather than trimmed —
    // its overlap with the previous strip is whatever that takes, always >= oMin (see comment above).
    starts.push(L - w);
  }
  const widths = starts.map(() => w);
  if (side === "right") {
    // Mirrors every strip's position about the face's midpoint, in place — index 0 stays "Strip 1"
    // but its position flips from flush-left to flush-right, and the pulled-back last strip ends up
    // flush against the opposite (left) side instead.
    for (let i = 0; i < starts.length; i++) starts[i] = L - starts[i] - w;
  }
  const materialWidth = starts.length * w;
  return { n: starts.length, starts, widths, overlap: oMin, materialWidth, excessWidth: materialWidth - L };
}

/** Arc length of a pasted polyline, "x,y" or "x,y,z" per line (comma or whitespace separated). */
function parseCoordsLength(text) {
  const pts = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/[,\s]+/).map(Number))
    .filter((p) => p.length >= 2 && p.every((n) => Number.isFinite(n)));

  if (pts.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0, z0 = 0] = pts[i - 1];
    const [x1, y1, z1 = 0] = pts[i];
    total += Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  }
  return total;
}

/**
 * One lift per line, comma/tab/space separated — RL, face length, and an optional third column for
 * embedment. Keeps each value as the raw token the user pasted (not a reformatted number) so a
 * spreadsheet's own precision carries straight through, same as manual entry. A line whose first two
 * tokens aren't both numbers (a header row, a blank line, stray text) is silently skipped and counted,
 * not rejected outright — one bad line in an otherwise-good paste shouldn't lose the rest.
 */
function parseBulkLiftData(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const entries = [];
  let skipped = 0;
  lines.forEach((line) => {
    const parts = line.split(/[,\s]+/).filter(Boolean);
    if (parts.length < 2 || !Number.isFinite(parseFloat(parts[0])) || !Number.isFinite(parseFloat(parts[1]))) {
      skipped++;
      return;
    }
    entries.push({ rl: parts[0], face: parts[1], embed: parts.length >= 3 && Number.isFinite(parseFloat(parts[2])) ? parts[2] : "" });
  });
  return { entries, skipped };
}

/* ============================================================
   Cut-plan geometry — clip square-cut strips against a curved/
   tapering plan-view boundary (the "extents") to find where each
   one needs to be trimmed.
   ============================================================ */

function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function ensureCCW(poly) {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly.slice();
}

/** Merge consecutive polygon edges whose direction changes by less than the threshold into logical chains. */
function chainEdges(poly, angleThresholdDeg = 20) {
  const n = poly.length;
  const dirs = [];
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const dx = q.x - p.x, dy = q.y - p.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    dirs.push({ x: dx / len, y: dy / len, len, from: p, to: q });
  }
  if (!dirs.length) return [];
  const chains = [];
  let cur = [dirs[0]];
  for (let i = 1; i < dirs.length; i++) {
    const prev = dirs[i - 1], d = dirs[i];
    const cosA = prev.x * d.x + prev.y * d.y;
    const angle = Math.acos(Math.max(-1, Math.min(1, cosA))) * (180 / Math.PI);
    if (angle <= angleThresholdDeg) cur.push(d);
    else { chains.push(cur); cur = [d]; }
  }
  chains.push(cur);
  return chains.map((edges) => {
    const totalLen = edges.reduce((s, e) => s + e.len, 0);
    const avgX = edges.reduce((s, e) => s + e.x * e.len, 0) / totalLen;
    const avgY = edges.reduce((s, e) => s + e.y * e.len, 0) / totalLen;
    const avgLen = Math.hypot(avgX, avgY) || 1;
    return { edges, length: totalLen, dir: { x: avgX / avgLen, y: avgY / avgLen } };
  });
}

/** Longest chain = face; the longest, most anti-parallel remaining chain = back.
 * `refDir`, when given, biases the face pick instead: several product/section polygons sharing one
 * RL (see computeAndRender's per-RL refDir tracking) are the same physical wall face cut into
 * separate DXF shapes, so each one's face should run the same way as its siblings' rather than
 * whichever edge happens to be longest in that particular shape — a narrow or squarish polygon can
 * easily have its longest edge running along the wall instead of into the fill. That bias is only
 * ever taken up if it still produces a normal, sane shape on its OWN terms — a real face has a real
 * opposite edge roughly facing back at it (see requireBack below); a shape that has no such edge in
 * the refDir-aligned orientation isn't a simple wall face at all (a return/wrap section, an L-shape),
 * and forcing it to match its siblings anyway collapses its whole depth to a sliver instead of fixing
 * its orientation. When that happens, this shape's own natural longest-chain pick is trusted instead. */
function backFor(sorted, face) {
  const rest = sorted.filter((c) => c !== face);
  let back = rest[0] || null, bestDot = back ? face.dir.x * back.dir.x + face.dir.y * back.dir.y : 1;
  for (let i = 1; i < rest.length; i++) {
    const c = rest[i];
    if (c.length < face.length * 0.15) continue;
    const dot = face.dir.x * c.dir.x + face.dir.y * c.dir.y;
    if (dot < bestDot) { bestDot = dot; back = c; }
  }
  return { back, bestDot };
}

/** "Swap face/back" on a lift's Cut Plan card no longer just toggles between two options — it
 * cycles through EVERY edge chain, longest first, as a candidate face (wrapping back around once
 * it's been through them all). Most shapes only ever need the first click (the classic face/back
 * swap), but an unusual boundary — a narrow return/wrap section where the "natural" long edge
 * genuinely isn't the intended face — needs to reach an edge neither the automatic pick nor a
 * single swap can land on. `back` is picked the same anti-parallel way regardless of which edge
 * ends up as face, so a clean quad still pairs the right two edges together whichever one is chosen. */
function pickFaceByIndex(chains, index) {
  const sorted = chains.slice().sort((a, b) => b.length - a.length);
  const face = sorted[((index % sorted.length) + sorted.length) % sorted.length];
  const { back } = backFor(sorted, face);
  return { face, back };
}

function pickFaceAndBack(chains, refDir = null) {
  const sorted = chains.slice().sort((a, b) => b.length - a.length);

  const naturalFace = sorted[0];
  let face = naturalFace;
  let { back, bestDot } = backFor(sorted, face);

  if (refDir) {
    let bestAlign = -1, bestChain = null;
    sorted.forEach((c) => {
      if (c.length < naturalFace.length * 0.15) return;
      const align = Math.abs(c.dir.x * refDir.x + c.dir.y * refDir.y);
      if (align > bestAlign) { bestAlign = align; bestChain = c; }
    });
    // A real match should be nearly parallel or anti-parallel (dot close to ±1) — a middling
    // alignment means this shape genuinely doesn't share its siblings' orientation, so trust its
    // own longest-chain pick instead of forcing a bad match.
    if (bestChain && bestAlign >= 0.85 && bestChain !== face) {
      const alt = backFor(sorted, bestChain);
      // requireBack: only take the sibling-matched face if it still has a real opposite (clearly
      // anti-parallel, not just "not the same direction") — otherwise this shape genuinely isn't a
      // plain wall face in that orientation, and the natural pick above is the correct one to keep.
      if (alt.back && alt.bestDot < -0.3) {
        face = bestChain;
        back = alt.back;
      }
    }
  }
  return { face, back };
}

function pointAtStation(chain, station) {
  let acc = 0;
  const edges = chain.edges;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (station <= acc + e.len || i === edges.length - 1) {
      const t = e.len === 0 ? 0 : Math.max(0, Math.min(1, (station - acc) / e.len));
      return {
        x: e.from.x + (e.to.x - e.from.x) * t,
        y: e.from.y + (e.to.y - e.from.y) * t,
        tangent: { x: e.x, y: e.y },
      };
    }
    acc += e.len;
  }
  const last = edges[edges.length - 1];
  return { x: last.to.x, y: last.to.y, tangent: { x: last.x, y: last.y } };
}

/**
 * All "inside the polygon" intervals along a ray from `origin` in direction `dir`, found via the
 * even-odd rule (count boundary crossings; odd = inside). This is deliberately global — every edge
 * of the polygon is tested, not just a designated "back" chain — and even-odd is well-defined even
 * for a self-intersecting or reentrant boundary, so it can't latch onto the wrong nearby edge the way
 * a "nearest single hit" ray cast can. Segments are returned in order along the ray.
 */
function insideSegments(origin, dir, poly) {
  const n = poly.length;
  const hits = [];
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const sx = q.x - p.x, sy = q.y - p.y;
    const denom = dir.x * sy - dir.y * sx;
    if (Math.abs(denom) < 1e-9) continue;
    const dx = p.x - origin.x, dy = p.y - origin.y;
    const t = (dx * sy - dy * sx) / denom;
    const u = (dx * dir.y - dy * dir.x) / denom;
    if (t > 1e-6 && u >= -1e-6 && u <= 1 + 1e-6) hits.push(t);
  }
  hits.sort((a, b) => a - b);
  let inside = hits.length % 2 === 1; // even-odd rule for the origin itself, using this same ray
  const segments = [];
  let prev = 0;
  hits.forEach((t) => {
    if (inside) segments.push({ start: prev, end: t });
    inside = !inside;
    prev = t;
  });
  return segments;
}

function inwardNormal(tangent) {
  return { x: -tangent.y, y: tangent.x };
}

// Below this, a gap or leftover pocket along a strip's ray isn't worth a separate stitch strip.
const STITCH_MIN = 0.05;

// Reported strip/stitch lengths are rounded up to this step — practical site numbers, never a raw
// CAD-precision decimal. Always UP: rounding must never leave a strip shorter than the design requires.
const ROUND_STEP = 0.5;
// A raw length within this of the step below is DXF/survey noise (vertex-picking, triangulation),
// not a real few-mm-longer requirement — snap down to the clean number instead of bumping a full
// step up for it.
const ROUND_SNAP_TOL = 0.02;
function roundUpToStep(value, step) {
  const lower = Math.floor(value / step + 1e-9) * step;
  if (value - lower <= ROUND_SNAP_TOL) return lower;
  return Math.ceil(value / step - 1e-9) * step;
}

/**
 * Full cut plan for one lift's extents polygon: face length, strip count/overlap, and each strip's
 * clipped cut length. Every strip is cut with one straight, square (perpendicular) trim from a single
 * fixed direction for the whole lift — never a locally-varying angle that tries to hug every kink in
 * the boundary — because grids only ever get a square cut. Where the boundary has a separate pocket of
 * area beyond a gap that a strip's single straight cut can't reach in one piece, that pocket is
 * reported as a "stitch" — a small supplementary patch strip — rather than distorting the main strip.
 */
/**
 * The boundary geometry for ONE strip at a given station/width — how far it truly reaches into the
 * fill, where its near edge sits, and any stitch patches needed past a gap its single straight cut
 * can't cover. Pulled out of computeCutPlan so the same sampling logic (still keyed only off a
 * station and a width, not off any particular product) also drives the manual/mixed-product strip
 * builder below, which picks each strip's station and width strip-by-strip instead of from one
 * uniform pitch.
 */
function stripBoundaryReach(station, w, poly, face, inward, vertexStations) {
  const pt = pointAtStation(face, station);
  const segments = insideSegments(pt, inward, poly);
  const main = segments.find((s) => s.start <= 1e-6);

  // The true boundary reach for this strip, sampled across its full width — a boundary that kinks
  // partway across the strip's width can dodge a coarse, evenly-spaced sample and leave a real,
  // uncovered sliver between the strip and the true line. Worst of all at the wall FACE itself,
  // where the strip has to tie up flush with zero gap (the far/inner end just ties into existing
  // ground, so it's rounded up generously and is far less sensitive to this). Combines a modest
  // even sweep with every actual polygon vertex that falls inside this strip's width, so a kink is
  // always sampled exactly rather than only approximately.
  const laneMin = Math.max(0, station - w / 2), laneMax = Math.min(face.length, station + w / 2);
  const sampleCount = Math.max(3, Math.min(15, Math.round(w / 0.3) + 1));
  const edgeStations = [];
  for (let k = 0; k < sampleCount; k++) {
    const t = sampleCount === 1 ? 0.5 : k / (sampleCount - 1);
    edgeStations.push(laneMin + t * (laneMax - laneMin));
  }
  vertexStations.forEach((s) => {
    if (s > laneMin && s < laneMax) edgeStations.push(s);
  });
  let farReach = 0, nearReach = 0;
  edgeStations.forEach((s) => {
    const p = pointAtStation(face, s);
    const segs = insideSegments(p, inward, poly);
    const m = segs.find((seg) => seg.start <= 1e-6);
    if (m) {
      farReach = Math.max(farReach, m.end);
      nearReach = Math.min(nearReach, m.start);
    }
  });

  // Reported/cut length: the true reach rounded up to a practical site number. Rounding only ever
  // goes up, so this can end up slightly longer than the true extents reach — that overshoot is
  // exactly the bit that needs trimming back on site to avoid burying wasted material past the
  // design boundary, shown separately in the diagram rather than folded silently into this number.
  const cutLength = roundUpToStep(farReach, ROUND_STEP);
  const stitches = segments
    .filter((s) => s !== main && s.end - s.start > STITCH_MIN)
    .map((s) => ({ offset: roundUpToStep(s.start, ROUND_STEP), length: roundUpToStep(s.end - s.start, ROUND_STEP) }));

  return { cutLength, farReach, nearReach, stitches };
}

function computeCutPlan(rawPoints, w, oMin, faceCycle, refDir = null, packSide = null) {
  const poly = ensureCCW(rawPoints.map((p) => ({ x: p.x, y: p.y })));
  const chains = chainEdges(poly);
  if (chains.length < 2) return null;
  const { face, back } = faceCycle ? pickFaceByIndex(chains, faceCycle) : pickFaceAndBack(chains, refDir);

  const packed = packSide ? packStripsFromSide(face.length, w, oMin, packSide) : null;
  const result = packed || calcLift(face.length, w, oMin);
  if (!result) return null;
  const pitch = !packed && result.n > 1 ? w - result.overlap : 0;

  // Fixed for the whole lift, not recomputed per strip from a locally-varying tangent — every strip
  // is parallel, which is what "grids can only ever be square" means in practice.
  const inward = inwardNormal(face.dir);

  // Every polygon vertex's approximate position along the face, as a station — used below so a strip
  // never misses a boundary kink no matter how narrow, even one confined to a sliver of its width. An
  // evenly-spaced sample sweep alone can straddle a kink and never land on it; the exact vertex station
  // always does.
  const faceOrigin = face.edges[0].from;
  const vertexStations = poly
    .map((p) => (p.x - faceOrigin.x) * face.dir.x + (p.y - faceOrigin.y) * face.dir.y)
    .filter((s) => s >= 0 && s <= face.length)
    .sort((a, b) => a - b);

  const cutLengths = [];
  const stitches = [];
  const extentsReach = [];
  const frontReach = [];
  const stripWidths = [];
  const stripStarts = [];
  for (let i = 0; i < result.n; i++) {
    const width = packed ? packed.widths[i] : w;
    const start = packed ? packed.starts[i] : i * pitch;
    const station = Math.max(0, Math.min(face.length, start + width / 2));
    const r = stripBoundaryReach(station, width, poly, face, inward, vertexStations);
    cutLengths.push(r.cutLength);
    stitches.push(r.stitches);
    extentsReach.push(r.farReach);
    frontReach.push(r.nearReach);
    stripWidths.push(width);
    stripStarts.push(start);
  }

  return {
    poly,
    face,
    back,
    faceLength: face.length,
    n: result.n,
    overlap: result.overlap,
    stripStarts,
    materialWidth: result.materialWidth,
    cutLengths,
    stitches,
    extentsReach,
    frontReach,
    stripWidths,
    polygonArea: Math.abs(signedArea(poly)),
  };
}

/**
 * The manual/mixed-product counterpart to computeCutPlan: instead of one uniform pitch derived from
 * a single product's width and overlap, walks an explicit, ordered strip sequence (built one click
 * at a time — see the Cut Plan tab's "Build manually" mode) where each strip can be a different
 * product. Where two different products meet, the seam uses whichever of the two products' minimum
 * overlaps is larger, so both are satisfied at once; consecutive strips of the same product use that
 * product's own overlap, same as the automatic layout would. Returns the same shape computeCutPlan
 * does (n, cutLengths, stitches, extentsReach, frontReach, polygonArea, face, back) plus per-strip
 * product/geometry arrays the uniform layout has no need for.
 */
function computeManualCutPlan(rawPoints, manualStrips, productSpecs, faceCycle, refDir = null) {
  // manualStrips may be an empty array — that's "build mode is on, nothing placed yet" — still worth
  // computing the boundary/face so the Cut Plan tab has something to draw the first click-node
  // against, rather than showing nothing until the first strip exists.
  if (!manualStrips) return null;
  const poly = ensureCCW(rawPoints.map((p) => ({ x: p.x, y: p.y })));
  const chains = chainEdges(poly);
  if (chains.length < 2) return null;
  const { face, back } = faceCycle ? pickFaceByIndex(chains, faceCycle) : pickFaceAndBack(chains, refDir);

  const inward = inwardNormal(face.dir);
  const faceOrigin = face.edges[0].from;
  const vertexStations = poly
    .map((p) => (p.x - faceOrigin.x) * face.dir.x + (p.y - faceOrigin.y) * face.dir.y)
    .filter((s) => s >= 0 && s <= face.length)
    .sort((a, b) => a - b);

  const cutLengths = [];
  const stitches = [];
  const extentsReach = [];
  const frontReach = [];
  const stripProductIds = [];
  const stripWidths = [];
  const stripStarts = [];
  const stripEnds = [];
  const seamOverlaps = []; // seamOverlaps[i] is the overlap used between strip i and strip i+1

  let cursorEnd = 0; // the running far/right edge of the sequence built so far, along the face
  manualStrips.forEach((strip, i) => {
    const spec = productSpecs[strip.productId];
    if (!spec) return; // a product deleted out from under a saved sequence — skip rather than crash
    const w = spec.w > 0 ? spec.w : 0.01;
    let start;
    if (i === 0) {
      start = 0;
    } else {
      const prevSpec = productSpecs[manualStrips[i - 1].productId] || spec;
      const overlap = Math.max(spec.oMin, prevSpec.oMin);
      seamOverlaps.push(overlap);
      start = cursorEnd - overlap;
    }
    const end = start + w;
    cursorEnd = end;
    const station = Math.max(0, Math.min(face.length, (start + end) / 2));

    const r = stripBoundaryReach(station, w, poly, face, inward, vertexStations);
    cutLengths.push(r.cutLength);
    stitches.push(r.stitches);
    extentsReach.push(r.farReach);
    frontReach.push(r.nearReach);
    stripProductIds.push(strip.productId);
    stripWidths.push(w);
    stripStarts.push(start);
    stripEnds.push(end);
  });

  return {
    poly,
    face,
    back,
    faceLength: face.length,
    n: stripProductIds.length,
    cutLengths,
    stitches,
    extentsReach,
    frontReach,
    stripProductIds,
    stripWidths,
    stripStarts,
    stripEnds,
    seamOverlaps,
    manual: true,
    polygonArea: Math.abs(signedArea(poly)),
  };
}

/** 3DFACE entities (triangles, or quads split into two triangles) — a raw triangulated cut surface. */
function parseDXF3DFaces(text) {
  const linesRaw = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < linesRaw.length; i += 2) {
    const code = parseInt(linesRaw[i].trim(), 10);
    const value = linesRaw[i + 1] !== undefined ? linesRaw[i + 1].trim() : "";
    if (Number.isFinite(code)) pairs.push({ code, value });
  }
  const triangles = [];
  let inEntities = false;
  let buf = null;

  function finish(b) {
    const p = b.pts;
    if (p.x1 === undefined || p.x2 === undefined || p.x3 === undefined) return;
    const p1 = { x: p.x1, y: p.y1, z: p.z1 || 0 };
    const p2 = { x: p.x2, y: p.y2, z: p.z2 || 0 };
    const p3 = { x: p.x3, y: p.y3, z: p.z3 || 0 };
    triangles.push([p1, p2, p3]);
    if (p.x4 !== undefined && (Math.abs(p.x4 - p.x3) > 1e-9 || Math.abs(p.y4 - p.y3) > 1e-9 || Math.abs((p.z4 || 0) - p.z3) > 1e-9)) {
      const p4 = { x: p.x4, y: p.y4, z: p.z4 || 0 };
      triangles.push([p1, p3, p4]);
    }
  }

  const codeMap = { 10: "x1", 20: "y1", 30: "z1", 11: "x2", 21: "y2", 31: "z2", 12: "x3", 22: "y3", 32: "z3", 13: "x4", 23: "y4", 33: "z4" };
  for (let i = 0; i < pairs.length; i++) {
    const { code, value } = pairs[i];
    if (code === 0) {
      if (buf && buf.type === "3DFACE") finish(buf);
      if (value === "ENDSEC") { inEntities = false; buf = null; continue; }
      buf = value === "3DFACE" ? { type: "3DFACE", pts: {} } : null;
      continue;
    }
    if (code === 2 && value === "ENTITIES") { inEntities = true; continue; }
    if (!inEntities || !buf) continue;
    if (buf.type === "3DFACE" && codeMap[code]) buf.pts[codeMap[code]] = parseFloat(value);
  }
  return triangles;
}

/** Outer boundary loop(s) of the triangles whose vertices are all within `tol` of elevation z0 — i.e. a flat bench. */
function benchBoundaryAt(triangles, z0, tol) {
  const flat = triangles.filter((tri) => tri.every((p) => Math.abs(p.z - z0) <= tol));
  if (!flat.length) return [];

  const keyOf = (p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
  const edgeKey = (k1, k2) => (k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`);

  const edgeMap = new Map();
  flat.forEach((tri) => {
    for (let i = 0; i < 3; i++) {
      const p = tri[i], q = tri[(i + 1) % 3];
      const ek = edgeKey(keyOf(p), keyOf(q));
      if (!edgeMap.has(ek)) edgeMap.set(ek, { p, q, count: 0 });
      edgeMap.get(ek).count++;
    }
  });
  const boundary = Array.from(edgeMap.values()).filter((e) => e.count === 1);
  if (!boundary.length) return [];

  const adj = new Map();
  boundary.forEach(({ p, q }) => {
    const kp = keyOf(p), kq = keyOf(q);
    if (!adj.has(kp)) adj.set(kp, []);
    if (!adj.has(kq)) adj.set(kq, []);
    adj.get(kp).push({ to: kq, point: q });
    adj.get(kq).push({ to: kp, point: p });
  });

  // Turn-angle between two directions, as a clockwise sweep in [0, 2*PI) from `inDir` to `outDir`.
  const turnSweep = (inDir, outDir) => {
    const cross = inDir.x * outDir.y - inDir.y * outDir.x;
    const dot = inDir.x * outDir.x + inDir.y * outDir.y;
    let sweep = -Math.atan2(cross, dot);
    if (sweep < 0) sweep += 2 * Math.PI;
    return sweep;
  };

  const visited = new Set();
  const loops = [];
  boundary.forEach(({ p, q }) => {
    const startKey = keyOf(p);
    const startEk = edgeKey(startKey, keyOf(q));
    if (visited.has(startEk)) return;

    const loop = [p];
    visited.add(startEk);
    let currentKey = keyOf(q);
    let currentPoint = q;
    let prevPoint = p;
    let guard = 0;

    while (guard++ < 100000) {
      loop.push(currentPoint);
      if (currentKey === startKey) break;

      // A vertex can be shared by more than one flat region at the same elevation (they touch
      // at a single point without being the same bench). At such a branch point, always take the
      // sharpest available left turn — that keeps the walk on the boundary of the one region it
      // started tracing, instead of cutting the corner straight into the neighbouring region and
      // merging two benches into one self-intersecting loop.
      const inDir = { x: currentPoint.x - prevPoint.x, y: currentPoint.y - prevPoint.y };
      const inLen = Math.hypot(inDir.x, inDir.y) || 1;
      inDir.x /= inLen;
      inDir.y /= inLen;

      const candidates = (adj.get(currentKey) || []).filter((o) => !visited.has(edgeKey(currentKey, keyOf(o.point))));
      if (!candidates.length) break;

      let best = null, bestSweep = -Infinity;
      candidates.forEach((o) => {
        const outDir = { x: o.point.x - currentPoint.x, y: o.point.y - currentPoint.y };
        const outLen = Math.hypot(outDir.x, outDir.y) || 1;
        outDir.x /= outLen;
        outDir.y /= outLen;
        const sweep = turnSweep(inDir, outDir);
        if (sweep > bestSweep) { bestSweep = sweep; best = o; }
      });

      visited.add(edgeKey(currentKey, keyOf(best.point)));
      prevPoint = currentPoint;
      currentPoint = best.point;
      currentKey = keyOf(best.point);
    }
    if (loop.length >= 3) loops.push(loop);
  });
  return loops.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
}

/**
 * Horizontal cross-section of a triangulated surface at elevation z0 — for a battered pit/excavation
 * (walls sloping down to a base, no overhangs), this is the plan-view outline of the dig at that
 * level. Every triangle the z0 plane actually crosses contributes one segment (interpolated along its
 * two crossing edges); segments are then chained end-to-end into loops. Returns every loop found,
 * closed or not — closed loops are what a real enclosed excavation gives at a level fully inside its
 * depth range; an open chain means that level clips the edge of the modelled surface rather than
 * being fully enclosed by it.
 */
function sliceMeshAt(triangles, z0, eps = 1e-9) {
  const segments = [];
  triangles.forEach((tri) => {
    const above = tri.some((p) => p.z > z0 + eps);
    const below = tri.some((p) => p.z < z0 - eps);
    if (!above || !below) return; // entirely on one side (or exactly on the plane) — no crossing
    const crossings = [];
    for (let i = 0; i < 3; i++) {
      const a = tri[i], b = tri[(i + 1) % 3];
      const az = a.z - z0, bz = b.z - z0;
      if ((az > 0 && bz < 0) || (az < 0 && bz > 0)) {
        const t = az / (az - bz);
        crossings.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    if (crossings.length === 2) segments.push(crossings);
  });
  if (!segments.length) return [];

  const keyOf = (p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
  const adj = new Map();
  segments.forEach(([p, q]) => {
    const kp = keyOf(p), kq = keyOf(q);
    if (!adj.has(kp)) adj.set(kp, []);
    if (!adj.has(kq)) adj.set(kq, []);
    adj.get(kp).push({ to: kq, point: q });
    adj.get(kq).push({ to: kp, point: p });
  });

  const edgeKey = (k1, k2) => (k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`);
  const visited = new Set();
  const loops = [];
  segments.forEach(([p, q]) => {
    const startKey = keyOf(p);
    const startEdge = edgeKey(startKey, keyOf(q));
    if (visited.has(startEdge)) return;
    visited.add(startEdge);
    const points = [p, q];
    let currentKey = keyOf(q);
    let guard = 0;
    while (guard++ < 100000 && currentKey !== startKey) {
      const next = (adj.get(currentKey) || []).find((o) => !visited.has(edgeKey(currentKey, keyOf(o.point))));
      if (!next) break;
      visited.add(edgeKey(currentKey, keyOf(next.point)));
      points.push(next.point);
      currentKey = keyOf(next.point);
    }
    loops.push({ closed: currentKey === startKey && points.length > 2, points });
  });
  return loops;
}

/** A LandXML TIN surface (<Surfaces><Surface><Definition><Pnts>/<Faces>) — same triangle shape as parseDXF3DFaces. */
function parseLandXMLSurface(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) return [];

  // Namespace-agnostic: LandXML declares a default xmlns, which breaks plain tag-name CSS selectors.
  const byLocalName = (name) => Array.from(doc.getElementsByTagName("*")).filter((el) => el.localName === name);

  const pts = new Map();
  byLocalName("P").forEach((p) => {
    const id = p.getAttribute("id");
    const parts = p.textContent.trim().split(/\s+/).map(Number);
    if (id && parts.length >= 3 && parts.every(Number.isFinite)) {
      // LandXML point order is northing, easting, elevation by default.
      pts.set(id, { x: parts[1], y: parts[0], z: parts[2] });
    }
  });

  const triangles = [];
  byLocalName("F").forEach((f) => {
    const ids = f.textContent.trim().split(/\s+/).slice(0, 3);
    const tri = ids.map((id) => pts.get(id));
    if (tri.length === 3 && tri.every(Boolean)) triangles.push(tri);
  });
  return triangles;
}

/** Any LINE/LWPOLYLINE/legacy-POLYLINE, open or closed — just its length, layer and mean elevation. */
function parseDXFEntityLengths(text) {
  const linesRaw = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < linesRaw.length; i += 2) {
    const code = parseInt(linesRaw[i].trim(), 10);
    const value = linesRaw[i + 1] !== undefined ? linesRaw[i + 1].trim() : "";
    if (Number.isFinite(code)) pairs.push({ code, value });
  }

  const entities = [];
  let inEntities = false;
  let buf = null;
  let polylineOpen = null;

  function dist3(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0)); }
  function finish(entity) {
    if (!entity || !entity.pts || entity.pts.length < 2) return;
    let length = 0;
    for (let i = 1; i < entity.pts.length; i++) length += dist3(entity.pts[i - 1], entity.pts[i]);
    const meanZ = entity.pts.reduce((s, p) => s + (p.z || 0), 0) / entity.pts.length;
    entities.push({ type: entity.type, layer: entity.layer || "0", length, meanZ });
  }
  function flushLwVertex() {
    if (buf && buf.type === "LWPOLYLINE" && buf._x !== undefined) {
      buf.pts.push({ x: buf._x, y: buf._y ?? 0, z: buf.elevation || 0 });
      buf._x = undefined;
    }
  }

  for (let i = 0; i < pairs.length; i++) {
    const { code, value } = pairs[i];
    if (code === 0) {
      if (buf && buf._vertexOf) {
        buf._vertexOf.pts.push({ x: buf._x || 0, y: buf._y || 0, z: buf._z || 0 });
      } else if (buf && buf.type === "LWPOLYLINE") {
        flushLwVertex();
        finish(buf);
      } else if (buf && buf.type === "LINE") {
        buf.pts = [
          { x: buf._x0 || 0, y: buf._y0 || 0, z: buf._z0 || 0 },
          { x: buf._x1 || 0, y: buf._y1 || 0, z: buf._z1 || 0 },
        ];
        finish(buf);
      }
      if (value === "ENDSEC") { inEntities = false; if (polylineOpen) finish(polylineOpen); polylineOpen = null; buf = null; continue; }
      if (value === "LWPOLYLINE") buf = { type: "LWPOLYLINE", layer: "0", pts: [], elevation: 0 };
      else if (value === "LINE") buf = { type: "LINE", layer: "0" };
      else if (value === "POLYLINE") { buf = { type: "POLYLINE", layer: "0", pts: [] }; polylineOpen = buf; }
      else if (value === "VERTEX" && polylineOpen) buf = { _vertexOf: polylineOpen, _x: 0, _y: 0, _z: 0 };
      else if (value === "SEQEND") { if (polylineOpen) finish(polylineOpen); polylineOpen = null; buf = null; }
      else buf = null;
      continue;
    }
    if (code === 2 && value === "ENTITIES") { inEntities = true; continue; }
    if (!inEntities || !buf) continue;

    if (buf._vertexOf) {
      if (code === 10) buf._x = parseFloat(value);
      if (code === 20) buf._y = parseFloat(value);
      if (code === 30) buf._z = parseFloat(value);
      continue;
    }
    if (buf.type === "LWPOLYLINE") {
      if (code === 8) buf.layer = value;
      if (code === 38) buf.elevation = parseFloat(value);
      if (code === 10) { flushLwVertex(); buf._x = parseFloat(value); }
      if (code === 20) buf._y = parseFloat(value);
    } else if (buf.type === "LINE") {
      if (code === 8) buf.layer = value;
      if (code === 10) buf._x0 = parseFloat(value);
      if (code === 20) buf._y0 = parseFloat(value);
      if (code === 30) buf._z0 = parseFloat(value);
      if (code === 11) buf._x1 = parseFloat(value);
      if (code === 21) buf._y1 = parseFloat(value);
      if (code === 31) buf._z1 = parseFloat(value);
    } else if (buf.type === "POLYLINE") {
      if (code === 8) buf.layer = value;
    }
  }
  return entities;
}

/** Closed polylines only (LWPOLYLINE + legacy POLYLINE/VERTEX) — a lift's plan-view extents boundary. */
function parseDXFPolygons(text) {
  const linesRaw = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < linesRaw.length; i += 2) {
    const code = parseInt(linesRaw[i].trim(), 10);
    const value = linesRaw[i + 1] !== undefined ? linesRaw[i + 1].trim() : "";
    if (Number.isFinite(code)) pairs.push({ code, value });
  }

  const polygons = [];
  let inEntities = false;
  let buf = null;
  let polylineOpen = null;

  function flushLwVertex() {
    if (buf && buf.type === "LWPOLYLINE" && buf._x !== undefined) {
      buf.pts.push({ x: buf._x, y: buf._y ?? 0, z: buf.elevation || 0 });
      buf._x = undefined;
    }
  }
  function finishClosedPoly(entity) {
    if (!entity || !entity.pts || entity.pts.length < 3) return;
    const pts = entity.pts.slice();
    const first = pts[0], last = pts[pts.length - 1];
    // A polyline someone closed by snapping its last vertex back onto the first — instead of the
    // dedicated Close command — never gets its "closed" flag (group code 70, bit 1) set, even
    // though it's visually and functionally a closed boundary. Treating only the flag as authority
    // silently drops that shape (one polygon just disappears out of a whole DXF, with no error) —
    // so an endpoint pair that coincides counts as closed too, whichever way it got that way. A
    // genuinely open shape's endpoints essentially never land this close by accident.
    const endpointsCoincide = Math.hypot(last.x - first.x, last.y - first.y) < 1e-6;
    if (!(entity.flags & 1) && !endpointsCoincide) return;
    if (endpointsCoincide) pts.pop();
    const meanZ = pts.reduce((s, p) => s + (p.z || 0), 0) / pts.length;
    polygons.push({ layer: entity.layer || "0", points: pts, meanZ });
  }

  for (let i = 0; i < pairs.length; i++) {
    const { code, value } = pairs[i];
    if (code === 0) {
      if (buf && buf._vertexOf) {
        buf._vertexOf.pts.push({ x: buf._x || 0, y: buf._y || 0, z: buf._z || 0 });
      } else if (buf && buf.type === "LWPOLYLINE") {
        flushLwVertex();
        finishClosedPoly(buf);
      }
      if (value === "ENDSEC") {
        inEntities = false;
        if (polylineOpen) finishClosedPoly(polylineOpen);
        polylineOpen = null;
        buf = null;
        continue;
      }
      if (value === "LWPOLYLINE") buf = { type: "LWPOLYLINE", layer: "0", pts: [], elevation: 0, flags: 0 };
      else if (value === "POLYLINE") { buf = { type: "POLYLINE", layer: "0", pts: [], flags: 0 }; polylineOpen = buf; }
      else if (value === "VERTEX" && polylineOpen) buf = { _vertexOf: polylineOpen, _x: 0, _y: 0, _z: 0 };
      else if (value === "SEQEND") { if (polylineOpen) finishClosedPoly(polylineOpen); polylineOpen = null; buf = null; }
      else buf = null;
      continue;
    }
    if (code === 2 && value === "ENTITIES") { inEntities = true; continue; }
    if (!inEntities || !buf) continue;

    if (buf._vertexOf) {
      if (code === 10) buf._x = parseFloat(value);
      if (code === 20) buf._y = parseFloat(value);
      if (code === 30) buf._z = parseFloat(value);
      continue;
    }
    if (buf.type === "LWPOLYLINE") {
      if (code === 8) buf.layer = value;
      if (code === 38) buf.elevation = parseFloat(value);
      if (code === 70) buf.flags = parseInt(value, 10);
      if (code === 10) { flushLwVertex(); buf._x = parseFloat(value); }
      if (code === 20) buf._y = parseFloat(value);
    } else if (buf.type === "POLYLINE") {
      if (code === 8) buf.layer = value;
      if (code === 70) buf.flags = parseInt(value, 10);
    }
  }
  return polygons;
}

/** Greedy first-fit-decreasing bin packing of strip lengths into fixed-length rolls. */
/**
 * First-fit-decreasing bin packing of labelled pieces (which lift, which strip) onto fixed-length
 * rolls — a physical numbered cutting schedule, not just a summary count. Per site preference, a
 * roll's leftover after packing is never left as discarded off-cut: it's added onto that roll's last
 * (smallest) piece instead, since a strip longer than its design minimum is always safe, but an
 * off-cut thrown in the bin isn't recoverable. Every roll therefore ends up used in full; each piece
 * carries `extra` (how much beyond its design length it picked up to make that happen) so the bonus
 * is visible rather than silently absorbed. A piece longer than one roll is split across as many
 * whole rolls as it needs plus a final partial one.
 */
function packRollsDetailed(pieces, rollLength) {
  if (!(rollLength > 0)) return [];
  const sorted = pieces.filter((p) => p.length > 1e-6).slice().sort((a, b) => b.length - a.length);
  const rolls = [];
  sorted.forEach((piece) => {
    if (piece.length > rollLength + 1e-9) {
      let remaining = piece.length;
      let part = 1;
      const totalParts = Math.ceil(piece.length / rollLength);
      while (remaining > 1e-9) {
        const cut = Math.min(rollLength, remaining);
        rolls.push({ remaining: rollLength - cut, pieces: [{ label: `${piece.label} (${part}/${totalParts})`, key: piece.key, length: cut, extra: 0, seq: piece.seq }] });
        remaining -= cut;
        part++;
      }
      return;
    }
    for (const roll of rolls) {
      if (roll.remaining >= piece.length - 1e-9) {
        roll.pieces.push({ label: piece.label, key: piece.key, length: piece.length, extra: 0, seq: piece.seq });
        roll.remaining -= piece.length;
        return;
      }
    }
    rolls.push({ remaining: rollLength - piece.length, pieces: [{ label: piece.label, key: piece.key, length: piece.length, extra: 0, seq: piece.seq }] });
  });

  // Use up every roll fully: whatever's left after packing goes onto that roll's last (smallest)
  // piece as extra length, rather than being thrown away.
  rolls.forEach((roll) => {
    if (roll.remaining > 1e-6) {
      roll.pieces[roll.pieces.length - 1].extra += roll.remaining;
      roll.remaining = 0;
    }
  });

  return rolls;
}

/** Every strip and stitch across every lift, labelled by source, for the pooled cross-level roll schedule. */
function buildRollPieces(results, productId) {
  const pieces = [];
  results.forEach((r) => {
    // r._buildIndex is this lift's position in the FULL job (see packRollsWindowed) — not its
    // position within whatever subset was passed in here, which for a grouped/banded pack is only
    // one band. seq lets rolls be renumbered by first-used-on-site order after packing, regardless
    // of which band or how the bin packer itself ordered them internally.
    const buildIndex = r._buildIndex ?? 0;
    r.stripLengths.forEach((len, i) => {
      // A manually built row can mix products strip-by-strip, so which product a piece belongs to is
      // decided per strip (stripProductIds), not by the row's single (mostly nominal, for an
      // automatic row still exactly right) product — a stitch inherits its parent strip's product.
      const stripProduct = (r.stripProductIds && r.stripProductIds[i]) || r.product;
      if (stripProduct !== productId) return;
      const seq = buildIndex * 1000 + i;
      // `label` is the human-readable "RL <rl> · Strip <n>" text shown on Roll schedule cards and
      // printed sheets — fine to collide, since several rows can legitimately share an RL (several
      // products/sections on one physical lift). `key` exists purely so buildRollLookup's reverse
      // "which roll is this strip on" map doesn't collide the same way: it folds in the row's own
      // liftId, which is unique even when the RL text isn't.
      const liftId = r.row.dataset.liftId;
      if (len > 1e-6) pieces.push({ label: `RL ${r.rl} · Strip ${i + 1}`, key: `${liftId}::strip${i + 1}`, length: len, seq });
      if (r.cutPlan) {
        (r.cutPlan.stitches[i] || []).forEach((s, si) => {
          const suffix = r.cutPlan.stitches[i].length > 1 ? `.${si + 1}` : "";
          pieces.push({ label: `RL ${r.rl} · Strip ${i + 1}${suffix} stitch`, key: `${liftId}::strip${i + 1}${suffix}::stitch`, length: s.length, seq });
        });
      }
    });
  });
  return pieces;
}

/**
 * Packs every strip/stitch onto numbered rolls, optionally restricted to sharing a roll only with
 * OTHER lifts within a small adjacent band, instead of pooling the whole job. Pooling everything (no
 * groupSize) finds the fewest possible rolls, but a bin packer sorts purely by length — it has no idea
 * a roll ends up with pieces from lift 2 and lift 30 on it, which is useless on site if lifts are built
 * in order. Splitting into bands of `groupSize` adjacent lifts and packing each band on its own costs a
 * bit more offcut (fewer chances to fill a gap with an unrelated piece) but keeps every roll close to
 * where it's actually used.
 */
function packRollsWindowed(results, rollLength, groupSize, productId) {
  // r._buildIndex is tagged by the caller (renderSummary) before this runs — see buildRollPieces.
  let rolls;
  if (groupSize > 0) {
    rolls = [];
    for (let start = 0; start < results.length; start += groupSize) {
      const band = results.slice(start, start + groupSize);
      rolls = rolls.concat(packRollsDetailed(buildRollPieces(band, productId), rollLength));
    }
  } else {
    rolls = packRollsDetailed(buildRollPieces(results, productId), rollLength);
  }

  // Renumber by first-used-on-site order, not whatever order the bin packer (which sorts purely by
  // piece length) happened to create them in — so "Roll 1" really is the first roll a crew needs.
  rolls.sort((a, b) => Math.min(...a.pieces.map((p) => p.seq)) - Math.min(...b.pieces.map((p) => p.seq)));
  return rolls;
}

/* ============================================================
   DOM wiring
   ============================================================ */

const tbody = document.getElementById("liftTableBody");
const rowTemplate = document.getElementById("liftRowTemplate");
const emptyState = document.getElementById("emptyState");

const settingsInputs = {
  rollGroupSize: document.getElementById("rollGroupSize"),
  installRate: document.getElementById("installRate"),
  baseLevel: document.getElementById("baseLevel"),
  extendFace: document.getElementById("extendFaceToggle"),
  packSide: document.getElementById("packSideToggle"),
  packSideValue: document.getElementById("packSide"),
};

const packSideField = document.getElementById("packSideField");
const packSideHint = document.getElementById("packSideHint");
settingsInputs.packSide.addEventListener("change", () => {
  packSideField.hidden = !settingsInputs.packSide.checked;
  packSideHint.hidden = !settingsInputs.packSide.checked;
  computeAndRender();
});
settingsInputs.packSideValue.addEventListener("change", computeAndRender);

/* ============================================================
   Products — an open-ended, editable list of rolled products (RE580, Strata, or whatever a job
   needs next), each with its own width/overlap/roll length/cost and an optional wrap+lap allowance.
   `products` only tracks IDENTITY (which ids exist, in what order, which colour dot they get) — the
   actual spec numbers live in the DOM inputs rendered inside #productSpecBody, read fresh by
   readProductSpecs() the same way settingsInputs always has been. That keeps a single source of
   truth per value and means adding/renaming/deleting a product never has to sync two copies of the
   same number.
   ============================================================ */

const PRODUCT_COLOR_SLOTS = ["id-1", "id-2", "id-3", "id-4"];
const productSpecBody = document.getElementById("productSpecBody");

let products = [];

function defaultProductRows() {
  return [
    { id: "re580", colorSlot: "id-1", name: "RE580", w: "1.3", oMinMm: "300", rollLength: "50", costPerRoll: "", wrapAllowance: "0" },
    { id: "strata", colorSlot: "id-2", name: "Strata", w: "5.8", oMinMm: "150", rollLength: "100", costPerRoll: "", wrapAllowance: "2.6" },
  ];
}

/** Reconstructs the RE580/Strata products from a version-1 saved project or autosave (predating the
 *  editable product list), which stored RE580's spec as fixed settings.* fields and Strata's as a
 *  separate top-level `strata` block. Only synthesizes the ones that were actually saved, so an old
 *  snapshot that never had Strata filled in doesn't invent it. */
function legacyProductRowsFrom(state) {
  const s = state.settings || {};
  const st = state.strata || {};
  const rows = [];
  if (s.rollWidth != null) {
    rows.push({
      id: "re580",
      colorSlot: "id-1",
      name: "RE580",
      w: s.rollWidth,
      oMinMm: s.minOverlap ?? "300",
      rollLength: s.rollLength ?? "50",
      costPerRoll: s.costPerRoll ?? "",
      wrapAllowance: "0",
    });
  }
  if (st.rollWidth != null) {
    rows.push({
      id: "strata",
      colorSlot: "id-2",
      name: "Strata",
      w: st.rollWidth,
      oMinMm: st.minOverlap ?? "150",
      rollLength: st.rollLength ?? "100",
      costPerRoll: st.costPerRoll ?? "",
      wrapAllowance: st.wrapAllowance ?? "2.6",
    });
  }
  return rows.length ? rows : defaultProductRows();
}

function blankProductRow() {
  const id = "product_" + Math.random().toString(36).slice(2, 9);
  const colorSlot = PRODUCT_COLOR_SLOTS[products.length % PRODUCT_COLOR_SLOTS.length];
  return { id, colorSlot, name: "", w: "1.3", oMinMm: "300", rollLength: "50", costPerRoll: "", wrapAllowance: "0" };
}

function productRowEl(id) {
  return productSpecBody.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
}

function productFieldEl(id, field) {
  return productRowEl(id)?.querySelector(`[data-field="${field}"]`) || null;
}

function buildProductRowHtml(row) {
  return `
    <tr class="product-row" data-id="${row.id}">
      <td class="product-swatch-col"><span class="swatch swatch--${row.colorSlot}"></span></td>
      <td><input class="product-name-input" data-field="name" value="${escapeHtml(row.name)}" placeholder="Product name" aria-label="Product name" /></td>
      <td class="num"><div class="field__unit"><input type="number" data-field="w" min="0.1" step="0.05" value="${escapeHtml(row.w)}" aria-label="Roll width" /><em>m</em></div></td>
      <td class="num"><div class="field__unit"><input type="number" data-field="oMinMm" min="0" step="10" value="${escapeHtml(row.oMinMm)}" aria-label="Minimum overlap" /><em>mm</em></div></td>
      <td class="num"><div class="field__unit"><input type="number" data-field="rollLength" min="1" step="1" value="${escapeHtml(row.rollLength)}" aria-label="Roll length" /><em>m</em></div></td>
      <td class="num"><div class="field__unit"><input type="number" data-field="costPerRoll" min="0" step="1" placeholder="0" value="${escapeHtml(row.costPerRoll)}" aria-label="Cost per roll" /><em>$</em></div></td>
      <td class="num"><div class="field__unit"><input type="number" data-field="wrapAllowance" min="0" step="0.1" value="${escapeHtml(row.wrapAllowance)}" aria-label="Wrap and lap allowance" /><em>m</em></div></td>
      <td class="product-action-col"><button type="button" class="product-delete-btn" data-id="${row.id}" title="Delete ${escapeHtml(row.name || row.id)}"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M6 4V2.6h4V4M4 4l.6 9.4h6.8L12 4"/></svg></button></td>
    </tr>
  `;
}

/** The count badge next to the (collapsed by default) Products summary — the one hint of what's in
 *  there without having to open it. */
function updateProductsCountBadge() {
  const badge = document.getElementById("productsCountBadge");
  if (badge) badge.textContent = `${products.length} product${products.length === 1 ? "" : "s"}`;
}

/** Full rebuild from a list of complete row specs — used at boot and when restoring a saved/
 *  autosaved project. Everyday add/delete instead touch just the one row that changed (see
 *  addProduct/deleteProduct below), so an in-progress edit elsewhere in the table is never disturbed. */
function renderProductTable(rows) {
  products = rows.map((r) => ({ id: r.id, colorSlot: r.colorSlot }));
  productSpecBody.innerHTML = rows.map(buildProductRowHtml).join("");
  populateProductSelects();
  updateProductsCountBadge();
}

function addProduct() {
  const row = blankProductRow();
  products.push({ id: row.id, colorSlot: row.colorSlot });
  productSpecBody.insertAdjacentHTML("beforeend", buildProductRowHtml(row));
  populateProductSelects();
  updateProductsCountBadge();
  computeAndRender();
  productFieldEl(row.id, "name")?.focus();
}

function deleteProduct(id) {
  if (products.length <= 1) return; // at least one product must always exist
  const inUse = Array.from(tbody.querySelectorAll(".lift-row .product-select")).some((sel) => sel.value === id);
  if (inUse) return; // delete button is disabled in this case already — belt and braces
  products = products.filter((p) => p.id !== id);
  productRowEl(id)?.remove();
  populateProductSelects();
  updateProductsCountBadge();
  computeAndRender();
}

/** Keeps every lift row's Product <select> in sync with the current product list (add/delete/
 *  rename) — rebuilt from scratch each time since it's cheap and the list is short, preserving
 *  whichever product a row already had selected where it still exists. */
function populateProductSelects() {
  const options = products.map((p) => ({
    id: p.id,
    name: productFieldEl(p.id, "name")?.value.trim() || p.id,
    colorSlot: p.colorSlot,
  }));
  document.querySelectorAll("#liftTableBody .lift-row .product-select").forEach((sel) => {
    const prevValue = sel.value;
    sel.innerHTML = options.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join("");
    sel.value = options.some((o) => o.id === prevValue) ? prevValue : options[0]?.id || "";
  });
  const dxfProductSel = document.getElementById("dxfExtentsProduct");
  if (dxfProductSel) {
    const prevValue = dxfProductSel.value;
    dxfProductSel.innerHTML = options.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join("");
    dxfProductSel.value = options.some((o) => o.id === prevValue) ? prevValue : options[0]?.id || "";
  }
}

/** Every product row's raw (unparsed) field values, in table order — the shape saved into a project
 *  snapshot and restored verbatim via renderProductTable(), same convention as every other raw-input
 *  field in buildStateSnapshot/applyStateSnapshot below. */
function snapshotProductRows() {
  return products.map((p) => {
    const row = productRowEl(p.id);
    return {
      id: p.id,
      colorSlot: p.colorSlot,
      name: row.querySelector('[data-field="name"]').value,
      w: row.querySelector('[data-field="w"]').value,
      oMinMm: row.querySelector('[data-field="oMinMm"]').value,
      rollLength: row.querySelector('[data-field="rollLength"]').value,
      costPerRoll: row.querySelector('[data-field="costPerRoll"]').value,
      wrapAllowance: row.querySelector('[data-field="wrapAllowance"]').value,
    };
  });
}

// The button now lives inside <summary> (top-right of the Products panel header, same slot
// "+ Add lift" sits in above the Takeoff table) so it's reachable without opening the panel first —
// but a click anywhere in <summary> also toggles the parent <details> by default, which would
// immediately re-close the panel right after adding a product if it was already open. Cancel that
// default toggle and force it open instead, so the new row is always visible afterward.
document.getElementById("addProductBtn").addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById("productsDetails").open = true;
  addProduct();
});
productSpecBody.addEventListener("click", (e) => {
  const btn = e.target.closest(".product-delete-btn");
  if (btn) deleteProduct(btn.dataset.id);
});
productSpecBody.addEventListener("input", (e) => {
  if (e.target.matches('[data-field="name"]')) populateProductSelects();
  computeAndRender();
});

/** Parses every product's DOM row into the shape the rest of the app calculates against — unchanged
 *  from the old fixed RE580/Strata version except the source is now however many rows are in the
 *  table, in table order, instead of two hardcoded objects. */
function readProductSpecs() {
  const specs = {};
  products.forEach((p) => {
    const row = productRowEl(p.id);
    if (!row) return;
    const val = (field) => row.querySelector(`[data-field="${field}"]`).value;
    const name = val("name").trim();
    specs[p.id] = {
      id: p.id,
      label: name || p.id,
      colorSlot: p.colorSlot,
      w: parseFloat(val("w")) || 0,
      oMin: (parseFloat(val("oMinMm")) || 0) / 1000,
      rollLength: parseFloat(val("rollLength")) || 0,
      costPerRoll: parseFloat(val("costPerRoll")) || 0,
      wrapAllowance: parseFloat(val("wrapAllowance")) || 0,
    };
  });
  return specs;
}

/** Disables/greys out a product's delete button while it's in use on any lift row, or while it's
 *  the last product left — both would otherwise leave a row pointing at a product that no longer
 *  exists. Cheap enough to just re-scan on every recompute rather than track usage incrementally. */
function updateProductDeleteState() {
  const usage = new Map();
  document.querySelectorAll("#liftTableBody .lift-row .product-select").forEach((sel) => {
    usage.set(sel.value, (usage.get(sel.value) || 0) + 1);
  });
  products.forEach((p) => {
    const btn = productRowEl(p.id)?.querySelector(".product-delete-btn");
    if (!btn) return;
    const count = usage.get(p.id) || 0;
    const isLast = products.length <= 1;
    btn.disabled = count > 0 || isLast;
    const name = productFieldEl(p.id, "name")?.value.trim() || p.id;
    btn.title = isLast
      ? "At least one product is required"
      : count > 0
      ? `Can't delete — used by ${count} lift${count === 1 ? "" : "s"}`
      : `Delete ${name}`;
  });
}

renderProductTable(defaultProductRows());

function readSettings() {
  const rollGroupSizeRaw = parseInt(settingsInputs.rollGroupSize.value, 10);
  const baseLevelRaw = parseFloat(settingsInputs.baseLevel.value);
  return {
    // How many adjacent lifts may share a roll — 0/blank pools every lift together (lowest waste).
    rollGroupSize: rollGroupSizeRaw > 0 ? rollGroupSizeRaw : 0,
    installRate: parseFloat(settingsInputs.installRate.value) || 0,
    // The RL fill started from, below the lowest lift — null (not 0) when blank, since RL 0 is a
    // perfectly real elevation and can't double as "not set".
    baseLevel: Number.isFinite(baseLevelRaw) ? baseLevelRaw : null,
    extendFace: settingsInputs.extendFace.checked,
    packSide: settingsInputs.packSide.checked ? settingsInputs.packSideValue.value : null,
  };
}

const MODE_ICON_LENGTH = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2 8h12M4.5 5.5v2M8 4.5v3M11.5 5.5v2"/></svg>';
const MODE_ICON_COORDS =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12 7 5 13 9" stroke-dasharray="1.6 1.6"/><circle cx="3" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="7" cy="5" r="1.3" fill="currentColor" stroke="none"/><circle cx="13" cy="9" r="1.3" fill="currentColor" stroke="none"/></svg>';
/** Swaps the face-input mode-toggle's icon (straight length vs pasted coordinates) — a small icon
 * instead of literal "L"/"XY" text, consistent with every other affordance in the app by now. */
function setModeToggleIcon(btn, toCoords) {
  btn.innerHTML = toCoords ? MODE_ICON_COORDS : MODE_ICON_LENGTH;
}

let liftIdSeq = 0;
/** A stable identity for a lift row that survives its RL changing and (unlike RL text) is never
 * shared between two rows — several products can legitimately sit at the same RL (see
 * validateRows' old "Duplicate RL" warning), so RL alone can't key per-lift state like the
 * Installed checkbox without two physical lifts silently sharing one tick. */
function newLiftId() {
  return `lift${++liftIdSeq}-${Date.now().toString(36)}`;
}

function addLiftRow(rl = "", faceLength = "", embed = "", insertBeforeNode = null, isIntermediate = false, liftId = null) {
  const frag = rowTemplate.content.cloneNode(true);
  const row = frag.querySelector(".lift-row");
  row.dataset.liftId = liftId || newLiftId();
  row.querySelector(".rl-input").value = rl;
  row.querySelector(".face-length").value = faceLength;
  row.querySelector(".embed-length").value = embed;
  row.querySelector(".intermediate-badge").hidden = !isIntermediate;
  row.dataset.mode = "length";

  const modeBtn = row.querySelector(".mode-toggle");
  setModeToggleIcon(modeBtn, false);
  const lengthWrap = row.querySelector(".face-input__length");
  const coordsBox = row.querySelector(".face-coords");

  modeBtn.addEventListener("click", () => {
    const toCoords = row.dataset.mode === "length";
    row.dataset.mode = toCoords ? "coords" : "length";
    setModeToggleIcon(modeBtn, toCoords);
    modeBtn.title = toCoords
      ? "Pasted-coordinate arc length — click to switch to a straight length"
      : "Straight length — click to switch to pasted coordinates";
    lengthWrap.hidden = toCoords;
    coordsBox.hidden = !toCoords;
    computeAndRender();
  });

  row.querySelectorAll("input, textarea").forEach((el) => {
    el.addEventListener("input", computeAndRender);
  });
  row.querySelector(".product-select").addEventListener("change", computeAndRender);

  row.querySelector(".row-remove").addEventListener("click", () => {
    row.remove();
    computeAndRender();
  });

  row.querySelector(".extents-release").addEventListener("click", () => {
    releaseExtents(row);
    computeAndRender();
  });

  row.querySelector(".extents-reattach").addEventListener("click", () => {
    if (!row._extentsPointsSaved) return;
    applyExtents(row, row._extentsPointsSaved);
    computeAndRender();
  });

  tbody.insertBefore(frag, insertBeforeNode);
  populateProductSelects();
  return row;
}

function applyExtents(row, points) {
  row._extentsPoints = points;
  row._extentsPointsSaved = points;
  row._faceCycle = 0;
  row.dataset.mode = "extents";
  row.querySelector(".face-input__length").hidden = true;
  row.querySelector(".face-coords").hidden = true;
  row.querySelector(".extents-badge").hidden = false;
  row.querySelector(".mode-toggle").hidden = true;
  row.querySelector(".extents-reattach").hidden = true;
}

function releaseExtents(row) {
  // Keep a copy so a detached row can be restored with one click, instead of forcing a re-upload
  // of the same DXF file and relying on RL-based re-matching to find its way back.
  row._extentsPointsSaved = row._extentsPoints;
  row._extentsPoints = null;
  row.dataset.mode = "length";
  row.querySelector(".extents-badge").hidden = true;
  row.querySelector(".face-input__length").hidden = false;
  row.querySelector(".face-coords").hidden = true;
  row.querySelector(".embed-length").hidden = false;
  // The reattach icon takes the mode-toggle's slot rather than sitting alongside it — .col-face's
  // width budget only has room for one small button plus the length input, and reattaching is the
  // action a just-released row actually needs.
  row.querySelector(".extents-reattach").hidden = false;
  const modeBtn = row.querySelector(".mode-toggle");
  modeBtn.hidden = true;
  setModeToggleIcon(modeBtn, false);
  modeBtn.title = "Straight length — click to switch to pasted coordinates";
}

document.getElementById("addLiftBtn").addEventListener("click", () => {
  addLiftRow();
  computeAndRender();
});

document.getElementById("genBtn").addEventListener("click", () => {
  const statusEl = document.getElementById("genStatus");
  const startRaw = document.getElementById("genStartRL").value;
  const countRaw = document.getElementById("genCount").value;
  const start = parseFloat(startRaw);
  const spacingMm = parseFloat(document.getElementById("genSpacing").value) || 0;
  const count = Math.round(parseFloat(countRaw));

  if (!Number.isFinite(start) || startRaw.trim() === "" || !Number.isFinite(count) || count < 1) {
    statusEl.textContent = "Enter a Start RL and Count first.";
    statusEl.className = "cutplan-status is-error";
    return;
  }
  statusEl.textContent = "";
  statusEl.className = "cutplan-status";

  const spacing = spacingMm / 1000;
  tbody.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const rl = (start + i * spacing).toFixed(2);
    addLiftRow(rl, "", "");
  }
  computeAndRender();
});

document.getElementById("bulkPasteBtn").addEventListener("click", () => {
  const statusEl = document.getElementById("bulkPasteStatus");
  const raw = document.getElementById("bulkPasteInput").value;
  const { entries, skipped } = parseBulkLiftData(raw);

  if (!entries.length) {
    statusEl.textContent = "No valid rows found — expected one lift per line: RL, face length[, embedment].";
    statusEl.className = "cutplan-status is-error";
    return;
  }

  tbody.innerHTML = "";
  entries.forEach((entry) => addLiftRow(entry.rl, entry.face, entry.embed));

  statusEl.textContent = `Imported ${entries.length} lift row${entries.length === 1 ? "" : "s"}${
    skipped ? ` (${skipped} line${skipped === 1 ? "" : "s"} skipped — couldn't read an RL and face length)` : ""
  }. This replaced every existing lift row.`;
  statusEl.className = "cutplan-status is-ok";
  computeAndRender();
});

// A small, realistic dataset so a first-time user sees the tool actually working — every stat tile
// populated, not just an empty table — instead of guessing what to type in before anything renders.
const SAMPLE_PROJECT = {
  projectName: "Sample project — north batter reinforcement",
  costPerRoll: "250",
  installRate: "150",
  rows: [
    { rl: "49.70", face: "18.4", embed: "4.2" },
    { rl: "50.30", face: "17.9", embed: "4.0" },
    { rl: "50.90", face: "20.5", embed: "4.5" },
    { rl: "51.50", face: "19.2", embed: "4.0" },
    { rl: "52.10", face: "21.0", embed: "4.5" },
  ],
};

document.getElementById("loadSampleBtn").addEventListener("click", () => {
  document.getElementById("projectName").value = SAMPLE_PROJECT.projectName;
  renderProductTable(defaultProductRows());
  const re580Cost = productFieldEl("re580", "costPerRoll");
  if (re580Cost) re580Cost.value = SAMPLE_PROJECT.costPerRoll;
  settingsInputs.installRate.value = SAMPLE_PROJECT.installRate;
  tbody.innerHTML = "";
  SAMPLE_PROJECT.rows.forEach((r) => addLiftRow(r.rl, r.face, r.embed));
  refreshProjectList();
  computeAndRender();
});

document.getElementById("interBtn").addEventListener("click", () => {
  const from = parseFloat(document.getElementById("interFromRL").value);
  const to = parseFloat(document.getElementById("interToRL").value);
  const statusEl = document.getElementById("interStatus");

  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    statusEl.textContent = "Enter a valid From/To RL range (From must be less than To).";
    statusEl.className = "cutplan-status is-error";
    return;
  }

  const rows = Array.from(tbody.querySelectorAll(".lift-row"));
  let inserted = 0, skippedAlready = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const rowA = rows[i], rowB = rows[i + 1];
    const rlA = parseFloat(rowA.querySelector(".rl-input").value);
    const rlB = parseFloat(rowB.querySelector(".rl-input").value);
    if (!Number.isFinite(rlA) || !Number.isFinite(rlB)) continue;
    if (rlA < from || rlB > to) continue;

    // Never re-subdivide a pair where either side is already an inserted intermediate —
    // otherwise clicking this button twice roughly doubles the count each time.
    const aIsMid = !rowA.querySelector(".intermediate-badge").hidden;
    const bIsMid = !rowB.querySelector(".intermediate-badge").hidden;
    if (aIsMid || bIsMid) {
      skippedAlready++;
      continue;
    }

    const mid = ((rlA + rlB) / 2).toFixed(2);
    addLiftRow(mid, "", "", rowA.nextSibling, true);
    inserted++;
  }

  statusEl.textContent = inserted
    ? `Added ${inserted} intermediate grid${inserted === 1 ? "" : "s"} between RL ${from} and RL ${to}.${
        skippedAlready ? ` (${skippedAlready} pair${skippedAlready === 1 ? "" : "s"} already had one — skipped, so this button is safe to click again.)` : ""
      }`
    : skippedAlready
    ? `Everything in RL ${from}–${to} already has an intermediate grid — nothing more to add.`
    : `No consecutive lift pairs found fully within RL ${from}–${to}.`;
  statusEl.className = inserted ? "cutplan-status is-ok" : "cutplan-status is-error";
  computeAndRender();
});

document.getElementById("interRemoveBtn").addEventListener("click", () => {
  const from = parseFloat(document.getElementById("interFromRL").value);
  const to = parseFloat(document.getElementById("interToRL").value);
  const statusEl = document.getElementById("interStatus");

  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    statusEl.textContent = "Enter a valid From/To RL range (From must be less than To).";
    statusEl.className = "cutplan-status is-error";
    return;
  }

  const rows = Array.from(tbody.querySelectorAll(".lift-row"));
  let removed = 0;
  rows.forEach((row) => {
    const isMid = !row.querySelector(".intermediate-badge").hidden;
    const rl = parseFloat(row.querySelector(".rl-input").value);
    if (isMid && Number.isFinite(rl) && rl >= from && rl <= to) {
      row.remove();
      removed++;
    }
  });

  statusEl.textContent = removed
    ? `Removed ${removed} intermediate grid${removed === 1 ? "" : "s"} between RL ${from} and RL ${to}.`
    : `No intermediate grids found in RL ${from}–${to}.`;
  statusEl.className = removed ? "cutplan-status is-ok" : "cutplan-status is-error";
  computeAndRender();
});

Object.values(settingsInputs).forEach((el) => el.addEventListener("input", computeAndRender));

/* ============================================================
   Strip-layout diagram
   ============================================================ */

function renderDiagram(svg, L, result, w, W = 240, H = 34) {
  svg.innerHTML = "";
  if (!result) return;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const { n, overlap } = result;
  const pad = 2;
  const usableW = W - pad * 2;
  const scale = usableW / Math.max(L, result.materialWidth);
  const pitchPx = n > 1 ? (w - overlap) * scale : 0;
  const ns = "http://www.w3.org/2000/svg";

  // "Pack from one side" (packStripsFromSide) can leave one strip — always at most one — narrower
  // than the rest, with real per-strip positions in result.starts/widths; every other packing mode
  // stays uniform, reconstructed from the single pitch same as always.
  const starts = result.starts || Array.from({ length: n }, (_, i) => i * (w - overlap));
  const widths = result.widths || Array.from({ length: n }, () => w);

  for (let i = 0; i < n; i++) {
    const x = pad + starts[i] * scale;
    const stripPx = widths[i] * scale;
    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", x.toFixed(2));
    rect.setAttribute("y", 6);
    rect.setAttribute("width", stripPx.toFixed(2));
    rect.setAttribute("height", 16);
    rect.setAttribute("rx", 1.5);
    rect.setAttribute("fill", "var(--accent-tint)");
    rect.setAttribute("stroke", "var(--accent)");
    rect.setAttribute("stroke-width", "1");
    rect.setAttribute("opacity", "0.9");
    svg.appendChild(rect);

    if (i > 0) {
      // The true overlap zone with the previous strip — where this one starts to where the last one
      // ended — rather than assuming every strip is exactly `pitchPx` apart.
      const prevEnd = starts[i - 1] + widths[i - 1];
      const overlapPx = Math.max(0, (prevEnd - starts[i]) * scale);
      const ox = x;
      const orect = document.createElementNS(ns, "rect");
      orect.setAttribute("x", ox.toFixed(2));
      orect.setAttribute("y", 6);
      orect.setAttribute("width", overlapPx.toFixed(2));
      orect.setAttribute("height", 16);
      orect.setAttribute("fill", "var(--accent-strong)");
      orect.setAttribute("opacity", "0.55");
      svg.appendChild(orect);
    }
  }

  // Face-length dimension line beneath the strips
  const dimY = 28;
  const line = document.createElementNS(ns, "line");
  line.setAttribute("x1", pad);
  line.setAttribute("x2", (pad + L * scale).toFixed(2));
  line.setAttribute("y1", dimY);
  line.setAttribute("y2", dimY);
  line.setAttribute("stroke", "var(--graphite)");
  line.setAttribute("stroke-width", "1");
  svg.appendChild(line);
  [pad, pad + L * scale].forEach((x) => {
    const tick = document.createElementNS(ns, "line");
    tick.setAttribute("x1", x.toFixed(2));
    tick.setAttribute("x2", x.toFixed(2));
    tick.setAttribute("y1", dimY - 2);
    tick.setAttribute("y2", dimY + 2);
    tick.setAttribute("stroke", "var(--graphite)");
    tick.setAttribute("stroke-width", "1");
    svg.appendChild(tick);
  });
}

/** The compact per-row diagram's counterpart for a manually built (mixed-product) row — each strip
 * drawn at its own true width and position (no uniform pitch to approximate from, computeManualCutPlan
 * already worked out the exact geometry), coloured by its own product's swatch colour instead of the
 * single accent colour every automatic-layout row uses. */
function renderDiagramManual(svg, L, cutPlan, productSpecs, W = 240, H = 34) {
  svg.innerHTML = "";
  const { stripStarts, stripEnds, stripProductIds } = cutPlan;
  if (!stripStarts || !stripStarts.length) return;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const pad = 2;
  const usableW = W - pad * 2;
  const maxExtent = Math.max(L, ...stripEnds);
  const scale = usableW / Math.max(maxExtent, 1e-6);
  const ns = "http://www.w3.org/2000/svg";

  stripStarts.forEach((start, i) => {
    const width = stripEnds[i] - start;
    const x = pad + start * scale;
    const wPx = width * scale;
    const spec = productSpecs[stripProductIds[i]];
    const colorVar = spec && spec.colorSlot ? `var(--${spec.colorSlot})` : "var(--accent)";
    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", x.toFixed(2));
    rect.setAttribute("y", 6);
    rect.setAttribute("width", Math.max(wPx, 0).toFixed(2));
    rect.setAttribute("height", 16);
    rect.setAttribute("rx", 1.5);
    rect.setAttribute("fill", colorVar);
    rect.setAttribute("fill-opacity", "0.7");
    rect.setAttribute("stroke", colorVar);
    rect.setAttribute("stroke-width", "1");
    svg.appendChild(rect);
  });

  // Face-length dimension line beneath the strips — same convention as the automatic diagram.
  const dimY = 28;
  const line = document.createElementNS(ns, "line");
  line.setAttribute("x1", pad);
  line.setAttribute("x2", (pad + L * scale).toFixed(2));
  line.setAttribute("y1", dimY);
  line.setAttribute("y2", dimY);
  line.setAttribute("stroke", "var(--graphite)");
  line.setAttribute("stroke-width", "1");
  svg.appendChild(line);
  [pad, pad + L * scale].forEach((x) => {
    const tick = document.createElementNS(ns, "line");
    tick.setAttribute("x1", x.toFixed(2));
    tick.setAttribute("x2", x.toFixed(2));
    tick.setAttribute("y1", dimY - 2);
    tick.setAttribute("y2", dimY + 2);
    tick.setAttribute("stroke", "var(--graphite)");
    tick.setAttribute("stroke-width", "1");
    svg.appendChild(tick);
  });
}

/* ============================================================
   Compute + render everything
   ============================================================ */


const fmt = {
  int: (v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }),
  m: (v) => v.toLocaleString(undefined, { maximumFractionDigits: 2 }),
  mm: (v) => Math.round(v * 1000).toLocaleString(),
  pct: (v) => `${v.toFixed(1)}%`,
  // No currency symbol/code assumed — the input's own "$" unit label already says what's being
  // entered, and guessing USD/NZD/AUD would just as often be wrong as right.
  cost: (v) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
};

function wasteLevel(pct) {
  if (pct <= 8) return "good";
  if (pct <= 18) return "warn";
  return "critical";
}

/**
 * Cheap sanity checks across the whole table that no single row's own math can catch on its own —
 * nothing here blocks the plan from computing, it's purely a heads-up to double-check before
 * ordering material.
 */
function validateRows(results, productSpecs) {
  const issues = [];

  // Two or more rows sharing an RL is a deliberate, supported pattern (several products/sections
  // on the one physical lift — see the manual strip builder and per-row product select), each row
  // keyed by its own liftId (see isLiftInstalled) rather than RL text, so siblings never collide.
  // What's still worth a heads-up is a row group that ISN'T contiguous in the table — e.g. the same
  // RL appearing again several rows later — since the Cut Plan/print pages, Installation Sequence,
  // and "fill to RL X" instruction all read the table top-to-bottom as one physical build order.
  const lastSeenAt = new Map();
  results.forEach((r, i) => {
    if (!r.rl) return;
    const prevIdx = lastSeenAt.get(r.rl);
    if (prevIdx != null && prevIdx !== i - 1) {
      issues.push(`RL ${r.rl} (row ${i + 1}) repeats a few rows after its last appearance (row ${prevIdx + 1}) — group same-RL rows together, or it'll look like two builds out of order.`);
    }
    lastSeenAt.set(r.rl, i);
  });

  // Installation sequence, the CSV/PDF export, and the "fill to RL X" instruction all assume each
  // row is built on top of the one before it — the actual physical sequence on site. Rows sharing
  // an RL with the one just before them are fine (same physical lift, different product/section),
  // so only a genuine drop in RL is flagged here.
  for (let i = 1; i < results.length; i++) {
    const prev = parseFloat(results[i - 1].rl), cur = parseFloat(results[i].rl);
    if (Number.isFinite(prev) && Number.isFinite(cur) && cur < prev) {
      issues.push(`RL ${results[i].rl} (row ${i + 1}) isn't higher than the lift before it (RL ${results[i - 1].rl}) — check the build order.`);
    }
  }

  // A single strip's real cut length (embedment plus any wrap/lap allowance) longer than one roll
  // needs a splice this app doesn't plan a joint for — extents-mode rows are cut to fit the
  // boundary already and aren't a fixed embedment. Each row's own product decides its roll length.
  results.forEach((r, i) => {
    if (r.mode === "extents") return;
    const rollLength = (productSpecs[r.product] || productSpecs[products[0]?.id]).rollLength;
    const cutLen = r.stripLengths && r.stripLengths.length ? Math.max(...r.stripLengths) : r.embed;
    if (rollLength > 0 && cutLen > rollLength) {
      issues.push(`RL ${r.rl || `row ${i + 1}`}: cut length (${fmt.m(cutLen)} m) is longer than the ${r.productLabel} roll length (${fmt.m(rollLength)} m) — will need a splice.`);
    }
  });

  return issues;
}

function renderRowWarnings(issues) {
  const el = document.getElementById("rowWarnings");
  if (!issues.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = `<strong>${issues.length} thing${issues.length === 1 ? "" : "s"} worth checking:</strong><ul>${issues
    .map((m) => `<li>${escapeHtml(m)}</li>`)
    .join("")}</ul>`;
}

/** Same three checks (negative overlap, overlap >= width, non-positive roll length), run once per
 * product against its own inputs — RE580 and Strata each need their own spec to be internally valid
 * regardless of whether the other one is. */
function validateProductSpec(p, rollLengthRawStr) {
  const issues = [];
  if (p.oMin < 0) {
    issues.push(`Minimum overlap can't be negative — every ${p.label} lift will show as blank until it's fixed.`);
  } else if (p.oMin >= p.w) {
    issues.push(`Minimum overlap (${fmt.mm(p.oMin)} mm) must be smaller than the roll width (${p.w} m).`);
  }
  if (rollLengthRawStr.trim() !== "" && parseFloat(rollLengthRawStr) <= 0) {
    issues.push(`Roll length must be greater than zero — "${p.label}" rolls/cost will both show as 0 until it's fixed.`);
  }
  return issues;
}

function computeAndRender() {
  const { rollGroupSize, installRate, baseLevel, extendFace, packSide } = readSettings();
  const productSpecs = readProductSpecs();
  const fallbackProduct = productSpecs[products[0]?.id];
  const productFor = (row) => {
    const sel = row.querySelector(".product-select");
    return (sel && productSpecs[sel.value]) || fallbackProduct;
  };

  const productSpecWarning = document.getElementById("productSpecWarning");
  const productSpecIssues = products.flatMap((p) => {
    const spec = productSpecs[p.id];
    if (!spec) return [];
    const rollLengthRaw = productFieldEl(p.id, "rollLength")?.value ?? "";
    return validateProductSpec(spec, rollLengthRaw);
  });
  productSpecWarning.hidden = productSpecIssues.length === 0;
  productSpecWarning.innerHTML = productSpecIssues.map((m) => `<span>${escapeHtml(m)}</span>`).join("<br>");

  const rows = Array.from(tbody.querySelectorAll(".lift-row"));
  emptyState.hidden = rows.length > 0;
  // Collected alongside validateRows() below — these catch bad values on a single row's own inputs
  // (negative face length/embedment), which validateRows can't see because a row that fails to
  // produce a result is never added to liftResults in the first place.
  const inputIssues = [];

  // Pre-pass: compute each extents-mode row's cut plan once, and pick a single shared frame (the
  // longest face) for the 3D view — a short return/starter bench isn't representative of the main
  // wall's orientation, and every lift needs the SAME frame to stack with its true relative
  // alignment preserved, rather than each independently reset to its own face start.
  const cutPlanByRow = new Map();
  // Several product/section polygons can legitimately share one RL (a wall face cut into separate
  // DXF shapes) — each is matched to its own row, but "longest edge = face" is picked per polygon
  // in isolation, so a narrower or squarer sibling can easily pick a side edge as its face instead
  // of running the same way as the rest of that RL. The first row processed for a given RL sets the
  // reference direction (in table order, top to bottom); every later row at that same RL is biased
  // toward matching it (see pickFaceAndBack) instead of picking blind.
  const rlFaceDir = new Map();
  rows.forEach((row) => {
    if (row.dataset.mode === "extents" && row._extentsPoints) {
      const rl = row.querySelector(".rl-input").value.trim();
      const refDir = rl ? rlFaceDir.get(rl) || null : null;
      let cp;
      if (row._manualStrips) {
        cp = computeManualCutPlan(row._extentsPoints, row._manualStrips, productSpecs, row._faceCycle, refDir);
      } else {
        const p = productFor(row);
        cp = p.oMin < p.w ? computeCutPlan(row._extentsPoints, p.w, p.oMin, row._faceCycle, refDir, packSide) : null;
      }
      if (cp) {
        cutPlanByRow.set(row, cp);
        if (rl && !rlFaceDir.has(rl)) rlFaceDir.set(rl, cp.face.dir);
      }
    }
  });
  let footprintRef = null;
  let batteredOrigin = null; // shared translation-only origin for battered-surface levels — see absoluteFootprint
  cutPlanByRow.forEach((cp, row) => {
    if (row._batteredLevel) {
      if (!batteredOrigin) batteredOrigin = cp.poly[0];
    } else if (!footprintRef || cp.faceLength > footprintRef.faceLength) {
      footprintRef = { faceLength: cp.faceLength, origin: cp.face.edges[0].from, dir: cp.face.dir };
    }
  });

  const liftResults = [];

  rows.forEach((row) => {
    const rl = row.querySelector(".rl-input").value.trim();
    const mode = row.dataset.mode;
    const embedRangeEl = row.querySelector(".embed-range");
    const embedInput = row.querySelector(".embed-length");

    const strips = row.querySelector(".strip-count");
    const overlapCell = row.querySelector(".overlap-value");
    const areaCell = row.querySelector(".area-value");

    const p = productFor(row);
    const swatchEl = row.querySelector(".product-swatch");
    if (swatchEl) swatchEl.className = "product-swatch swatch" + (p.colorSlot ? ` swatch--${p.colorSlot}` : "");
    let L, result, stripLengths, theoreticalArea, cutPlan = null;

    if (mode === "extents" && row._extentsPoints) {
      cutPlan = cutPlanByRow.get(row) || null;
      if (cutPlan) {
        L = cutPlan.faceLength;
        if (cutPlan.manual) {
          // A manually built row can mix products strip-by-strip, so there's no single overlap/width
          // to report — overlap is left null (every consumer below is expected to check for that and
          // fall back to "mixed" wording) and materialWidth is the true sum of each strip's own width.
          result = {
            n: cutPlan.n,
            overlap: null,
            materialWidth: cutPlan.stripWidths.reduce((s, w) => s + w, 0),
          };
          // Each strip's own product decides its own wrap/lap allowance — not the row's single
          // (now largely nominal) product like the uniform layout below.
          stripLengths = cutPlan.cutLengths.map((len, i) => {
            const spec = productSpecs[cutPlan.stripProductIds[i]];
            return spec && spec.wrapAllowance > 0 ? len + spec.wrapAllowance : len;
          });
        } else {
          result = { n: cutPlan.n, overlap: cutPlan.overlap, materialWidth: cutPlan.materialWidth };
          // Wrap/lap allowance (0 for RE580) adds onto each strip's REAL cut length the same way it
          // adds onto a manually-typed embedment below — the boundary geometry decides where the
          // design footprint ends, the wrap is extra material tacked on beyond that to fold back
          // around the face, same for every strip regardless of how its base length was worked out.
          stripLengths = p.wrapAllowance > 0 ? cutPlan.cutLengths.map((len) => len + p.wrapAllowance) : cutPlan.cutLengths;
        }
        theoreticalArea = cutPlan.polygonArea;
        row.querySelector(".face-length").value = L.toFixed(2);
        const extentsFaceExtendNoteEl = row.querySelector(".face-extend-note");
        if (extentsFaceExtendNoteEl) extentsFaceExtendNoteEl.textContent = "";
        // Hiding the input alone leaves its .field__unit wrapper (border, background, the "m" unit
        // label) rendered as an empty box — the wrapper isn't hidden, just its child. Extents mode
        // has no single embedment to show (every strip cuts to a different length against the
        // boundary), so hide the whole control, not just the number inside it.
        embedInput.parentElement.hidden = true;
        if (stripLengths.length) {
          const lo = Math.min(...stripLengths), hi = Math.max(...stripLengths);
          const loStr = fmt.m(lo), hiStr = fmt.m(hi);
          // lo and hi are rarely bit-identical but often round to the same displayed figure — "8–8 m"
          // reads like a typo/duplicate, not "every strip cuts to about the same length". "cut" is
          // dropped from the text itself (not just this comment) to save column width — the
          // Embedment header above it already says what these lengths are.
          embedRangeEl.textContent = loStr === hiStr ? `${loStr} m` : `${loStr}–${hiStr} m`;
        }
      }
    } else {
      const faceLengthRaw = mode === "coords" ? "" : row.querySelector(".face-length").value;
      L = mode === "coords" ? parseCoordsLength(row.querySelector(".face-coords").value) : parseFloat(faceLengthRaw) || 0;
      const embedRaw = embedInput.value;
      const embed = parseFloat(embedRaw) || 0;
      embedInput.parentElement.hidden = false;
      embedRangeEl.textContent = "";
      result =
        p.oMin < p.w ? (packSide ? packStripsFromSide(L, p.w, p.oMin, packSide) : calcLift(L, p.w, p.oMin)) : null;
      // Extend mode: pin every seam to exactly the minimum overlap and let the face length itself
      // grow to whatever that many strips actually cover, instead of spreading the leftover a whole
      // strip count doesn't quite divide evenly into as extra overlap on every seam. Only for a
      // manually-typed length — extents/benched/battered lifts are already bound to a real boundary,
      // there's no "length" of theirs to extend. Deliberately leaves the .face-length input itself
      // untouched (unlike extents mode, which permanently owns that field) — this is meant to be a
      // freely-toggleable comparison, not a one-way overwrite of the typed approximate value, so
      // switching the setting back off must still find the number the user actually typed.
      // "Pack from one side" (see packStripsFromSide) already keeps every seam at exactly the
      // minimum on its own terms — nothing left to extend the face length over — so it takes
      // priority whenever both settings happen to be on at once.
      const faceExtendNoteEl = row.querySelector(".face-extend-note");
      if (!packSide && result && extendFace && result.n > 1) {
        const extendedL = result.n * (p.w - p.oMin) + p.oMin;
        if (extendedL > L + 1e-9) {
          L = extendedL;
          result = { ...result, overlap: p.oMin, materialWidth: result.n * p.w, excessWidth: result.n * p.w - L };
          if (faceExtendNoteEl) faceExtendNoteEl.textContent = `extended to ${fmt.m(L)} m — fits ${result.n} strips @ exactly ${fmt.mm(p.oMin)} mm`;
        } else if (faceExtendNoteEl) {
          faceExtendNoteEl.textContent = "";
        }
      } else if (faceExtendNoteEl) {
        faceExtendNoteEl.textContent = "";
      }
      if (result && embed > 0) {
        // Strata's wrap/lap allowance (0 for RE580) is extra material tacked onto the real cut
        // length, not part of the design embedment itself — kept separate from "embed" (which
        // stays exactly what's typed) so Fill volume, driven by theoreticalArea below, still
        // reflects real soil footprint rather than how much extra grid gets folded back on itself.
        stripLengths = new Array(result.n).fill(embed + p.wrapAllowance);
        theoreticalArea = L * embed;
      }
      const label = rl || `row ${rows.indexOf(row) + 1}`;
      if (faceLengthRaw && parseFloat(faceLengthRaw) < 0) {
        inputIssues.push(`${label}: face length can't be negative — this row will show as blank until it's fixed.`);
      }
      if (embedRaw && parseFloat(embedRaw) < 0) {
        inputIssues.push(`${label}: embedment can't be negative — this row will show as blank until it's fixed.`);
      }
    }

    if (!result || !L || L <= 0 || !stripLengths || !stripLengths.length) {
      strips.textContent = "—";
      overlapCell.textContent = "—";
      areaCell.textContent = "—";
      strips.classList.add("is-empty");
      overlapCell.classList.add("is-empty");
      areaCell.classList.add("is-empty");
      // A manual-build row with nothing placed yet has nothing to report here, but its boundary and
      // first click-node still need to show up in the Cut Plan tab — push a minimal, empty result
      // rather than dropping the row from that tab entirely until its first strip exists.
      if (cutPlan && cutPlan.manual) {
        liftResults.push({
          rl, L, n: 0, overlap: null, materialWidth: 0,
          stripLengths: [], stripWidths: [], stripProductIds: [], stitchLengths: [],
          area: 0, theoreticalArea: 0, embed: null, cutPlan, mode, row, footprint: null,
          w: p.w, product: p.id, productLabel: p.label,
        });
      }
      return;
    }

    strips.classList.remove("is-empty");
    overlapCell.classList.remove("is-empty");
    areaCell.classList.remove("is-empty");

    strips.textContent = result.n;
    overlapCell.textContent = result.n > 1 ? (result.overlap != null ? `${fmt.mm(result.overlap)} mm` : "mixed") : "—";
    // Every strip's own width — uniform (the row's one product) for a plain automatic row, per-strip
    // for a manually built one OR an automatic row using "Pack from one side" (packStripsFromSide),
    // whose closing strip is narrower than the rest. Threading this through as one array lets
    // area/roll-packing/etc below treat all three cases the same way instead of branching everywhere.
    const stripWidths = (cutPlan && cutPlan.stripWidths) || (result && result.widths) || stripLengths.map(() => p.w);
    const stripProductIds = cutPlan && cutPlan.manual ? cutPlan.stripProductIds : stripLengths.map(() => p.id);
    // Stitch patches (extra material for a boundary pocket a strip's single straight cut can't reach)
    // consume grid too, so they count toward area, roll purchasing, and waste stats same as any strip
    // — each stitch billed at its OWN strip's width, not necessarily the row's.
    const stitchLengths = cutPlan ? cutPlan.stitches.flat().map((s) => s.length) : [];
    const stitchArea = cutPlan
      ? cutPlan.stitches.reduce((sum, group, i) => sum + group.reduce((s, st) => s + st.length * stripWidths[i], 0), 0)
      : 0;
    const area = stripLengths.reduce((s, len, i) => s + stripWidths[i] * len, 0) + stitchArea;
    areaCell.innerHTML = `${fmt.m(area)}<small> m²</small>`;

    const footprint =
      mode === "extents" && cutPlan
        ? row._batteredLevel
          ? absoluteFootprint(cutPlan, batteredOrigin)
          : localFootprint(cutPlan, footprintRef)
        : rectFootprint(L, Math.max(...stripLengths));

    liftResults.push({
      rl,
      L,
      n: result.n,
      overlap: result.overlap,
      materialWidth: result.materialWidth,
      stripLengths,
      stripWidths,
      stripStarts: (cutPlan && cutPlan.stripStarts) || result.starts || null,
      stripProductIds,
      stitchLengths,
      area,
      theoreticalArea,
      embed: mode === "extents" ? null : parseFloat(embedInput.value) || 0,
      cutPlan,
      mode,
      row,
      footprint,
      w: p.w,
      product: p.id,
      productLabel: p.label,
    });
  });

  // Fill volume per lift = its own footprint (theoreticalArea — the net area, not counting overlap
  // waste) times how much fill it took to reach it: the RL gap up from the lift below, or from
  // Base level for the very bottom one. A separate pass over the finished liftResults, not folded
  // into the loop above, because "the lift below" only exists once every row's already been through.
  let prevRL = baseLevel;
  liftResults.forEach((r) => {
    const curRL = parseFloat(r.rl);
    const thickness = Number.isFinite(curRL) && Number.isFinite(prevRL) ? curRL - prevRL : null;
    r.liftThickness = thickness;
    r.fillVolume = thickness > 0 && r.theoreticalArea > 0 ? r.theoreticalArea * thickness : null;
    const volCell = r.row.querySelector(".volume-value");
    if (volCell) {
      if (r.fillVolume != null) {
        volCell.innerHTML = `${fmt.m(r.fillVolume)}<small> m³</small>`;
        volCell.classList.remove("is-empty");
      } else {
        volCell.textContent = "—";
        volCell.classList.add("is-empty");
      }
    }
    if (Number.isFinite(curRL)) prevRL = curRL;
  });

  window.__geogridResults = liftResults; // exposed for CSV export + progress tracking, set before renderSummary needs it
  updateProductDeleteState();
  renderRowWarnings([...inputIssues, ...validateRows(liftResults, productSpecs)]);
  renderSummary(liftResults, productSpecs, rollGroupSize, installRate, baseLevel);
  renderSequence(liftResults);
  renderCutPlan(liftResults);
  render3D(liftResults);
  renderRollSchedule(window.__geogridRolls || [], rollGroupSize);
  renderLiner();
  saveAutosave();
}

/** Rectangle footprint for a uniform-embedment lift, already in the (x = along face, y = depth) local frame. */
function rectFootprint(L, depth) {
  return [
    { x: 0, y: 0 },
    { x: L, y: 0 },
    { x: L, y: depth },
    { x: 0, y: depth },
  ];
}

/**
 * Re-express an extents polygon in a local frame: x along a face direction, y into the fill. Defaults
 * to the lift's own face (origin at its start, its own direction) — right for a single Cut Plan
 * diagram, where each bench is read on its own. Pass an explicit `ref` to project several lifts into
 * one SHARED frame instead, e.g. for 3D stacking, where every lift needs the same origin/direction to
 * preserve their true relative alignment rather than each being independently reset to its own (0,0).
 */
function localFootprint(cutPlan, ref) {
  const origin = ref ? ref.origin : cutPlan.face.edges[0].from;
  const dir = ref ? ref.dir : cutPlan.face.dir;
  const perp = inwardNormal(dir);
  return cutPlan.poly.map((p) => {
    const rx = p.x - origin.x, ry = p.y - origin.y;
    return { x: rx * dir.x + ry * dir.y, y: rx * perp.x + ry * perp.y };
  });
}

/**
 * Re-express an extents polygon for 3D stacking WITHOUT rotating it onto a shared face direction —
 * a straight translation only, same offset for every battered level. localFootprint's shared-frame
 * rotation is right for a hand-drawn extents lift (every lift really does share one face direction,
 * so forcing them onto it just normalises for display) but wrong here: every battered level is
 * already sliced out of the same surface, so they already share one real coordinate system, and a
 * taper's true relative size and position between levels only survives if that's preserved — rotating
 * each one onto its own longest edge would tear that relationship apart instead of showing it.
 */
function absoluteFootprint(cutPlan, origin) {
  return cutPlan.poly.map((p) => ({ x: p.x - origin.x, y: p.y - origin.y }));
}

/**
 * Re-express an extents polygon for the 2D Cut Plan diagram specifically: x = arc-length station
 * along the (possibly multi-segment) face, y = depth in the fixed inward direction cutLengths and
 * frontReach are already measured along. localFootprint above projects onto one straight direction
 * for the whole face, which is right for stacking several lifts in the 3D view, but a real face often
 * bends across a handful of segments — projected that way, the drawn boundary line wobbles above and
 * below where the strips actually start even though the strips themselves tie up to it exactly (they're
 * placed by true arc-length station, not by this projection). Snapping every boundary point to its
 * nearest position ON the face keeps the drawn line and the strips on the same axis, so the face edge
 * always renders as the flat baseline it actually is.
 */
function faceAlignedFootprint(cutPlan) {
  const face = cutPlan.face;
  const inward = inwardNormal(face.dir);
  return cutPlan.poly.map((p) => {
    let best = null;
    let acc = 0;
    for (const e of face.edges) {
      const ex = e.to.x - e.from.x, ey = e.to.y - e.from.y;
      const len2 = ex * ex + ey * ey;
      let t = len2 > 1e-12 ? ((p.x - e.from.x) * ex + (p.y - e.from.y) * ey) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = e.from.x + ex * t, cy = e.from.y + ey * t;
      const dx = p.x - cx, dy = p.y - cy;
      const distSq = dx * dx + dy * dy;
      if (!best || distSq < best.distSq) best = { distSq, station: acc + t * e.len, dx, dy };
      acc += e.len;
    }
    return { x: best.station, y: best.dx * inward.x + best.dy * inward.y };
  });
}

/** Packs one product's own strips onto its own rolls (RE580 and Strata never share a roll — they're
 *  physically different products) and tags each roll with that product's identity/length/cost, so
 *  every downstream consumer (roll cards, CSV, print sheets) can read a roll's own spec off itself
 *  instead of needing a single global rollLength passed alongside it. */
function packRollsForProduct(results, productId, productSpecs, rollGroupSize) {
  const spec = productSpecs[productId];
  // Passed the full, unfiltered results (not pre-filtered to rows whose OWN product matches) — a
  // manually built row can carry strips of several products at once, so which pieces belong here is
  // decided per strip inside buildRollPieces, not by discarding whole rows up front.
  const rolls = packRollsWindowed(results, spec.rollLength, rollGroupSize, productId);
  rolls.forEach((roll) => {
    roll.product = spec.id;
    roll.productLabel = spec.label;
    roll.rollLength = spec.rollLength;
    roll.costPerRoll = spec.costPerRoll;
  });
  return rolls;
}

function renderSummary(results, productSpecs, rollGroupSize, installRate, baseLevel) {
  // Build-order position of each lift — used by buildRollPieces (below, and inside
  // packRollsWindowed) to number rolls in first-used-on-site order. Tagged once, here, so it's set
  // before EITHER caller reads it regardless of which one happens to run first.
  results.forEach((r, i) => (r._buildIndex = i));

  const totalStrips = results.reduce((s, r) => s + r.n, 0);
  const totalArea = results.reduce((s, r) => s + r.area, 0);
  const totalTheoreticalArea = results.reduce((s, r) => s + r.theoreticalArea, 0);
  const overlapWasteArea = totalArea - totalTheoreticalArea;
  const overlapWastePct = totalTheoreticalArea > 0 ? (overlapWasteArea / totalTheoreticalArea) * 100 : 0;

  document.getElementById("statLifts").textContent = fmt.int(results.length);
  document.getElementById("statStrips").textContent = fmt.int(totalStrips);
  document.getElementById("statArea").innerHTML = `${fmt.m(totalArea)}<small> m²</small>`;

  // baseLevel missing means the bottom lift's own volume never gets computed (see the pass in
  // computeAndRender) — the hint fires on that alone, not on whether the total below is zero, so a
  // partial total (every lift but the bottom one) doesn't quietly read as a complete one.
  const totalFillVolume = results.reduce((s, r) => s + (r.fillVolume || 0), 0);
  document.getElementById("statVolume").innerHTML = totalFillVolume > 0 ? `${fmt.m(totalFillVolume)}<small> m³</small>` : "—";
  document.getElementById("statVolumeHint").hidden = baseLevel != null || results.length === 0;

  const wasteOverlapEl = document.getElementById("wasteOverlap");
  if (totalTheoreticalArea > 0) {
    wasteOverlapEl.textContent = `${fmt.m(overlapWasteArea)} m² (${fmt.pct(overlapWastePct)})`;
    wasteOverlapEl.className = `waste-row__pct level-${wasteLevel(overlapWastePct)}`;
  } else {
    wasteOverlapEl.textContent = "—";
    wasteOverlapEl.className = "waste-row__pct";
  }

  // Every individual strip length across the whole project (plus any stitch patches) — for the
  // readable breakdown table below, and for the pooled cross-level roll schedule.
  const allLengths = results.flatMap((r) => [...r.stripLengths, ...(r.stitchLengths || [])]);

  // Bucket into 100mm bands purely for the readable breakdown table.
  const buckets = new Map();
  allLengths.forEach((len) => {
    const key = Math.round(len * 10) / 10;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  });
  const rollTableBody = document.getElementById("rollTableBody");
  rollTableBody.innerHTML = "";
  Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .forEach(([len, count]) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${fmt.m(len)} m</td><td>${fmt.int(count)}</td>`;
      rollTableBody.appendChild(tr);
    });

  // Pack every strip/stitch onto numbered rolls (see Roll schedule tab) — the same packing drives
  // both this summary and that tab, so they always agree. Pooled across every lift by default (fewest
  // rolls); optionally restricted to bands of `rollGroupSize` adjacent lifts so a roll never mixes
  // pieces from opposite ends of the job (see packRollsWindowed). Every product is packed
  // separately (different physical roll, different length) then merged back into one on-site
  // numbering order by first-used sequence, same as packRollsWindowed does within a single product.
  const rolls = products.flatMap((p) => packRollsForProduct(results, p.id, productSpecs, rollGroupSize));
  rolls.sort((a, b) => Math.min(...a.pieces.map((p) => p.seq)) - Math.min(...b.pieces.map((p) => p.seq)));
  window.__geogridRolls = rolls;

  document.getElementById("statRolls").textContent = fmt.int(rolls.length);

  // Both blank/zero by default (see readSettings) — a project with no cost or rate entered shows
  // "—", not a $0/instant estimate that would misread as a real answer rather than missing input.
  // The hint span (separate from the value itself, so it never leaks into the CSV/PDF exports that
  // read statCost/statInstallTime's own textContent) explains why, instead of just looking blank.
  // A mixed-product job needs BOTH products' cost/roll filled in for the total to be complete — the
  // hint fires if either used product is still missing its cost, not just when both are.
  const usedProducts = new Set(rolls.map((roll) => roll.product));
  const missingCost = Array.from(usedProducts).some((id) => !(productSpecs[id].costPerRoll > 0));
  const totalCost = rolls.reduce((s, roll) => s + (roll.costPerRoll > 0 ? roll.costPerRoll : 0), 0);
  document.getElementById("statCost").textContent = totalCost > 0 ? fmt.cost(totalCost) : "—";
  document.getElementById("statCostHint").hidden = rolls.length === 0 || !missingCost;
  const installDays = installRate > 0 ? Math.ceil((totalArea / installRate) * 2) / 2 : 0;
  document.getElementById("statInstallTime").textContent = installDays > 0 ? `${fmt.m(installDays)} day${installDays === 1 ? "" : "s"}` : "—";
  document.getElementById("statInstallTimeHint").hidden = installDays > 0;

  const purchased = rolls.reduce((s, roll) => s + roll.rollLength, 0);
  const extraTotal = rolls.reduce((s, roll) => s + roll.pieces.reduce((s2, p) => s2 + p.extra, 0), 0);
  const extraPct = purchased > 0 ? (extraTotal / purchased) * 100 : 0;
  const wasteOffcutEl = document.getElementById("wasteOffcut");
  if (purchased > 0) {
    wasteOffcutEl.textContent = `${fmt.m(extraTotal)} m (${fmt.pct(extraPct)})`;
    wasteOffcutEl.className = `waste-row__pct level-${wasteLevel(extraPct)}`;
  } else {
    wasteOffcutEl.textContent = "—";
    wasteOffcutEl.className = "waste-row__pct";
  }

  updateProgressStats();
}

/* ============================================================
   Installation sequence view
   ============================================================ */

const tabTakeoff = document.getElementById("tabTakeoff");
const tabSequence = document.getElementById("tabSequence");
const tabCutPlan = document.getElementById("tabCutPlan");
const tab3D = document.getElementById("tab3D");
const tabRolls = document.getElementById("tabRolls");
const tabLiner = document.getElementById("tabLiner");
const takeoffView = document.getElementById("takeoffView");
const sequenceView = document.getElementById("sequenceView");
const cutPlanView = document.getElementById("cutPlanView");
const view3DPanel = document.getElementById("view3DPanel");
const rollScheduleView = document.getElementById("rollScheduleView");
const linerView = document.getElementById("linerView");
const staggerToggle = document.getElementById("staggerToggle");
const sequenceList = document.getElementById("sequenceList");
const cutPlanList = document.getElementById("cutPlanList");
const cutPlanEmpty = document.getElementById("cutPlanEmpty");

tabTakeoff.addEventListener("click", () => switchTab("takeoff"));
tabSequence.addEventListener("click", () => switchTab("sequence"));
tabCutPlan.addEventListener("click", () => switchTab("cutplan"));
tab3D.addEventListener("click", () => switchTab("view3d"));
tabRolls.addEventListener("click", () => switchTab("rolls"));
tabLiner.addEventListener("click", () => switchTab("liner"));

/* On a narrow phone several strips of content don't all fit and have to scroll horizontally — the
 * lift-panel tabs, and the takeoff/roll tables (min-width: 690px, see .table-scroll) — without a
 * visual cue for that, whatever sits just past the visible edge (the Cut plan tab, the table's
 * Strips/Overlap/Area/Layout columns) is invisible and easy to miss entirely. Fades whichever edge
 * still has more to scroll to, based on real scroll position (has-more-left/has-more-right,
 * toggled on scroll+resize). `scrollEl` is the element that actually scrolls; `fadeEl` is what
 * carries those classes for the CSS to read — usually the same element, but the tab strip needs a
 * separate non-scrolling wrapper since the fade has to stay fixed while the tabs scroll under it. */
function setupScrollFade(scrollEl, fadeEl) {
  if (!scrollEl || !fadeEl) return;
  function update() {
    const maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth;
    fadeEl.classList.toggle("has-more-left", scrollEl.scrollLeft > 4);
    fadeEl.classList.toggle("has-more-right", scrollEl.scrollLeft < maxScroll - 4);
  }
  scrollEl.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  update();
}
setupScrollFade(document.querySelector(".tabs"), document.querySelector(".tabs-wrap"));
document.querySelectorAll(".table-scroll").forEach((el) => setupScrollFade(el, el));
staggerToggle.addEventListener("change", computeAndRender);
document.getElementById("printSequenceBtn").addEventListener("click", () => window.print());

/**
 * Reverse-map each roll's pieces back to "which roll did this strip come from", keyed by each
 * piece's own `key` (buildRollPieces — liftId + strip index, NOT the "RL <rl> · Strip <n>" display
 * label, which several rows can legitimately share when they're different products/sections on the
 * same physical lift; keying by that text alone would silently merge their roll numbers together).
 * A piece longer than one roll is split across several ("... (1/2)", "... (2/2)") but keeps the same
 * key throughout, so those still collapse back onto one strip with multiple roll numbers.
 */
function buildRollLookup(rolls) {
  const map = new Map();
  rolls.forEach((roll, idx) => {
    roll.pieces.forEach((piece) => {
      if (!piece.key) return;
      if (!map.has(piece.key)) map.set(piece.key, new Set());
      map.get(piece.key).add(idx + 1);
    });
  });
  return map;
}

function rollNumbersForLabel(key, rollLookup) {
  const rolls = rollLookup.get(key);
  return rolls ? Array.from(rolls).sort((a, b) => a - b).join(",") : "";
}

function stripRollNumbersFor(r, rollLookup) {
  const liftId = r.row.dataset.liftId;
  return r.stripLengths.map((_, i) => rollNumbersForLabel(`${liftId}::strip${i + 1}`, rollLookup));
}

/** Renders the same small plan diagram as the on-screen Cut Plan card, as a standalone SVG string. */
function buildCutPlanSvgMarkup(cutPlan, w, stripRollNumbers) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 400 260");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("class", "cutplan-print-page__plan");
  renderCutPlanSvg(svg, cutPlan, w, stripRollNumbers);
  return svg.outerHTML;
}

/** One <section class="cutplan-print-page"> per extents lift — shared by the Cut Plan print button and the full export.
 *  Folds in the installation-sequence steps (build order, stagger note, next fill target) and the
 *  "Installed" checkbox too, so this one sheet is everything a crew needs for that level — no need to
 *  separately print the Installation sequence tab and flip between two sheets on site. */
function buildCutPlanPrintPages(results, project) {
  const rolls = window.__geogridRolls || [];
  const rollLookup = buildRollLookup(rolls);
  const allResults = window.__geogridResults || results;
  const stagger = document.getElementById("staggerToggle").checked;
  return results
    .map((r) => {
      const buildIndex = allResults.indexOf(r);
      const next = buildIndex >= 0 ? allResults[buildIndex + 1] : null;
      const fillTarget = next ? `RL ${escapeHtml(next.rl)}` : "final design surface";
      let staggerNote = "";
      if (stagger && r.n > 1 && buildIndex >= 0 && r.overlap != null) {
        const pitch = r.w - r.overlap;
        const offsetMm = Math.round((pitch / 2) * 1000);
        staggerNote =
          buildIndex % 2 === 1
            ? `Offset the first strip ${offsetMm.toLocaleString()} mm in from the left edge (not flush) to stagger lap joints from the lift below.`
            : buildIndex > 0
            ? "Start the first strip flush with the left edge."
            : "";
      }
      const installed = isLiftInstalled(r.row.dataset.liftId);
      const stripRollNumbers = stripRollNumbersFor(r, rollLookup);
      const stitchCount = r.cutPlan.stitches.reduce((s, arr) => s + arr.length, 0);
      const rollsUsed = new Set();
      const rows = r.stripLengths
        .map((len, i) => {
          const rollNums = stripRollNumbers[i];
          rollNums.split(",").filter(Boolean).forEach((n) => rollsUsed.add(+n));
          const mainRow = `<tr><td>${i + 1}</td><td>${fmt.m(len)} m</td><td>${rollNums}</td><td>Cut</td></tr>`;
          const stitchRows = (r.cutPlan.stitches[i] || [])
            .map((s, si) => {
              const suffix = r.cutPlan.stitches[i].length > 1 ? `.${si + 1}` : "";
              const stitchRolls = rollNumbersForLabel(`${r.row.dataset.liftId}::strip${i + 1}${suffix}::stitch`, rollLookup);
              stitchRolls.split(",").filter(Boolean).forEach((n) => rollsUsed.add(+n));
              return `<tr class="is-stitch"><td>${i + 1}${suffix}</td><td>${fmt.m(s.length)} m</td><td>${stitchRolls}</td><td>Stitch, starts ${fmt.m(s.offset)} m back</td></tr>`;
            })
            .join("");
          return mainRow + stitchRows;
        })
        .join("");
      const metaParts = [`${r.n} strips`, `face ${fmt.m(r.L)} m`];
      if (stitchCount) metaParts.push(`${stitchCount} stitch patch${stitchCount === 1 ? "" : "es"}`);
      metaParts.push(`roll width ${fmt.m(r.materialWidth / r.n)} m`);

      // Every roll this lift draws from, shown as the same fill bar used on the Roll schedule tab —
      // a roll's leftover space here often belongs to a DIFFERENT lift (that's the whole point of
      // pooling rolls to avoid waste), so this shows the true, complete picture for each roll, not
      // just this lift's slice of it.
      const rollsSection = rollsUsed.size
        ? `
            <div class="cutplan-print-page__rolls">
              <h4>Rolls used on this page</h4>
              ${Array.from(rollsUsed)
                .sort((a, b) => a - b)
                .map((n) => buildRollCardHtml(rolls[n - 1], n - 1))
                .join("")}
            </div>
          `
        : "";

      const orderBadge = buildIndex >= 0 ? `<span class="cutplan-print-page__order">${buildIndex + 1}</span>` : "";
      return `
        <section class="cutplan-print-page">
          <div class="cutplan-print-page__head">
            ${orderBadge}
            <div>
              <h3>${escapeHtml(project)} — RL ${escapeHtml(r.rl)}</h3>
              <p>${metaParts.join(" · ")}</p>
            </div>
            <label class="checkbox cutplan-print-page__installed">
              <input type="checkbox" disabled ${installed ? "checked" : ""} />
              <span>Installed</span>
            </label>
          </div>
          <ol class="cutplan-print-page__steps">
            <li>Roll out ${r.n} strip${r.n === 1 ? "" : "s"} per the cut lengths below${
              r.n > 1 ? (r.overlap != null ? `, lapping each by ${fmt.mm(r.overlap)} mm` : ", lapping each strip by its own product's overlap — mixed products on this lift, see the strip list") : ""
            }.</li>
            <li>Pin/stake the grid as required, then place and compact fill up to ${fillTarget}.</li>
          </ol>
          ${staggerNote ? `<div class="cutplan-print-page__stagger">${escapeHtml(staggerNote)}</div>` : ""}
          <div class="cutplan-print-page__body">
            ${buildCutPlanSvgMarkup(r.cutPlan, r.w, stripRollNumbers)}
            <table class="cutplan-print-table">
              <thead><tr><th>Strip #</th><th>Cut length</th><th>Roll #</th><th>Note</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          ${rollsSection}
        </section>
      `;
    })
    .join("");
}

document.getElementById("printCutPlanBtn").addEventListener("click", () => {
  const results = window.__geogridCutPlanResults || [];
  const project = document.getElementById("projectName").value || "GeoMate";
  document.getElementById("cutPlanPrintView").innerHTML = buildCutPlanPrintPages(results, project);
  document.body.classList.add("printing-cutplan");
  window.print();
});

window.addEventListener("afterprint", () => {
  document.body.classList.remove("printing-cutplan");
  document.body.classList.remove("printing-full");
  document.body.classList.remove("printing-rolls");
  document.body.classList.remove("printing-roll-labels");
});

document.getElementById("exportFullPdfBtn").addEventListener("click", () => {
  const results = window.__geogridResults || [];
  const project = document.getElementById("projectName").value || "GeoMate";

  const coverSheet = `
    <section class="export-sheet">
      <h2>${escapeHtml(project)} — material schedule</h2>
      <dl class="export-sheet__stats">
        <div><dt>Lifts</dt><dd>${fmt.int(document.querySelectorAll("#liftTableBody .lift-row").length)}</dd></div>
        <div><dt>Total strips</dt><dd>${document.getElementById("statStrips").textContent}</dd></div>
        <div><dt>Grid area</dt><dd>${document.getElementById("statArea").textContent}</dd></div>
        <div><dt>Fill volume</dt><dd>${document.getElementById("statVolume").textContent}</dd></div>
        <div><dt>Rolls to order</dt><dd>${document.getElementById("statRolls").textContent}</dd></div>
        <div><dt>Overlap waste</dt><dd>${document.getElementById("wasteOverlap").textContent}</dd></div>
        <div><dt>Roll off-cut</dt><dd>${document.getElementById("wasteOffcut").textContent}</dd></div>
        <div><dt>Material cost</dt><dd>${document.getElementById("statCost").textContent}</dd></div>
        <div><dt>Est. install time</dt><dd>${document.getElementById("statInstallTime").textContent}</dd></div>
      </dl>
    </section>
  `;

  const takeoffRows = results
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.rl)}</td>
        <td>${fmt.m(r.L)}</td>
        <td>${r.mode === "extents" ? "variable" : fmt.m(r.embed)}</td>
        <td>${r.n}</td>
        <td>${r.n > 1 ? (r.overlap != null ? fmt.mm(r.overlap) + " mm" : "mixed") : "—"}</td>
        <td>${fmt.m(r.area)}</td>
        <td>${r.fillVolume != null ? fmt.m(r.fillVolume) : "—"}</td>
      </tr>`
    )
    .join("");
  const takeoffSheet = `
    <section class="export-sheet">
      <h2>Takeoff table</h2>
      <table class="export-table">
        <thead><tr><th>RL</th><th>Face length (m)</th><th>Embedment (m)</th><th>Strips</th><th>Overlap</th><th>Area (m²)</th><th>Fill volume (m³)</th></tr></thead>
        <tbody>${takeoffRows}</tbody>
      </table>
    </section>
  `;

  const seqRows = results
    .map((r, i) => {
      const next = results[i + 1];
      const fillTarget = next ? `RL ${escapeHtml(next.rl) || "next lift"}` : "final design surface";
      const embedText = r.mode === "extents" ? `${fmt.m(Math.min(...r.stripLengths))}–${fmt.m(Math.max(...r.stripLengths))} m (cut plan)` : `${fmt.m(r.embed)} m`;
      return `<tr>
        <td>${i + 1}</td><td>${escapeHtml(r.rl)}</td><td>${r.n}</td>
        <td>${r.n > 1 ? (r.overlap != null ? fmt.mm(r.overlap) + " mm" : "mixed") : "—"}</td><td>${embedText}</td><td>Fill to ${fillTarget}</td>
      </tr>`;
    })
    .join("");
  const sequenceSheet = `
    <section class="export-sheet">
      <h2>Installation sequence</h2>
      <table class="export-table">
        <thead><tr><th>Order</th><th>RL</th><th>Strips</th><th>Overlap</th><th>Embedment</th><th>Then</th></tr></thead>
        <tbody>${seqRows}</tbody>
      </table>
    </section>
  `;

  const extentsResults = results.filter((r) => r.mode === "extents" && r.cutPlan);
  const cutPlanSheets = extentsResults.length ? buildCutPlanPrintPages(extentsResults, project) : "";

  // toDataURL() snapshots whatever's currently painted — if the user is in dark mode (toggled or
  // just their OS preference), that bakes dark-theme colours (near-white "ink" labels especially)
  // into a static PNG that then gets pasted onto the print stylesheet's forced-white page, same as
  // the washed-out-text bug the print CSS itself had — except this is a rasterised image, so no
  // amount of @media print CSS can fix it after the fact. Force a light-theme repaint just for the
  // snapshot, then restore whatever the canvas should actually look like on screen afterward.
  let canvasDataUrl = null;
  if (view3DCanvas) {
    const prevTheme = document.documentElement.getAttribute("data-theme");
    document.documentElement.setAttribute("data-theme", "light");
    if (window.__geogridResults) render3D(window.__geogridResults);
    canvasDataUrl = view3DCanvas.toDataURL("image/png");
    if (prevTheme === null) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", prevTheme);
    if (window.__geogridResults) render3D(window.__geogridResults);
  }
  const view3dSheet = canvasDataUrl
    ? `<section class="export-sheet export-sheet__3d"><h2>3D view</h2><img src="${canvasDataUrl}" alt="3D stacked view of all lifts" /></section>`
    : "";

  const rolls = window.__geogridRolls || [];
  const rollCards = rolls.map((roll, i) => buildRollCardHtml(roll, i)).join("");
  const rollSheet = rolls.length
    ? `<section class="export-sheet"><h2>Roll cutting schedule</h2><div class="roll-schedule-list">${rollCards}</div></section>`
    : "";

  document.getElementById("fullExportPrintView").innerHTML = coverSheet + takeoffSheet + sequenceSheet + cutPlanSheets + view3dSheet + rollSheet;
  document.body.classList.add("printing-full");
  window.print();
});

const TABS = {
  takeoff: { tab: tabTakeoff, view: takeoffView },
  sequence: { tab: tabSequence, view: sequenceView },
  cutplan: { tab: tabCutPlan, view: cutPlanView },
  view3d: { tab: tab3D, view: view3DPanel },
  rolls: { tab: tabRolls, view: rollScheduleView },
  liner: { tab: tabLiner, view: linerView },
};

function switchTab(which) {
  Object.entries(TABS).forEach(([key, { tab, view }]) => {
    const active = key === which;
    view.hidden = !active;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  document.getElementById("addLiftBtn").hidden = which !== "takeoff";
  if (which === "view3d" && window.__geogridResults) render3D(window.__geogridResults);
}

function renderSequence(results) {
  sequenceList.innerHTML = "";
  const stagger = staggerToggle.checked;
  const productSpecs = readProductSpecs();

  results.forEach((r, i) => {
    const li = document.createElement("li");
    li.className = "sequence-card";
    const installed = isLiftInstalled(r.row.dataset.liftId);
    if (installed) li.classList.add("is-installed");

    let staggerNote = "";
    if (stagger && r.n > 1 && r.overlap != null) {
      const pitch = r.w - r.overlap;
      const offsetMm = Math.round((pitch / 2) * 1000);
      staggerNote =
        i % 2 === 1
          ? `<div class="sequence-card__stagger">Offset the first strip ${offsetMm.toLocaleString()} mm in from the left edge (not flush) to stagger lap joints from the lift below.</div>`
          : i > 0
          ? `<div class="sequence-card__stagger">Start the first strip flush with the left edge.</div>`
          : "";
    }

    const next = results[i + 1];
    const fillTarget = next ? `RL ${escapeHtml(next.rl) || "the next lift"}` : "final design surface";
    const embedText =
      r.mode === "extents"
        ? `cut individually per the Cut Plan tab (${fmt.m(Math.min(...r.stripLengths))}–${fmt.m(Math.max(...r.stripLengths))} m)`
        : `embedded ${fmt.m(r.embed)} m back into the fill`;

    li.innerHTML = `
      <div class="sequence-card__head">
        <span class="sequence-card__order">${i + 1}</span>
        <span class="sequence-card__rl">RL ${escapeHtml(r.rl) || "—"}</span>
        <label class="checkbox sequence-card__installed">
          <input type="checkbox" class="sequence-card__installed-input" ${installed ? "checked" : ""} />
          <span>Installed</span>
        </label>
      </div>
      <ol class="sequence-card__steps">
        <li>Roll out ${r.n} strip${r.n === 1 ? "" : "s"} across the ${fmt.m(r.L)} m face${
      r.n > 1 ? (r.overlap != null ? `, lapping each by ${fmt.mm(r.overlap)} mm` : ", lapping each strip by its own product's overlap — mixed products on this lift") : ""
    }, ${embedText}.</li>
        <li>Pin/stake the grid as required, then place and compact fill up to ${fillTarget}.</li>
      </ol>
      ${staggerNote}
      <svg class="sequence-card__diagram" viewBox="0 0 480 40" preserveAspectRatio="none"></svg>
    `;

    sequenceList.appendChild(li);
    const svg = li.querySelector(".sequence-card__diagram");
    if (r.cutPlan && r.cutPlan.manual) {
      renderDiagramManual(svg, r.L, r.cutPlan, productSpecs, 480, 40);
    } else {
      renderDiagram(
        svg,
        r.L,
        { n: r.n, overlap: r.overlap, materialWidth: r.materialWidth, starts: r.stripStarts, widths: r.stripStarts ? r.stripWidths : null },
        r.w,
        480,
        40
      );
    }

    li.querySelector(".sequence-card__installed-input").addEventListener("change", (e) => {
      setLiftInstalled(r.row.dataset.liftId, e.target.checked);
      li.classList.toggle("is-installed", e.target.checked);
      updateProgressStats();
    });
  });
}

/* ============================================================
   Cut plan view + DXF extents upload
   ============================================================ */

document.getElementById("dxfExtentsInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const statusEl = document.getElementById("dxfExtentsStatus");
  if (!file) return;

  try {
    const text = await file.text();
    const polygons = parseDXFPolygons(text);
    if (!polygons.length) {
      statusEl.textContent = "No closed polylines found in that file.";
      statusEl.className = "cutplan-status is-error";
      return;
    }

    // Which product this whole file is for (see the select next to the upload button) — a second
    // file for a different product at RLs the first file already used should add alongside those
    // rows, never quietly take one over. Matching below only ever considers an existing row a
    // candidate when its own product already matches, so a same-RL row belonging to a different
    // product is invisible to it and gets left alone; every newly created row is tagged with this
    // product too, rather than whatever the table's very first product happens to default to.
    const uploadProductId = document.getElementById("dxfExtentsProduct")?.value || products[0]?.id;
    const uploadProductName = productFieldEl(uploadProductId, "name")?.value.trim() || uploadProductId;
    const rowProductId = (row) => row.querySelector(".product-select").value;

    const hasZ = polygons.some((p) => Math.abs(p.meanZ) > 1e-6);
    const rows = Array.from(tbody.querySelectorAll(".lift-row"));
    let matched = 0;

    if (hasZ) {
      // Match each row to the polygon whose elevation is closest to that row's own RL — not by
      // sorted position — so a table that doesn't have exactly one row per polygon (extra/missing
      // lifts, intermediate grids) can't silently shift every later match onto the wrong RL. Only
      // rows already on this upload's product are eligible, per the comment above.
      const ELEV_TOL = 0.03; // metres
      const used = new Set();
      rows.forEach((row) => {
        if (rowProductId(row) !== uploadProductId) return;
        const rl = parseFloat(row.querySelector(".rl-input").value);
        if (!Number.isFinite(rl)) return;
        let best = -1, bestDiff = Infinity;
        polygons.forEach((p, idx) => {
          if (used.has(idx)) return;
          const diff = Math.abs(p.meanZ - rl);
          if (diff < bestDiff) { bestDiff = diff; best = idx; }
        });
        if (best !== -1 && bestDiff <= ELEV_TOL) {
          applyExtents(row, polygons[best].points);
          used.add(best);
          matched++;
        }
      });

      // Every polygon carries its own elevation already, so one that didn't match an existing row
      // of its product (most commonly: there was no row at all yet) gets a brand-new lift row
      // created at that elevation, inserted in RL order — uploading extents alone is enough to
      // build the table.
      let created = 0;
      polygons.forEach((p, idx) => {
        if (used.has(idx)) return;
        const currentRows = Array.from(tbody.querySelectorAll(".lift-row"));
        const insertBefore =
          currentRows.find((row) => {
            const rl = parseFloat(row.querySelector(".rl-input").value);
            return Number.isFinite(rl) && rl > p.meanZ + 1e-9;
          }) || null;
        const newRow = addLiftRow(p.meanZ.toFixed(2), "", "", insertBefore);
        newRow.querySelector(".product-select").value = uploadProductId;
        applyExtents(newRow, p.points);
        created++;
        matched++;
      });

      const parts = [];
      const matchedExisting = matched - created;
      if (matchedExisting) parts.push(`matched ${matchedExisting} existing ${uploadProductName} lift${matchedExisting === 1 ? "" : "s"} by RL`);
      if (created) parts.push(`created ${created} new ${uploadProductName} lift row${created === 1 ? "" : "s"} from the DXF's own elevations`);
      statusEl.textContent = `${polygons.length} extents loaded${parts.length ? " — " + parts.join(", ") + "." : "."}`;
    } else {
      // No elevation data to anchor a product-aware match against — falls back to matching this
      // upload's product rows in file order, same "verify against RL order" caveat as always.
      const productRows = rows.filter((row) => rowProductId(row) === uploadProductId);
      const count = Math.min(productRows.length, polygons.length);
      for (let i = 0; i < count; i++) applyExtents(productRows[i], polygons[i].points);
      matched = count;
      statusEl.textContent = `Matched ${count} of ${polygons.length} extents to ${productRows.length} ${uploadProductName} lift${productRows.length === 1 ? "" : "s"} (file order — verify against RL order).`;
    }
    statusEl.className = matched ? "cutplan-status is-ok" : "cutplan-status is-error";
    switchTab("cutplan");
    computeAndRender();
  } catch (err) {
    statusEl.textContent = `Couldn't read that file: ${err.message}`;
    statusEl.className = "cutplan-status is-error";
  } finally {
    e.target.value = "";
  }
});

document.getElementById("dxfLengthsInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const statusEl = document.getElementById("dxfLengthsStatus");
  if (!file) return;

  try {
    const text = await file.text();
    const entities = parseDXFEntityLengths(text).filter((en) => en.length > 0);
    if (!entities.length) {
      statusEl.textContent = "No LINE/LWPOLYLINE/POLYLINE entities with a measurable length found in that file.";
      statusEl.className = "cutplan-status is-error";
      return;
    }

    const hasZ = entities.some((en) => Math.abs(en.meanZ) > 1e-6);
    if (hasZ) entities.sort((a, b) => a.meanZ - b.meanZ);

    const rows = Array.from(tbody.querySelectorAll(".lift-row"));
    const count = Math.min(rows.length, entities.length);
    for (let i = 0; i < count; i++) {
      const row = rows[i];
      if (row.dataset.mode === "extents") releaseExtents(row);
      if (row.dataset.mode === "coords") {
        row.dataset.mode = "length";
        row.querySelector(".mode-toggle").textContent = "L";
        row.querySelector(".face-input__length").hidden = false;
        row.querySelector(".face-coords").hidden = true;
      }
      row.querySelector(".face-length").value = entities[i].length.toFixed(3);
    }

    statusEl.textContent = `Matched ${count} of ${entities.length} polylines to ${rows.length} lift${rows.length === 1 ? "" : "s"}${
      hasZ ? " (sorted by elevation)" : " (file order — verify against RL order)"
    }.`;
    statusEl.className = "cutplan-status is-ok";
    computeAndRender();
  } catch (err) {
    statusEl.textContent = `Couldn't read that file: ${err.message}`;
    statusEl.className = "cutplan-status is-error";
  } finally {
    e.target.value = "";
  }
});

/** Shared by every "raw surface mesh" upload (DXF 3DFACE, LandXML, …) — parseFn(text) must return an array of triangles. */
function wireMeshUpload(inputId, parseFn, noTrianglesMessage) {
  document.getElementById(inputId).addEventListener("change", async (e) => {
    const file = e.target.files[0];
    const statusEl = document.getElementById("benchedStatus");
    if (!file) return;

    try {
      const text = await file.text();
      const triangles = parseFn(text);
      if (!triangles.length) {
        statusEl.textContent = noTrianglesMessage;
        statusEl.className = "cutplan-status is-error";
        return;
      }

      const tol = (parseFloat(document.getElementById("benchedTolerance").value) || 0) / 1000;
      const rows = Array.from(tbody.querySelectorAll(".lift-row"));
      let matched = 0, ambiguous = 0;

      rows.forEach((row) => {
        const rl = parseFloat(row.querySelector(".rl-input").value);
        if (!Number.isFinite(rl)) return;
        const loops = benchBoundaryAt(triangles, rl, tol);
        if (!loops.length) return;
        applyExtents(row, loops[0]);
        matched++;
        if (loops.length > 1) ambiguous++;
      });

      statusEl.textContent = matched
        ? `Found a bench for ${matched} of ${rows.length} lifts from ${triangles.length} triangles${
            ambiguous ? ` (${ambiguous} had more than one candidate — used the largest)` : ""
          }.`
        : `No flat bench found within ${Math.round(tol * 1000)} mm of any lift's RL — try a looser tolerance.`;
      statusEl.className = matched ? "cutplan-status is-ok" : "cutplan-status is-error";
      switchTab("cutplan");
      computeAndRender();
    } catch (err) {
      statusEl.textContent = `Couldn't read that file: ${err.message}`;
      statusEl.className = "cutplan-status is-error";
    } finally {
      e.target.value = "";
    }
  });
}

wireMeshUpload("dxfBenchedInput", parseDXF3DFaces, "No 3DFACE triangles found in that file.");
wireMeshUpload("landxmlBenchedInput", parseLandXMLSurface, "No TIN surface (Pnts/Faces) found in that LandXML file.");

/**
 * From a full excavation surface (already dug, all sides), builds one extents-mode lift row per
 * target RL — no pre-existing rows or hand-drawn extents needed. This is a fill sequence, not a
 * facing sequence: one horizontal grid layer goes down at each level, running in a single direction
 * across the whole footprint, reaching out to whatever the cut is in every direction — not a separate
 * independently-oriented layer per wall. So each RL is sliced horizontally (sliceMeshAt) into the
 * excavation's outline at that depth, and that WHOLE outline becomes one lift's extents, same as a
 * hand-drawn closed polyline in the existing "Upload extents DXF" workflow — computeCutPlan already
 * picks the longest edge as the nominal face and clips every strip against the rest of the boundary,
 * exactly the "reaches out to the cut in every direction" behaviour this needs.
 */
function buildBatteredLiftRows(triangles, targetRLs) {
  const rows = [];
  const skippedRLs = [];
  const partialRLs = new Set(); // RLs where the top of cut is uneven enough that the wall on one side
  // had already ended (daylighted into original ground) before this RL, so the ring isn't fully closed.

  targetRLs.forEach((rl) => {
    // A target RL sitting exactly on the surface's own lowest/highest point can't be sliced — a
    // plane exactly there touches the surface without crossing it. Rather than count that as
    // "outside the surface" and short the requested Count by one, nudge a hair off the exact
    // elevation and try again; the row still reports as the RL actually asked for, not the nudged
    // one. Only a genuinely out-of-range RL (nudging either way still finds nothing) gets skipped.
    let loops = sliceMeshAt(triangles, rl).filter((l) => l.points.length >= 3);
    if (!loops.length) {
      const nudge = 1e-4;
      loops = sliceMeshAt(triangles, rl + nudge).filter((l) => l.points.length >= 3);
      if (!loops.length) loops = sliceMeshAt(triangles, rl - nudge).filter((l) => l.points.length >= 3);
    }
    if (!loops.length) {
      skippedRLs.push(rl);
      return;
    }

    // An open chain means part of the boundary genuinely doesn't exist at this RL (that section's
    // wall already ended below here) — close it with a straight line directly between its two ends
    // so the standard closed-boundary clipping math still has a well-defined "inside", same as a
    // hand-drawn extents polygon always has. Where more than one loop was found, the largest by area
    // is the real excavation outline; anything else is noise/an artifact of the triangulation.
    const closedPolys = loops.map((loop) => ({ loop, poly: ensureCCW(loop.closed ? loop.points.slice(0, -1) : loop.points) }));
    const best = closedPolys.reduce((a, b) => (Math.abs(signedArea(a.poly)) >= Math.abs(signedArea(b.poly)) ? a : b));
    if (best.poly.length < 3) {
      skippedRLs.push(rl);
      return;
    }

    if (!best.loop.closed) partialRLs.add(rl);
    rows.push({ rl, points: best.poly });
  });

  return { rows, skippedRLs, partialRLs };
}

// Kept after a successful upload so Start RL/Spacing/Count can be tweaked and re-run against the
// SAME surface via rebuildBatteredBtn — re-picking the file from a dialog every time just to try a
// different spacing is real friction, and it invites exactly the confusion of editing the fields
// then reading a status line that's still reporting the previous settings.
let lastBatteredTriangles = null;

/** Slices lastBatteredTriangles/triangles at the RLs implied by the current Start RL/Spacing/Count fields
 *  and rebuilds the lift table from them. Shared by the upload handlers and the "Rebuild rows" button. */
function runBatteredSurfaceBuild(triangles) {
  const statusEl = document.getElementById("batteredStatus");

  const spacingMm = parseFloat(document.getElementById("batteredSpacing").value) || 0;
  if (!(spacingMm > 0)) {
    statusEl.textContent = "Enter a spacing first.";
    statusEl.className = "cutplan-status is-error";
    return;
  }
  const spacing = spacingMm / 1000;

  // Start RL / Count are optional — the surface already knows its own elevation range, so
  // there's no reason to make someone work that out by hand before they've even picked a file.
  // Left blank: start one spacing above the surface's lowest point and take as many further
  // steps as fit below its highest point (build order is bottom-up). The floor itself and the
  // original rim aren't wall levels needing their own grid, and neither can actually be sliced
  // anyway — a horizontal plane exactly at a surface's own min/max never crosses it, only touches
  // it. Either field still overrides if set, including setting Start RL to the exact floor/rim.
  const zs = triangles.flat().map((p) => p.z);
  const meshMin = Math.min(...zs), meshMax = Math.max(...zs);

  const startRaw = document.getElementById("batteredStartRL").value;
  const start = startRaw.trim() === "" ? meshMin + spacing : parseFloat(startRaw);
  if (!Number.isFinite(start)) {
    statusEl.textContent = "Start RL isn't a valid number.";
    statusEl.className = "cutplan-status is-error";
    return;
  }

  // Tiny epsilon so an exact-multiple range (e.g. exactly 1.000m of relief at exactly 0.500m
  // spacing) doesn't compute a last step sitting exactly on meshMax, which — like meshMin — can
  // never actually slice; better to just not offer that step than have it silently skip.
  const countRaw = document.getElementById("batteredCount").value;
  const count = countRaw.trim() === "" ? Math.max(1, Math.floor((meshMax - start - 1e-6) / spacing) + 1) : Math.round(parseFloat(countRaw));
  if (!Number.isFinite(count) || count < 1) {
    statusEl.textContent = "Count isn't a valid number.";
    statusEl.className = "cutplan-status is-error";
    return;
  }

  document.getElementById("batteredStartRL").value = start.toFixed(2);
  document.getElementById("batteredCount").value = count;
  const targetRLs = Array.from({ length: count }, (_, i) => +(start + i * spacing).toFixed(2));
  const { rows: levelRows, skippedRLs, partialRLs } = buildBatteredLiftRows(triangles, targetRLs);

  if (!levelRows.length) {
    statusEl.textContent = `No closed section found at any of the ${count} target RLs — the surface only covers ${meshMin.toFixed(2)} to ${meshMax.toFixed(2)}, check the Start RL/Count are within that range.`;
    statusEl.className = "cutplan-status is-error";
    return;
  }

  tbody.innerHTML = "";
  levelRows.forEach(({ rl, points }) => {
    const row = addLiftRow(rl.toFixed(2), "", "");
    applyExtents(row, points);
    row._batteredLevel = true;
  });

  const matchedRLs = count - skippedRLs.length;
  const notes = [];
  if (skippedRLs.length) notes.push(`${skippedRLs.length} RL${skippedRLs.length === 1 ? "" : "s"} outside the surface, skipped`);
  if (partialRLs.size) notes.push(`${partialRLs.size} RL${partialRLs.size === 1 ? "" : "s"} had an uneven top of cut — the boundary on the daylighted side is a straight-line approximation`);
  statusEl.textContent = `Built ${levelRows.length} lift row${levelRows.length === 1 ? "" : "s"} across ${matchedRLs} of ${count} RLs from ${triangles.length} triangles${
    notes.length ? ` (${notes.join("; ")})` : ""
  }. This replaced every existing lift row.`;
  statusEl.className = "cutplan-status is-ok";
  document.getElementById("rebuildBatteredBtn").hidden = false;
  switchTab("cutplan");
  computeAndRender();
}

function wireBatteredSurfaceUpload(inputId, parseFn, noTrianglesMessage) {
  document.getElementById(inputId).addEventListener("change", async (e) => {
    const file = e.target.files[0];
    const statusEl = document.getElementById("batteredStatus");
    if (!file) return;

    try {
      const text = await file.text();
      const triangles = parseFn(text);
      if (!triangles.length) {
        statusEl.textContent = noTrianglesMessage;
        statusEl.className = "cutplan-status is-error";
        return;
      }
      lastBatteredTriangles = triangles;
      runBatteredSurfaceBuild(triangles);
    } catch (err) {
      statusEl.textContent = `Couldn't read that file: ${err.message}`;
      statusEl.className = "cutplan-status is-error";
    } finally {
      e.target.value = "";
    }
  });
}

wireBatteredSurfaceUpload("dxfBatteredInput", parseDXF3DFaces, "No 3DFACE triangles found in that file.");
wireBatteredSurfaceUpload("landxmlBatteredInput", parseLandXMLSurface, "No TIN surface (Pnts/Faces) found in that LandXML file.");

document.getElementById("rebuildBatteredBtn").addEventListener("click", () => {
  if (lastBatteredTriangles) runBatteredSurfaceBuild(lastBatteredTriangles);
});

cutPlanList.addEventListener("click", (e) => {
  const swapBtn = e.target.closest(".cutplan-card__swap");
  if (swapBtn) {
    const row = window.__geogridRowsById.get(swapBtn.dataset.rowId);
    if (row) {
      // Cycles through every edge as a candidate face (see pickFaceByIndex) rather than a plain
      // on/off swap — most shapes only need one click, but an unusual boundary can need more to
      // reach the edge that's actually the right one.
      row._faceCycle = (row._faceCycle || 0) + 1;
      computeAndRender();
    }
    return;
  }

  const toggleBtn = e.target.closest(".cutplan-card__manual-toggle");
  if (toggleBtn) {
    const row = window.__geogridRowsById.get(toggleBtn.dataset.rowId);
    if (row) {
      if (row._manualStrips) {
        // Turning manual build off — keep the sequence built so far so switching back on later
        // (rather than typing it all in again) picks up right where it left off.
        row._manualStripsSaved = row._manualStrips;
        row._manualStrips = null;
      } else {
        row._manualStrips = row._manualStripsSaved || [];
      }
      computeAndRender();
    }
    return;
  }

  const undoBtn = e.target.closest(".cutplan-card__undo");
  if (undoBtn) {
    const row = window.__geogridRowsById.get(undoBtn.dataset.rowId);
    if (row && row._manualStrips && row._manualStrips.length) {
      row._manualStrips.pop();
      computeAndRender();
    }
    return;
  }

  const clearBtn = e.target.closest(".cutplan-card__clear");
  if (clearBtn) {
    const row = window.__geogridRowsById.get(clearBtn.dataset.rowId);
    if (row && row._manualStrips && row._manualStrips.length) {
      row._manualStrips = [];
      computeAndRender();
    }
    return;
  }

  const fillBtn = e.target.closest(".cutplan-card__fill");
  if (fillBtn) {
    const row = window.__geogridRowsById.get(fillBtn.dataset.rowId);
    if (row && row._manualStrips) {
      fillRemainder(row, row._manualActiveProduct, readProductSpecs());
      computeAndRender();
    }
    return;
  }

  const ghost = e.target.closest(".cutplan-manual-ghost");
  if (ghost) {
    const row = window.__geogridRowsById.get(ghost.dataset.rowId);
    if (row && row._manualStrips && row._manualActiveProduct) {
      row._manualStrips.push({ productId: row._manualActiveProduct });
      computeAndRender();
    }
    return;
  }
});

cutPlanList.addEventListener("change", (e) => {
  const select = e.target.closest(".cutplan-card__active-product");
  if (!select) return;
  const row = window.__geogridRowsById.get(select.dataset.rowId);
  if (!row) return;
  row._manualActiveProduct = select.value;
  computeAndRender();
});

function renderCutPlan(results) {
  const extentsResults = results.filter((r) => r.mode === "extents" && r.cutPlan);
  cutPlanEmpty.hidden = extentsResults.length > 0;
  document.getElementById("printCutPlanBtn").hidden = extentsResults.length === 0;
  cutPlanList.innerHTML = "";
  window.__geogridCutPlanResults = extentsResults;
  // Rebuilt fresh every render, not preserved across calls — the swap-face/back handler below only
  // ever needs to resolve an id from the CURRENTLY rendered cards, so keeping old entries around was
  // a pure leak: this ran on every recompute (every keystroke), growing by one entry per extents row
  // forever for the life of the tab.
  window.__geogridRowsById = new Map();
  const rollLookup = buildRollLookup(window.__geogridRolls || []);
  const productSpecs = readProductSpecs();

  extentsResults.forEach((r) => {
    const id = `row-${Math.random().toString(36).slice(2)}`;
    window.__geogridRowsById.set(id, r.row);

    const card = document.createElement("div");
    card.className = "cutplan-card";

    const isManual = !!r.row._manualStrips;
    const stitchCount = r.cutPlan.stitches.reduce((s, arr) => s + arr.length, 0);
    const metaParts = [`${r.n} strip${r.n === 1 ? "" : "s"}`, `face ${fmt.m(r.L)} m`];
    if (stitchCount) metaParts.push(`${stitchCount} stitch patch${stitchCount === 1 ? "" : "es"}`);
    if (isManual) metaParts.push("mixed build");

    let activeProductId = r.row._manualActiveProduct;
    if (!activeProductId || !productSpecs[activeProductId]) {
      activeProductId = r.stripProductIds && r.stripProductIds.length ? r.stripProductIds[r.stripProductIds.length - 1] : r.product;
    }
    r.row._manualActiveProduct = activeProductId; // remembered across renders

    card.innerHTML = `
      <div class="cutplan-card__head">
        <span class="cutplan-card__rl">RL ${escapeHtml(r.rl) || "—"}</span>
        <span class="cutplan-card__meta">${metaParts.join(" · ")}</span>
        <button type="button" class="btn btn--ghost cutplan-card__swap" data-row-id="${id}">Swap face/back</button>
        <button type="button" class="btn btn--ghost cutplan-card__manual-toggle" data-row-id="${id}">${isManual ? "Auto layout" : "Build manually"}</button>
      </div>
      ${
        isManual
          ? `<div class="cutplan-card__manual-toolbar">
        <label class="cutplan-card__active-label">Next strip
          <select class="cutplan-card__active-product" data-row-id="${id}">
            ${products.map((p) => `<option value="${p.id}" ${p.id === activeProductId ? "selected" : ""}>${escapeHtml((productSpecs[p.id] && productSpecs[p.id].label) || p.id)}</option>`).join("")}
          </select>
        </label>
        <button type="button" class="btn btn--ghost cutplan-card__undo" data-row-id="${id}" ${!r.row._manualStrips.length ? "disabled" : ""}>Undo last strip</button>
        <button type="button" class="btn btn--ghost cutplan-card__fill" data-row-id="${id}">Fill remainder</button>
        <button type="button" class="btn btn--ghost cutplan-card__clear" data-row-id="${id}" ${!r.row._manualStrips.length ? "disabled" : ""}>Clear</button>
      </div>`
          : ""
      }
      <div class="cutplan-card__body">
        <svg class="cutplan-card__plan" viewBox="0 0 400 260" preserveAspectRatio="xMidYMid meet"></svg>
        <ol class="cutplan-card__strips" tabindex="0"></ol>
      </div>
    `;
    cutPlanList.appendChild(card);

    const stripsList = card.querySelector(".cutplan-card__strips");
    // The diagram's own per-strip roll circles can't legibly fit a 3-digit roll number on a dense
    // (30+ strip) lift no matter how they're sized — there just isn't room. This list has plenty of
    // width regardless of strip count, so it's the one place the roll number is always readable.
    const rollNumsForList = isManual ? null : stripRollNumbersFor(r, rollLookup);
    r.stripLengths.forEach((len, i) => {
      const li = document.createElement("li");
      const productBit = isManual && r.stripProductIds ? ` — ${escapeHtml((productSpecs[r.stripProductIds[i]] && productSpecs[r.stripProductIds[i]].label) || r.stripProductIds[i])}` : "";
      const rollBit = rollNumsForList && rollNumsForList[i] ? ` — roll ${escapeHtml(rollNumsForList[i])}` : "";
      li.innerHTML = `<span>Strip ${i + 1}${productBit}${rollBit}</span><span>cut to ${fmt.m(len)} m</span>`;
      stripsList.appendChild(li);

      (r.cutPlan.stitches[i] || []).forEach((s, si) => {
        const stitchLi = document.createElement("li");
        stitchLi.classList.add("is-stitch");
        stitchLi.innerHTML = `<span>Strip ${i + 1} — stitch${(r.cutPlan.stitches[i].length > 1 ? " " + (si + 1) : "")}</span><span>${fmt.m(s.length)} m, starts ${fmt.m(s.offset)} m back from face</span>`;
        stripsList.appendChild(stitchLi);
      });
    });

    const svgEl = card.querySelector(".cutplan-card__plan");
    if (isManual) {
      renderCutPlanSvgManual(svgEl, r.cutPlan, productSpecs, activeProductId, id);
    } else {
      renderCutPlanSvg(svgEl, r.cutPlan, r.w, stripRollNumbersFor(r, rollLookup));
    }
  });
}

/** Keeps appending strips of `productId` to a row's manual sequence until the boundary is covered —
 *  the "Fill remainder" shortcut, for when the rest of a mixed row is just plain single-product fill
 *  and clicking every remaining strip by hand would be tedious. Same placement rule as one click. */
function fillRemainder(row, productId, productSpecs) {
  const spec = productSpecs[productId];
  if (!spec || !(spec.w > 0)) return;
  let guard = 0;
  while (guard++ < 500) {
    const cp = computeManualCutPlan(row._extentsPoints, row._manualStrips, productSpecs, row._faceCycle);
    if (!cp) break;
    const lastEnd = cp.stripEnds.length ? cp.stripEnds[cp.stripEnds.length - 1] : 0;
    if (lastEnd >= cp.faceLength - 1e-6) break;
    row._manualStrips.push({ productId });
  }
}

function renderCutPlanSvg(svg, cutPlan, w, stripRollNumbers) {
  const ns = "http://www.w3.org/2000/svg";
  const { face, cutLengths } = cutPlan;

  // Face-aligned local frame: x = arc-length station along the face (left to right, strip order),
  // y = depth into the fill — every boundary point snapped to its true position relative to the face
  // itself (see faceAlignedFootprint), not a single straight-line projection, so a face with several
  // segments still draws as one flat baseline that the strips visibly tie up to.
  const localPoly = faceAlignedFootprint(cutPlan);
  const xs = localPoly.map((p) => p.x), ys = localPoly.map((p) => p.y);
  const minX = Math.min(0, ...xs), maxX = Math.max(face.length, ...xs);
  const minY = Math.min(0, ...ys, ...(cutPlan.frontReach || [])), maxY = Math.max(...cutLengths, ...(cutPlan.extentsReach || []), ...ys);
  const W = 400, H = 260, pad = 16;
  const scale = Math.min((W - pad * 2) / Math.max(maxX - minX, 1e-6), (H - pad * 2) / Math.max(maxY - minY, 1e-6));
  const tx = (x) => pad + (x - minX) * scale;
  const ty = (y) => H - pad - (y - minY) * scale; // flip Y so deeper into the fill reads as "up"

  const poly2d = localPoly.map((p) => `${tx(p.x).toFixed(1)},${ty(p.y).toFixed(1)}`).join(" ");
  const polyEl = document.createElementNS(ns, "polygon");
  polyEl.setAttribute("points", poly2d);
  polyEl.setAttribute("fill", "var(--accent-tint)");
  polyEl.setAttribute("stroke", "var(--line-strong)");
  polyEl.setAttribute("stroke-width", "1.5");
  svg.innerHTML = "";
  svg.appendChild(polyEl);

  // Real per-strip positions/widths (computeCutPlan always fills these in now) — not recomputed from
  // a single uniform pitch, since "Pack from one side" (packStripsFromSide) can leave one strip
  // narrower than the rest, and a plain i*pitch formula would draw it as if it were full width.
  const stripStarts = cutPlan.stripStarts || cutLengths.map((_, i) => i * (cutLengths.length > 1 ? w - cutPlan.overlap : 0));
  const stripWidths = cutPlan.stripWidths || cutLengths.map(() => w);
  const stationOf = (i) => Math.max(0, Math.min(face.length, stripStarts[i] + stripWidths[i] / 2));
  // The midpoint of the TRUE overlap zone between two neighbouring strips (where one ends and the
  // next starts) — not just the midpoint between their centres, which only happens to land in the
  // same place when every strip shares one uniform width. Splitting the real overlap zone this way
  // keeps every strip drawn edge-to-edge with no doubled-up overlap regions cluttering the diagram
  // (see the comment below), correctly whether the last strip is a narrower closing piece or not.
  const seamAfter = (i) => (stripStarts[i] + stripWidths[i] + stripStarts[i + 1]) / 2;
  // Strip count doesn't shrink the font below this, so numbers stay every-strip and legible without
  // ever skipping one — dense diagrams get a smaller font instead of thinned labels.
  const labelFontSize = Math.max(4.5, Math.min(7, 165 / Math.max(cutLengths.length, 1)));
  // Roll-number circles are sized off the actual on-screen strip width, not a fixed size — but the
  // margin subtracted has to leave room for the circles' own 1px stroke too, not just clear space
  // between their centres, or a dense lift (40+ strips) ends up with barely a fraction of a pixel
  // of true gap: technically not touching, but reading as one solid overlapping blob on screen. The
  // lower floor (was 3, now 2.2) matters just as much — without it, an even denser lift hits the
  // floor and overlaps outright instead of continuing to shrink.
  const avgStripPx = (W - pad * 2) / Math.max(cutLengths.length, 1);
  const rollCircleR = Math.max(2.2, Math.min(7.5, avgStripPx / 2 - 1.3));

  cutLengths.forEach((len, i) => {
    const station = stationOf(i);
    // Drawn edge-to-edge (this strip's seam is the midpoint to its neighbour), not at the true
    // physical overlap width — the real lap is already called out in the "lapping each by Xmm"
    // instruction elsewhere, and drawing every strip's true overlapping width here just doubles up
    // every seam line and makes a 30+ strip diagram unreadable.
    const leftSeam = i === 0 ? 0 : seamAfter(i - 1);
    const rightSeam = i === cutLengths.length - 1 ? face.length : seamAfter(i);
    // Strips are drawn as real rectangles — square cut, same convention as the manual takeoffs —
    // running from the true front boundary out to the true far boundary (sampled across the strip's
    // own width in computeCutPlan), so there's never a gap between the grid and the extents on either side.
    const farReach = (cutPlan.extentsReach || [])[i] ?? len;
    const nearReach = (cutPlan.frontReach || [])[i] ?? 0;
    const xLeft = tx(leftSeam), xRight = tx(rightSeam);
    const yFar = ty(farReach), yNear = ty(nearReach);

    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", Math.min(xLeft, xRight).toFixed(1));
    rect.setAttribute("y", yFar.toFixed(1));
    rect.setAttribute("width", Math.abs(xRight - xLeft).toFixed(1));
    rect.setAttribute("height", Math.max(0, yNear - yFar).toFixed(1));
    // Alternating between two distinct colours (not just one colour's opacity) so adjacent strips
    // are clearly separable at a glance, even across a long dense run of similar-height rectangles.
    rect.setAttribute("fill", i % 2 === 0 ? "var(--accent)" : "var(--clay)");
    rect.setAttribute("fill-opacity", "0.75");
    rect.setAttribute("stroke", i % 2 === 0 ? "var(--accent-strong)" : "var(--clay)");
    rect.setAttribute("stroke-width", "1");
    svg.appendChild(rect);

    // Stitch patches — a separate small piece further back along the same line, past a gap the
    // main strip's single straight cut can't reach in one piece. Drawn dashed so it reads as its
    // own patch, not a continuation of the main strip.
    (cutPlan.stitches[i] || []).forEach((s) => {
      const sy1 = ty(s.offset), sy2 = ty(s.offset + s.length);
      const stitchLine = document.createElementNS(ns, "line");
      stitchLine.setAttribute("x1", tx(station).toFixed(1));
      stitchLine.setAttribute("y1", sy1.toFixed(1));
      stitchLine.setAttribute("x2", tx(station).toFixed(1));
      stitchLine.setAttribute("y2", sy2.toFixed(1));
      stitchLine.setAttribute("stroke", "var(--accent-strong)");
      stitchLine.setAttribute("stroke-width", "2");
      stitchLine.setAttribute("stroke-linecap", "round");
      stitchLine.setAttribute("stroke-dasharray", "3,2");
      svg.appendChild(stitchLine);
    });

    // Small per-strip label — the strip's own sequence number (1, 2, 3…), left-to-right, always in
    // order, every strip (a dense diagram shrinks the font instead of skipping numbers, so there's
    // never a confusing gap in the sequence).
    {
      const margin = 6;
      const label = document.createElementNS(ns, "text");
      const lx = Math.max(margin, Math.min(W - margin, tx(station)));
      const ly = Math.max(margin, Math.min(H - margin, yFar - 8));
      label.setAttribute("x", lx.toFixed(1));
      label.setAttribute("y", ly.toFixed(1));
      label.setAttribute("font-size", labelFontSize.toFixed(1));
      label.setAttribute("font-family", "var(--font-mono)");
      label.setAttribute("font-weight", "700");
      label.setAttribute("fill", "var(--ink)");
      label.setAttribute("text-anchor", "middle");
      label.textContent = String(i + 1);
      svg.appendChild(label);
    }

    // Roll number, circled, at the bottom of the strip (near the face) — which physical roll to pull
    // this piece from, per the Roll schedule tab's packing. Pooled packing mixes lifts by length, so
    // this can jump around between neighbouring strips; use "Group rolls across N lifts" in the spec
    // panel if you want it to stay within a band of nearby lifts instead.
    const rollLabel = (stripRollNumbers && stripRollNumbers[i]) || "";
    if (rollLabel) {
      const margin = 6;
      const ccx = Math.max(margin + rollCircleR, Math.min(W - margin - rollCircleR, tx(station)));
      const ccy = Math.max(margin + rollCircleR, Math.min(H - margin - rollCircleR, yNear - rollCircleR - 2));

      // Longer roll numbers (rolls run into the hundreds on a big job) need a smaller font to still
      // fit inside a small circle — sized relative to digit count, not a single fixed size. But once
      // that font would drop below what's actually legible, squeezing it in just reads as garbled
      // text, not a smaller number — a real floor a jam-packed 30+ strip lift can hit with 3-digit
      // roll numbers even after the circles themselves got more breathing room (see rollCircleR
      // above). Below that floor, fall back to a small plain dot instead: the strip list alongside
      // this diagram (stripsList in renderCutPlan) always spells the roll number out in full, at any
      // strip count, so nothing is actually lost — it just isn't crammed into the diagram itself.
      const rollFontSize = rollLabel.length >= 3 ? rollCircleR * 0.82 : rollLabel.length === 2 ? rollCircleR * 0.98 : rollCircleR * 1.15;
      const MIN_LEGIBLE_FONT = 4.2;
      const circle = document.createElementNS(ns, "circle");
      circle.setAttribute("cx", ccx.toFixed(1));
      circle.setAttribute("cy", ccy.toFixed(1));
      const titleEl = document.createElementNS(ns, "title");
      titleEl.textContent = `Roll ${rollLabel}`;

      if (rollFontSize >= MIN_LEGIBLE_FONT) {
        circle.setAttribute("r", rollCircleR.toFixed(1));
        circle.setAttribute("fill", "var(--surface)");
        circle.setAttribute("stroke", "var(--ink)");
        circle.setAttribute("stroke-width", "1");
        circle.appendChild(titleEl);
        svg.appendChild(circle);

        const rollText = document.createElementNS(ns, "text");
        rollText.setAttribute("x", ccx.toFixed(1));
        rollText.setAttribute("y", ccy.toFixed(1));
        rollText.setAttribute("font-size", rollFontSize.toFixed(1));
        rollText.setAttribute("font-family", "var(--font-mono)");
        rollText.setAttribute("fill", "var(--ink)");
        rollText.setAttribute("text-anchor", "middle");
        rollText.setAttribute("dominant-baseline", "central");
        rollText.textContent = rollLabel;
        svg.appendChild(rollText);
      } else {
        circle.setAttribute("r", Math.max(1.3, rollCircleR * 0.45).toFixed(1));
        circle.setAttribute("fill", "var(--ink-muted)");
        circle.setAttribute("stroke", "none");
        circle.appendChild(titleEl);
        svg.appendChild(circle);
      }
    }
  });
}

/**
 * The Cut Plan diagram's counterpart for a row in "Build manually" mode: draws each already-committed
 * strip at its own true position/width, coloured by its own product, plus one dashed, clickable
 * "ghost" strip previewing exactly where the next click will land — same seam-overlap rule
 * computeManualCutPlan itself uses, so what's shown is exactly what committing it would produce. The
 * ghost carries a data-row-id so the delegated click handler below can resolve it back to a row.
 */
function renderCutPlanSvgManual(svg, cutPlan, productSpecs, activeProductId, rowId) {
  const ns = "http://www.w3.org/2000/svg";
  const face = cutPlan.face;
  const stripStarts = cutPlan.stripStarts || [];
  const stripEnds = cutPlan.stripEnds || [];
  const stripProductIds = cutPlan.stripProductIds || [];
  const extentsReach = cutPlan.extentsReach || [];
  const frontReach = cutPlan.frontReach || [];

  const activeSpec = productSpecs[activeProductId];
  const ghostW = activeSpec && activeSpec.w > 0 ? activeSpec.w : 0;
  let ghostStart = 0;
  if (stripStarts.length) {
    const lastEnd = stripEnds[stripEnds.length - 1];
    const lastSpec = productSpecs[stripProductIds[stripProductIds.length - 1]];
    const overlap = lastSpec ? Math.max(activeSpec ? activeSpec.oMin : 0, lastSpec.oMin) : activeSpec ? activeSpec.oMin : 0;
    ghostStart = lastEnd - overlap;
  }
  const ghostEnd = ghostStart + ghostW;
  let ghostReach = null;
  if (ghostW > 0) {
    const inward = inwardNormal(face.dir);
    const faceOrigin = face.edges[0].from;
    const vertexStations = cutPlan.poly
      .map((p) => (p.x - faceOrigin.x) * face.dir.x + (p.y - faceOrigin.y) * face.dir.y)
      .filter((s) => s >= 0 && s <= face.length)
      .sort((a, b) => a - b);
    const station = Math.max(0, Math.min(face.length, (ghostStart + ghostEnd) / 2));
    ghostReach = stripBoundaryReach(station, ghostW, cutPlan.poly, face, inward, vertexStations);
  }

  const localPoly = faceAlignedFootprint(cutPlan);
  const xs = localPoly.map((p) => p.x), ys = localPoly.map((p) => p.y);
  const minX = Math.min(0, ...xs), maxX = Math.max(face.length, ghostEnd, ...xs);
  const ghostFar = ghostReach ? ghostReach.farReach : 0;
  const ghostNear = ghostReach ? ghostReach.nearReach : 0;
  const minY = Math.min(0, ...ys, ...frontReach, ghostNear);
  const maxY = Math.max(0, ...extentsReach, ...ys, ghostFar);
  const W = 400, H = 260, pad = 16;
  const scale = Math.min((W - pad * 2) / Math.max(maxX - minX, 1e-6), (H - pad * 2) / Math.max(maxY - minY, 1e-6));
  const tx = (x) => pad + (x - minX) * scale;
  const ty = (y) => H - pad - (y - minY) * scale;

  svg.innerHTML = "";
  const poly2d = localPoly.map((p) => `${tx(p.x).toFixed(1)},${ty(p.y).toFixed(1)}`).join(" ");
  const polyEl = document.createElementNS(ns, "polygon");
  polyEl.setAttribute("points", poly2d);
  polyEl.setAttribute("fill", "var(--accent-tint)");
  polyEl.setAttribute("stroke", "var(--line-strong)");
  polyEl.setAttribute("stroke-width", "1.5");
  svg.appendChild(polyEl);

  const labelFontSize = Math.max(4.5, Math.min(7, 165 / Math.max(stripStarts.length, 1)));

  stripStarts.forEach((start, i) => {
    const end = stripEnds[i];
    const spec = productSpecs[stripProductIds[i]];
    const colorVar = spec && spec.colorSlot ? `var(--${spec.colorSlot})` : "var(--accent)";
    const farReach = extentsReach[i] ?? 0;
    const nearReach = frontReach[i] ?? 0;
    const xLeft = tx(start), xRight = tx(end);
    const yFar = ty(farReach), yNear = ty(nearReach);

    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", Math.min(xLeft, xRight).toFixed(1));
    rect.setAttribute("y", yFar.toFixed(1));
    rect.setAttribute("width", Math.abs(xRight - xLeft).toFixed(1));
    rect.setAttribute("height", Math.max(0, yNear - yFar).toFixed(1));
    rect.setAttribute("fill", colorVar);
    rect.setAttribute("fill-opacity", "0.72");
    rect.setAttribute("stroke", colorVar);
    rect.setAttribute("stroke-width", "1");
    svg.appendChild(rect);

    (cutPlan.stitches[i] || []).forEach((s) => {
      const station = (start + end) / 2;
      const sy1 = ty(s.offset), sy2 = ty(s.offset + s.length);
      const stitchLine = document.createElementNS(ns, "line");
      stitchLine.setAttribute("x1", tx(station).toFixed(1));
      stitchLine.setAttribute("y1", sy1.toFixed(1));
      stitchLine.setAttribute("x2", tx(station).toFixed(1));
      stitchLine.setAttribute("y2", sy2.toFixed(1));
      stitchLine.setAttribute("stroke", colorVar);
      stitchLine.setAttribute("stroke-width", "2");
      stitchLine.setAttribute("stroke-linecap", "round");
      stitchLine.setAttribute("stroke-dasharray", "3,2");
      svg.appendChild(stitchLine);
    });

    const label = document.createElementNS(ns, "text");
    const lx = Math.max(6, Math.min(W - 6, tx((start + end) / 2)));
    const ly = Math.max(6, Math.min(H - 6, yFar - 8));
    label.setAttribute("x", lx.toFixed(1));
    label.setAttribute("y", ly.toFixed(1));
    label.setAttribute("font-size", labelFontSize.toFixed(1));
    label.setAttribute("font-family", "var(--font-mono)");
    label.setAttribute("font-weight", "700");
    label.setAttribute("fill", "var(--ink)");
    label.setAttribute("text-anchor", "middle");
    label.textContent = String(i + 1);
    svg.appendChild(label);
  });

  if (ghostW > 0 && ghostReach) {
    const xLeft = tx(ghostStart), xRight = tx(ghostEnd);
    const yFar = ty(ghostReach.farReach), yNear = ty(ghostReach.nearReach);
    const colorVar = activeSpec.colorSlot ? `var(--${activeSpec.colorSlot})` : "var(--accent)";

    const ghost = document.createElementNS(ns, "rect");
    ghost.setAttribute("class", "cutplan-manual-ghost");
    ghost.setAttribute("data-row-id", rowId);
    ghost.setAttribute("x", Math.min(xLeft, xRight).toFixed(1));
    ghost.setAttribute("y", yFar.toFixed(1));
    ghost.setAttribute("width", Math.abs(xRight - xLeft).toFixed(1));
    ghost.setAttribute("height", Math.max(0, yNear - yFar).toFixed(1));
    ghost.setAttribute("fill", colorVar);
    ghost.setAttribute("fill-opacity", "0.22");
    ghost.setAttribute("stroke", colorVar);
    ghost.setAttribute("stroke-width", "1.5");
    ghost.setAttribute("stroke-dasharray", "4,3");
    svg.appendChild(ghost);

    // A fixed font-size-8 "click to place" used to sit at the same height as the strip number
    // labels, which shrink (see labelFontSize above) once a lift has enough strips that the
    // diagram is dense — the hint ended up both larger than and overlapping the last couple of
    // strip numbers. Size it off the same scale, and once even that's too wide for a narrow ghost
    // strip, fall back to a short "+" instead of letting the text run over its neighbours.
    const hintFontSize = Math.min(8, labelFontSize);
    const ghostPxWidth = Math.abs(xRight - xLeft);
    const fullHintText = "click to place";
    const fitsFull = fullHintText.length * hintFontSize * 0.62 <= ghostPxWidth + 24;
    const hint = document.createElementNS(ns, "text");
    hint.setAttribute("x", tx((ghostStart + ghostEnd) / 2).toFixed(1));
    hint.setAttribute("y", Math.max(8, ty(ghostReach.farReach) - 6).toFixed(1));
    hint.setAttribute("font-size", hintFontSize.toFixed(1));
    hint.setAttribute("font-family", "var(--font-mono)");
    hint.setAttribute("fill", colorVar);
    hint.setAttribute("text-anchor", "middle");
    hint.setAttribute("pointer-events", "none");
    hint.textContent = fitsFull ? fullHintText : "+";
    svg.appendChild(hint);
  }
}

/* ============================================================
   3D view — hand-rolled axonometric projection on canvas,
   no libraries. Each lift's footprint is drawn as a flat plane
   at its RL, stacked and rotatable.
   ============================================================ */

const view3DCanvas = document.getElementById("view3DCanvas");
const view3DEmpty = document.getElementById("view3DEmpty");
const view3DState = { yaw: -0.6, pitch: 0.5, zoom: 1, panX: 0, panY: 0 };

// Which lift (by RL) is currently spotlit — hovering a label or the layer itself in the canvas, or
// (on touch, where there's no hover) tapping one. With a couple dozen stacked lifts the leader lines
// alone turn into an unreadable web, so instead of trying to make the static picture legible, picking
// one lift makes ONLY it and its own leader line stand out while everything else recedes.
let view3DHoveredRL = null;
let view3DHoverLocked = false; // set by a click/tap (persists till clicked again); a live mouse hover isn't
let view3DLastRender = null; // { anchors: [{rl, installed, screenPts, anchorX, anchorY}] } for hit-testing

function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Canvas-internal pixel coords for a pointer event, accounting for the canvas's CSS-scaled size. */
function view3DPointFromEvent(e) {
  const rect = view3DCanvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * view3DCanvas.width,
    y: ((e.clientY - rect.top) / rect.height) * view3DCanvas.height,
  };
}

/** Which lift's RL sits under a canvas point — each lift's own label (nearest one, since with many
 * lifts stacked close together their labels can sit close enough to overlap) takes priority since a
 * single-pixel corner is an easy miss, then falls back to the drawn shape itself, topmost (last-
 * painted, i.e. highest RL) first since that's what actually occludes at that pixel. `generous`
 * widens the label tolerance for an actual tap/click (a deliberate, discrete action — "nearest
 * label" is a safe guess even a little off-target) but not for live mouse hovering (where a stray
 * pass-through shouldn't light up whatever label happens to be nearest). */
function hitTestLift3D(x, y, generous) {
  const info = view3DLastRender;
  if (!info) return null;
  const tol = generous ? 26 : 14;
  let best = null, bestDist = Infinity;
  info.anchors.forEach((a) => {
    const d = Math.hypot(x - (a.anchorX - 6), y - (a.anchorY - 6));
    if (d < bestDist) { bestDist = d; best = a; }
  });
  if (best && bestDist <= tol) return best.rl;
  for (let i = info.anchors.length - 1; i >= 0; i--) {
    if (pointInPolygon(x, y, info.anchors[i].screenPts)) return info.anchors[i].rl;
  }
  return null;
}

function project3D(x, y, z, yaw, pitch) {
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
  const x1 = x * cosY - y * sinY;
  const y1 = x * sinY + y * cosY;
  const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
  const y2 = y1 * cosP - z * sinP;
  const z2 = y1 * sinP + z * cosP;
  return { sx: x1, sy: -z2, depth: y2 };
}

// A modest, visually-distinct cycle of DXF ACI colour indices — just enough that adjacent lifts'
// layers don't default to the same colour, not an attempt to mean anything beyond "a different one".
const DXF_LAYER_COLORS = [1, 2, 3, 4, 5, 6, 8, 9];

/**
 * DXF R12 (AC1009, the plainest ASCII dialect every CAD package reads) export of the current 3D
 * view's stack: one closed 3D POLYLINE per lift, on its own layer, at its own RL. Deliberately reuses
 * the exact same footprint geometry render3D() already draws — same shared frame, same simplifications
 * for manually-typed lifts (which never had real survey coordinates to begin with, just a length and
 * an embedment) — so the file matches what's on screen rather than re-deriving something new.
 */
function buildLiftsDxf(results) {
  const lifts = results
    .filter((r) => r.footprint && r.footprint.length >= 3 && Number.isFinite(parseFloat(r.rl)))
    .map((r) => ({ rl: parseFloat(r.rl), rlLabel: r.rl, footprint: r.footprint }))
    .sort((a, b) => a.rl - b.rl);
  if (!lifts.length) return null;

  const lines = [];
  const put = (code, value) => lines.push(String(code), String(value));

  put(0, "SECTION"); put(2, "HEADER");
  put(9, "$ACADVER"); put(1, "AC1009");
  put(0, "ENDSEC");

  const layerNames = lifts.map((lift, i) => `GRID_RL_${String(lift.rlLabel).replace(/[^A-Za-z0-9_.-]+/g, "_")}`);

  put(0, "SECTION"); put(2, "TABLES");
  put(0, "TABLE"); put(2, "LAYER"); put(70, lifts.length);
  layerNames.forEach((name, i) => {
    put(0, "LAYER"); put(2, name); put(70, 0);
    put(62, DXF_LAYER_COLORS[i % DXF_LAYER_COLORS.length]); put(6, "CONTINUOUS");
  });
  put(0, "ENDTAB"); put(0, "ENDSEC");

  put(0, "SECTION"); put(2, "ENTITIES");
  lifts.forEach((lift, i) => {
    const layer = layerNames[i];
    // Flag 70 = 9 (bit 0 "closed" + bit 3 "3D polyline"); each VERTEX carries the matching
    // "3D polyline vertex" flag (32) — plain 2D-polyline flags here would silently flatten every
    // vertex onto one plane in stricter readers instead of keeping each lift at its own RL.
    put(0, "POLYLINE"); put(8, layer); put(66, 1); put(70, 9);
    lift.footprint.forEach((p) => {
      put(0, "VERTEX"); put(8, layer);
      put(10, p.x.toFixed(4)); put(20, p.y.toFixed(4)); put(30, lift.rl.toFixed(4));
      put(70, 32);
    });
    put(0, "SEQEND"); put(8, layer);
  });
  put(0, "ENDSEC");

  put(0, "EOF");
  return lines.join("\r\n") + "\r\n";
}

function render3D(results) {
  if (!view3DCanvas) return;
  const ctx = view3DCanvas.getContext("2d");
  const W = view3DCanvas.width, H = view3DCanvas.height;
  ctx.clearRect(0, 0, W, H);

  const lifts = results
    .filter((r) => r.footprint && r.footprint.length >= 3 && Number.isFinite(parseFloat(r.rl)))
    .map((r) => ({ rl: parseFloat(r.rl), rlLabel: r.rl, footprint: r.footprint, installed: isLiftInstalled(r.row.dataset.liftId) }))
    .sort((a, b) => a.rl - b.rl);

  view3DEmpty.hidden = lifts.length > 0;
  const exportDxfBtn = document.getElementById("view3DExportDxf");
  if (exportDxfBtn) exportDxfBtn.disabled = !lifts.length;
  if (!lifts.length) return;

  const baseRL = lifts[0].rl;
  const { yaw, pitch, zoom, panX, panY } = view3DState;

  let minSX = Infinity, maxSX = -Infinity, minSY = Infinity, maxSY = -Infinity;
  const projectedLifts = lifts.map((lift, colorIndex) => {
    const z = lift.rl - baseRL;
    const pts = lift.footprint.map((p) => project3D(p.x, p.y, z, yaw, pitch));
    pts.forEach((p) => {
      minSX = Math.min(minSX, p.sx);
      maxSX = Math.max(maxSX, p.sx);
      minSY = Math.min(minSY, p.sy);
      maxSY = Math.max(maxSY, p.sy);
    });
    const depth = pts.reduce((s, p) => s + p.depth, 0) / pts.length;
    return { ...lift, pts, depth, colorIndex }; // colorIndex fixed in RL order, independent of paint-order sort below
  });

  const boxW = Math.max(maxSX - minSX, 1e-6);
  const boxH = Math.max(maxSY - minSY, 1e-6);
  const pad = 90;
  const fitScale = Math.min((W - pad * 2) / boxW, (H - pad * 2) / boxH);
  const scale = fitScale * zoom;
  const cx = W / 2 + panX, cy = H / 2 + panY;
  const midSX = (minSX + maxSX) / 2, midSY = (minSY + maxSY) / 2;
  const toScreen = (p) => ({ x: cx + (p.sx - midSX) * scale, y: cy + (p.sy - midSY) * scale });

  // Paint strictly in RL order (lowest first) so each higher lift is drawn over the ones below it —
  // matches build order and reads correctly regardless of camera angle. The computed camera "depth"
  // isn't used here: for flat stacked planes, RL order *is* the correct occlusion order.
  projectedLifts.sort((a, b) => a.rl - b.rl);

  const style = getComputedStyle(document.documentElement);
  const good = style.getPropertyValue("--good").trim();
  const goodTint = style.getPropertyValue("--good-tint").trim();
  const graphite = style.getPropertyValue("--graphite").trim();
  const lineStrong = style.getPropertyValue("--line-strong").trim();
  const ink = style.getPropertyValue("--ink").trim();
  const inkMuted = style.getPropertyValue("--ink-muted").trim();
  const accentPop = style.getPropertyValue("--accent-pop").trim();
  const inkOnAccent = style.getPropertyValue("--ink-on-accent").trim();

  ctx.font = "11px " + (style.getPropertyValue("--font-mono").trim() || "monospace");
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";

  // Shapes first, in paint order, so every fill/stroke happens before any label is drawn over them.
  // Colour now carries real meaning — installed lifts (per the Installation sequence / Roll schedule
  // tabs' own tracking) pick up the same --good green used for "done" everywhere else in the app.
  // Pending lifts get a plain neutral grey rather than --accent: in this app's Exit Green theme
  // --accent is ALSO green, close enough to --good to be hard to tell apart at a glance — exactly
  // the distinction this colour-coding exists to make. Within each colour, alternating opacity/
  // weight (not a third hue, which would blur the installed/pending read) still bands neighbouring
  // layers apart the way the old alternating accent/clay colours did.
  //
  // With more than a handful of lifts, tracing any ONE of those bands (or its leader line, below)
  // by eye stops being realistic — so whichever lift is spotlit (view3DHoveredRL, set by hovering/
  // tapping its label or its own shape) gets pulled forward at full strength while every other lift
  // fades back, instead of everything competing for attention at once.
  const spotlit = view3DHoveredRL !== null;
  const anchors = projectedLifts.map((lift) => {
    const alt = lift.colorIndex % 2 === 1;
    const isHovered = spotlit && lift.rl === view3DHoveredRL;
    const dim = spotlit && !isHovered;
    const screenPts = lift.pts.map(toScreen);
    ctx.beginPath();
    screenPts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    // The spotlit lift always gets the same solid, opaque highlight fill — deliberately ignoring the
    // alternating-band alpha (0.32 on "alt" lifts) and the installed/pending tint below, both of which
    // exist to tell neighbouring bland lifts apart from each other, not to compete with "this is the
    // one you're looking at." One consistent loud colour, at full strength, every time.
    ctx.fillStyle = isHovered ? accentPop : lift.installed ? goodTint : lineStrong;
    ctx.globalAlpha = isHovered ? 0.82 : (alt ? 0.32 : 0.96) * (dim ? 0.22 : 1);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = isHovered ? accentPop : lift.installed ? good : graphite;
    ctx.lineWidth = isHovered ? 2.75 : alt ? 1 : 2.25;
    ctx.globalAlpha = isHovered ? 1 : dim ? 0.3 : 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
    return { lift, rl: lift.rl, screenPts, anchorX: screenPts[0].x, anchorY: screenPts[0].y };
  });

  view3DLastRender = { anchors };

  // Each label sits right at its own lift's corner — no separate list, no leader line, so a label
  // always visibly IS its grid rather than pointing at it from across the canvas. That works great
  // when lifts are all roughly the same shape (corners line up in a predictable column) but real
  // sites have lifts of genuinely different face lengths/shapes, whose corners scatter unpredictably
  // — showing every label at once then just piles them into an unreadable mess. So: actually measure
  // whether the resting-state labels would overlap each other, and if enough of them would, stop
  // showing permanent labels altogether and rely purely on the hover/tap spotlight below — one label
  // at a time is never ambiguous, no matter how scattered the shapes are.
  const monoFont = style.getPropertyValue("--font-mono").trim() || "monospace";
  ctx.font = "11px " + monoFont;
  const labelBoxes = anchors.map(({ lift, anchorX, anchorY }) => {
    const w = ctx.measureText(`RL ${lift.rlLabel}`).width;
    return { left: anchorX - 6 - w, right: anchorX - 6, top: anchorY - 15, bottom: anchorY - 2 };
  });
  let overlaps = 0;
  for (let i = 0; i < labelBoxes.length && overlaps <= 2; i++) {
    for (let j = i + 1; j < labelBoxes.length; j++) {
      const a = labelBoxes[i], b = labelBoxes[j];
      if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) overlaps++;
    }
  }
  const showPermanentLabels = overlaps <= 2;

  // Permanent (non-hovered) labels still sit right at their own lift's corner — that's fine for
  // telling bland, similarly-toned neighbours apart. The spotlit one is a different job: whichever
  // lift you're on, its label should be the one thing you don't have to hunt for, so it's pinned to
  // a fixed spot (top-left) instead of wherever that lift's corner happens to have landed, and drawn
  // as a solid badge instead of small text — same treatment as the shape's own solid highlight fill.
  const drawLabel = (lift, anchorX, anchorY, dim) => {
    ctx.font = "11px " + monoFont;
    ctx.globalAlpha = dim ? 0.4 : 1;
    ctx.fillStyle = lift.installed ? good : ink;
    ctx.fillText(`RL ${lift.rlLabel}`, anchorX - 6, anchorY - 6);
    ctx.globalAlpha = 1;
  };
  if (showPermanentLabels) {
    anchors.forEach(({ lift, anchorX, anchorY }) => {
      const isHovered = spotlit && lift.rl === view3DHoveredRL;
      if (!isHovered) drawLabel(lift, anchorX, anchorY, spotlit);
    });
  }
  if (spotlit) {
    const hovered = anchors.find((a) => a.lift.rl === view3DHoveredRL);
    if (hovered) {
      const label = `RL ${hovered.lift.rlLabel}`;
      const badgeFont = "bold 14px " + monoFont;
      ctx.font = badgeFont;
      const textW = ctx.measureText(label).width;
      const padX = 12, boxH = 30, x = 14, y = 14;
      const boxW = textW + padX * 2;
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 3;
      ctx.fillStyle = accentPop;
      ctx.beginPath();
      ctx.roundRect(x, y, boxW, boxH, boxH / 2);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = inkOnAccent;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = badgeFont;
      ctx.fillText(label, x + padX, y + boxH / 2 + 1);
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
    }
  }
  ctx.font = "11px " + monoFont;

  ctx.fillStyle = inkMuted;
  ctx.textAlign = "left";
  ctx.font = "10px " + monoFont;
  const hint = spotlit ? "" : !showPermanentLabels ? " · hover a level to see its RL" : lifts.length > 8 ? " · hover a level to isolate it" : "";
  ctx.fillText(`${lifts.length} lifts · RL ${lifts[0].rlLabel} → ${lifts[lifts.length - 1].rlLabel}${hint}`, 12, H - 14);

  syncCompass();
}

const VIEW3D_PITCH_MIN = 0.05, VIEW3D_PITCH_MAX = 1.5;

/** Positions the compass handle to match view3DState — called after any interaction changes yaw/pitch,
 * from any source (canvas drag, the compass itself, the reset button), so it never drifts out of sync. */
function syncCompass() {
  const compass = document.getElementById("view3DCompass");
  const spoke = document.getElementById("view3DCompassSpoke");
  const handle = document.getElementById("view3DCompassHandle");
  if (!compass || !spoke || !handle) return;
  const cx = 45, cy = 45, minR = 8, maxR = 34;
  const t = Math.max(0, Math.min(1, (view3DState.pitch - VIEW3D_PITCH_MIN) / (VIEW3D_PITCH_MAX - VIEW3D_PITCH_MIN)));
  const r = maxR - t * (maxR - minR);
  const hx = cx + r * Math.sin(view3DState.yaw);
  const hy = cy - r * Math.cos(view3DState.yaw);
  spoke.setAttribute("x2", hx.toFixed(2));
  spoke.setAttribute("y2", hy.toFixed(2));
  handle.setAttribute("cx", hx.toFixed(2));
  handle.setAttribute("cy", hy.toFixed(2));

  // role="slider" requires a numeric value — this is inherently a 2-axis control (rotation + tilt),
  // so yaw drives the required aria-valuenow (what ArrowLeft/Right change) while aria-valuetext spells
  // out both axes in words, since a screen reader announces valuetext instead of the bare number when
  // it's present.
  const yawDeg = Math.round((((view3DState.yaw * 180) / Math.PI) % 360 + 360) % 360);
  const tiltPct = Math.round(t * 100);
  compass.setAttribute("aria-valuenow", yawDeg);
  compass.setAttribute("aria-valuetext", `Rotated ${yawDeg} degrees, tilt ${tiltPct}% from top-down toward side-on`);
}

(function wire3DInteraction() {
  if (!view3DCanvas) return;
  let dragging = false, lastX = 0, lastY = 0, moved = 0;

  function setHover(rl) {
    if (rl === view3DHoveredRL) return;
    view3DHoveredRL = rl;
    render3D(window.__geogridResults || []);
  }

  view3DCanvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    moved = 0;
    view3DCanvas.style.cursor = "grabbing";
    view3DCanvas.setPointerCapture(e.pointerId);
  });
  view3DCanvas.addEventListener("pointermove", (e) => {
    if (dragging) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      view3DState.yaw += dx * 0.008;
      view3DState.pitch = Math.max(VIEW3D_PITCH_MIN, Math.min(VIEW3D_PITCH_MAX, view3DState.pitch + dy * 0.006));
      render3D(window.__geogridResults || []);
      return;
    }
    // Live hover (mouse only — touch has no hover concept and gets a tap-to-lock below instead).
    // Skipped once something is locked in by a click so moving the mouse away doesn't clear it.
    if (e.pointerType !== "mouse" || view3DHoverLocked) return;
    const p = view3DPointFromEvent(e);
    const hit = hitTestLift3D(p.x, p.y);
    view3DCanvas.style.cursor = hit !== null ? "pointer" : "grab";
    setHover(hit);
  });
  ["pointerup", "pointercancel"].forEach((evt) =>
    view3DCanvas.addEventListener(evt, (e) => {
      dragging = false;
      view3DCanvas.style.cursor = view3DHoveredRL !== null ? "pointer" : "grab";
      if (evt === "pointercancel" || moved >= 6) return; // a real drag-to-rotate, not a tap/click
      // A tap or click toggles a LOCKED spotlight — the only way touch (no hover) can pick a lift,
      // and on desktop it lets you move the mouse away afterwards without losing the highlight.
      const p = view3DPointFromEvent(e);
      const hit = hitTestLift3D(p.x, p.y, e.pointerType !== "mouse");
      if (hit !== null && hit === view3DHoveredRL && view3DHoverLocked) {
        view3DHoverLocked = false;
        setHover(null);
      } else if (hit !== null) {
        view3DHoverLocked = true;
        setHover(hit);
      } else if (view3DHoverLocked) {
        view3DHoverLocked = false;
        setHover(null);
      }
    })
  );
  view3DCanvas.addEventListener("pointerleave", () => {
    dragging = false;
    if (view3DHoverLocked) return;
    view3DCanvas.style.cursor = "grab";
    setHover(null);
  });
  view3DCanvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      view3DState.zoom = Math.max(0.3, Math.min(4, view3DState.zoom * (1 - e.deltaY * 0.001)));
      render3D(window.__geogridResults || []);
    },
    { passive: false }
  );

  document.getElementById("view3DReset").addEventListener("click", () => {
    Object.assign(view3DState, { yaw: -0.6, pitch: 0.5, zoom: 1, panX: 0, panY: 0 });
    view3DHoverLocked = false;
    view3DHoveredRL = null;
    render3D(window.__geogridResults || []);
  });

  document.getElementById("view3DExportDxf").addEventListener("click", () => {
    const dxf = buildLiftsDxf(window.__geogridResults || []);
    if (!dxf) return;
    const project = document.getElementById("projectName").value || "geomate";
    const blob = new Blob([dxf], { type: "application/dxf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${project.replace(/[^a-z0-9-_]+/gi, "_")}_lifts.dxf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
})();

/**
 * Compass wheel — a single 2-axis control standing in for "drag to rotate, drag to tilt": angle around
 * the ring sets yaw, distance from centre sets pitch (near centre = looking down from TOP, out at the
 * ring's edge = a flatter SIDE-on view). Kept in sync with the main canvas drag via syncCompass() so
 * either control always reflects the other's changes.
 */
(function wireCompass() {
  const compass = document.getElementById("view3DCompass");
  if (!compass) return;
  const cx = 45, cy = 45, minR = 8, maxR = 34;

  function applyFromPointer(e) {
    const rect = compass.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 90;
    const py = ((e.clientY - rect.top) / rect.height) * 90;
    const dx = px - cx, dy = py - cy;
    view3DState.yaw = Math.atan2(dx, -dy);
    const dist = Math.max(minR, Math.min(maxR, Math.hypot(dx, dy)));
    const t = (maxR - dist) / (maxR - minR);
    view3DState.pitch = VIEW3D_PITCH_MIN + t * (VIEW3D_PITCH_MAX - VIEW3D_PITCH_MIN);
    render3D(window.__geogridResults || []);
  }

  let dragging = false;
  compass.addEventListener("pointerdown", (e) => {
    dragging = true;
    compass.setPointerCapture(e.pointerId);
    applyFromPointer(e);
  });
  compass.addEventListener("pointermove", (e) => {
    if (dragging) applyFromPointer(e);
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((evt) => compass.addEventListener(evt, () => (dragging = false)));

  // Basic keyboard support to match role="slider": arrows nudge yaw/pitch a step at a time.
  compass.addEventListener("keydown", (e) => {
    const step = 0.12;
    if (e.key === "ArrowLeft") view3DState.yaw -= step;
    else if (e.key === "ArrowRight") view3DState.yaw += step;
    else if (e.key === "ArrowUp") view3DState.pitch = Math.min(VIEW3D_PITCH_MAX, view3DState.pitch + step);
    else if (e.key === "ArrowDown") view3DState.pitch = Math.max(VIEW3D_PITCH_MIN, view3DState.pitch - step);
    else return;
    e.preventDefault();
    render3D(window.__geogridResults || []);
  });

  // Snap points (N/E/S/W, the four corners NE/SE/SW/NW, and TOP via the cube's top face) — jump
  // straight to a standard view, cube-navigator style, instead of having to free-drag to exactly the
  // right spot. The four sides sit flatter (square-on to that face); the four corners tilt further so
  // they read as looking at a corner of the cube, the way a real corner view would; TOP looks straight
  // down the stack. stopPropagation so the click doesn't also register as a free-drag to wherever on
  // the ring the snap dot happens to sit.
  const VIEW3D_SIDE_PITCH = 0.32;
  const VIEW3D_CORNER_PITCH = 0.68;
  compass.querySelectorAll(".view3d-compass__snap").forEach((snap) => {
    snap.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (snap.dataset.pitch === "top") {
        view3DState.pitch = VIEW3D_PITCH_MAX;
      } else {
        view3DState.yaw = parseFloat(snap.dataset.yaw);
        view3DState.pitch = snap.dataset.pitch === "corner" ? VIEW3D_CORNER_PITCH : VIEW3D_SIDE_PITCH;
      }
      render3D(window.__geogridResults || []);
    });
  });

  syncCompass(); // correct position from the start, even before any data has loaded
})();

/* ============================================================
   Roll schedule — every strip/stitch pooled across every lift and packed onto
   numbered rolls, aiming for zero discarded off-cut.
   ============================================================ */

/** One <div class="roll-card"> — a labelled bar diagram plus a piece list — shared by the on-screen list and print. */
function buildRollCardHtml(roll, index) {
  const rollLength = roll.rollLength;
  const used = roll.pieces.reduce((s, p) => s + p.length + p.extra, 0);
  const barPieces = roll.pieces
    .map((p, i) => {
      const total = p.length + p.extra;
      const title = p.extra > 1e-6 ? `${escapeHtml(p.label)} — ${fmt.m(p.length)} m + ${fmt.m(p.extra)} m to fill roll` : `${escapeHtml(p.label)} — ${fmt.m(p.length)} m`;
      return `<div class="roll-bar__piece" style="width:${((total / rollLength) * 100).toFixed(2)}%" title="${title}"><span class="roll-bar__piece-num">${i + 1}</span></div>`;
    })
    .join("");
  // Piece order within a roll is its physical cut order off that roll, so numbering it 1, 2, 3…
  // per roll (rather than reusing the RL/Strip label, which is the strip's position on its own lift)
  // gives the crew a simple cut sequence to follow roll by roll.
  const pieceRows = roll.pieces
    .map((p, i) => {
      const detail = p.extra > 1e-6 ? `${fmt.m(p.length + p.extra)} m (+${fmt.m(p.extra)} m to fill roll)` : `${fmt.m(p.length)} m`;
      return `<li><span class="roll-piece__label"><span class="roll-piece__num">${i + 1}.</span> ${escapeHtml(p.label)}</span><span class="roll-piece__value">${detail}</span></li>`;
    })
    .join("");
  const cut = isRollCut(index + 1);
  const productTag = roll.productLabel ? ` <span class="roll-card__product">${escapeHtml(roll.productLabel)}</span>` : "";
  return `
    <div class="roll-card${cut ? " is-cut" : ""}">
      <div class="roll-card__head">
        <span class="roll-card__title">Roll ${index + 1}${productTag}</span>
        <span class="roll-card__meta">${fmt.m(used)} m of ${fmt.m(rollLength)} m used · ${roll.pieces.length} piece${roll.pieces.length === 1 ? "" : "s"}</span>
        <label class="checkbox roll-card__cut">
          <input type="checkbox" class="roll-card__cut-input" data-roll="${index + 1}" ${cut ? "checked" : ""} />
          <span>Cut</span>
        </label>
      </div>
      <div class="roll-bar">${barPieces}</div>
      <ul class="roll-card__pieces">${pieceRows}</ul>
    </div>
  `;
}

function renderRollSchedule(rolls, rollGroupSize) {
  const list = document.getElementById("rollScheduleList");
  const emptyEl = document.getElementById("rollScheduleEmpty");
  const summaryEl = document.getElementById("rollScheduleSummary");
  const printBtn = document.getElementById("printRollScheduleBtn");
  const labelsBtn = document.getElementById("printRollLabelsBtn");
  const introEl = document.getElementById("rollScheduleIntro");
  if (introEl) {
    introEl.textContent =
      rollGroupSize > 0
        ? `Every strip and stitch, packed onto numbered rolls to get the least possible off-cut — but only ever shared between lifts within a ${rollGroupSize}-lift band, so a roll never mixes pieces from opposite ends of the job. Change "Group rolls across" in the spec panel to pool everything for the lowest possible waste instead.`
        : `Every strip and stitch across every lift, pooled together and packed onto numbered rolls to get the least possible off-cut — not one roll per lift. A strip can share a roll with pieces from other levels, and a roll can supply pieces to more than one level. Set "Group rolls across" in the spec panel to keep rolls within a band of nearby lifts instead.`;
  }

  if (!rolls.length) {
    list.innerHTML = "";
    emptyEl.hidden = false;
    summaryEl.hidden = true;
    printBtn.hidden = true;
    labelsBtn.hidden = true;
    return;
  }

  emptyEl.hidden = true;
  printBtn.hidden = false;
  labelsBtn.hidden = false;
  summaryEl.hidden = false;

  const totalPieces = rolls.reduce((s, roll) => s + roll.pieces.length, 0);
  const extraTotal = rolls.reduce((s, roll) => s + roll.pieces.reduce((s2, p) => s2 + p.extra, 0), 0);
  summaryEl.textContent = `${rolls.length} roll${rolls.length === 1 ? "" : "s"} · ${fmt.int(totalPieces)} pieces · every roll fully used${
    extraTotal > 1e-6 ? ` (${fmt.m(extraTotal)} m installed as extra embedment to avoid off-cut, see individual pieces below)` : ""
  }.`;

  list.innerHTML = rolls.map((roll, i) => buildRollCardHtml(roll, i)).join("");
}

// Delegated once on the (persistent) list container — card HTML is fully replaced on every
// render, so per-card listeners would leak; this survives re-renders for free.
document.getElementById("rollScheduleList").addEventListener("change", (e) => {
  const input = e.target.closest(".roll-card__cut-input");
  if (!input) return;
  setRollCut(input.dataset.roll, input.checked);
  input.closest(".roll-card").classList.toggle("is-cut", input.checked);
  updateProgressStats();
});

/** Small stick-on tags, 3-up per row, meant to be printed, cut apart, and stuck straight onto each
 *  physical roll before it goes out — so the field crew is reading a label on the roll itself instead
 *  of matching numbers off a table. */
function buildRollLabelsHtml(rolls, project) {
  const cards = rolls
    .map((roll, i) => {
      const pieces = roll.pieces
        .map((p, i) => `<li><span>${i + 1}. ${escapeHtml(p.label)}</span><span>${fmt.m(p.length + p.extra)} m</span></li>`)
        .join("");
      const productBit = roll.productLabel ? `${escapeHtml(roll.productLabel)} — ` : "";
      return `
        <div class="roll-label">
          <div class="roll-label__num">Roll ${i + 1}</div>
          <div class="roll-label__len">${productBit}${fmt.m(roll.rollLength)} m roll — ${escapeHtml(project)}</div>
          <ul class="roll-label__pieces">${pieces}</ul>
        </div>
      `;
    })
    .join("");
  return `<div class="roll-label-sheet">${cards}</div>`;
}

document.getElementById("printRollLabelsBtn").addEventListener("click", () => {
  const project = document.getElementById("projectName").value || "GeoMate";
  const rolls = window.__geogridRolls || [];
  document.getElementById("rollLabelsPrintView").innerHTML = buildRollLabelsHtml(rolls, project);
  document.body.classList.add("printing-roll-labels");
  window.print();
});

document.getElementById("printRollScheduleBtn").addEventListener("click", () => {
  const project = document.getElementById("projectName").value || "GeoMate";
  const rolls = window.__geogridRolls || [];
  const cards = rolls.map((roll, i) => buildRollCardHtml(roll, i)).join("");
  document.getElementById("rollSchedulePrintView").innerHTML = `
    <h2 class="roll-print-heading">${escapeHtml(project)} — Roll cutting schedule</h2>
    <div class="roll-schedule-list">${cards}</div>
  `;
  document.body.classList.add("printing-rolls");
  window.print();
});

/* ============================================================
   CSV export
   ============================================================ */

document.getElementById("exportBtn").addEventListener("click", () => {
  const results = window.__geogridResults || [];
  const { rollGroupSize, installRate, baseLevel } = readSettings();
  const productSpecs = readProductSpecs();
  const project = document.getElementById("projectName").value || "geomate";

  const lines = [
    `Project,${csvEscape(project)}`,
    "",
    "Products",
    "Name,Roll width (m),Min overlap (mm),Roll length (m),Cost per roll,Wrap/lap allowance (m)",
    ...products.map((p) => {
      const spec = productSpecs[p.id];
      return [csvEscape(spec.label), spec.w, Math.round(spec.oMin * 1000), spec.rollLength, spec.costPerRoll, spec.wrapAllowance].join(",");
    }),
    "",
    `Roll grouping,${rollGroupSize > 0 ? `${rollGroupSize} adjacent lifts` : "pooled across all lifts"}`,
    `Material cost,${csvEscape(document.getElementById("statCost").textContent)}`,
    `Est. install time,${csvEscape(document.getElementById("statInstallTime").textContent)}`,
    `Base level (RL),${baseLevel != null ? baseLevel : ""}`,
    `Total fill volume,${csvEscape(document.getElementById("statVolume").textContent)}`,
    "",
    "RL,Product,Face length (m),Embedment (m),Strips,Overlap (mm),Material width (m),Area (m2),Theoretical area (m2),Lift thickness (m),Fill volume (m3),Source",
  ];
  results.forEach((r) => {
    const isMixed = !!(r.cutPlan && r.cutPlan.manual);
    lines.push(
      [
        csvEscape(r.rl),
        // A manually built row can mix products strip-by-strip — the per-row Product column can't
        // show one name for that, so it's flagged "Mixed" here; the full strip-by-strip breakdown is
        // in the roll cutting schedule section below, where each piece is labelled by its own product.
        csvEscape(isMixed ? "Mixed" : r.productLabel),
        r.L.toFixed(3),
        r.mode === "extents" ? "variable" : r.embed.toFixed(3),
        r.n,
        r.overlap != null ? Math.round(r.overlap * 1000) : "",
        r.materialWidth.toFixed(3),
        r.area.toFixed(3),
        r.theoreticalArea.toFixed(3),
        r.liftThickness > 0 ? r.liftThickness.toFixed(3) : "",
        r.fillVolume != null ? r.fillVolume.toFixed(3) : "",
        r.mode === "extents" ? "DXF extents" : "manual",
      ].join(",")
    );
  });

  const extentsResults = results.filter((r) => r.mode === "extents");
  if (extentsResults.length) {
    lines.push("", "Cut schedule (DXF extents lifts)", "RL,Strip #,Cut length (m),Note");
    extentsResults.forEach((r) => {
      r.stripLengths.forEach((len, i) => {
        lines.push([csvEscape(r.rl), i + 1, len.toFixed(3), ""].join(","));
        (r.cutPlan.stitches[i] || []).forEach((s, si) => {
          const label = r.cutPlan.stitches[i].length > 1 ? `${i + 1}.${si + 1}` : `${i + 1}`;
          lines.push([csvEscape(r.rl), label, s.length.toFixed(3), `stitch, starts ${Math.round(s.offset * 1000)} mm back`].join(","));
        });
      });
    });
  }

  const rolls = window.__geogridRolls || [];
  if (rolls.length) {
    lines.push("", "Roll cutting schedule", "Roll #,Product,Piece,Length (m),Roll off-cut (m)");
    rolls.forEach((roll, i) => {
      roll.pieces.forEach((p) => {
        lines.push([i + 1, csvEscape(roll.productLabel), csvEscape(p.label), p.length.toFixed(3), p.extra > 1e-6 ? p.extra.toFixed(3) : ""].join(","));
      });
    });
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${project.replace(/[^a-z0-9-_]+/gi, "_")}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

function csvEscape(str) {
  const s = String(str);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RL and the project name are free-text user input rendered via innerHTML in several places — escape before inserting. */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ============================================================
   Landfill liner — a separate, self-contained calculator: lining a dug excavation (floor +
   battered sides) to stop leachate reaching natural ground, not stacked lift-by-lift fill like
   the rest of this app. Shares the roll width/overlap/length spec and the strip-diagram/roll-
   packing helpers above, but has its own geometry inputs and its own small results panel — it
   doesn't touch the lift table or the main Material schedule sidebar, which is a different job.
   ============================================================ */

const linerInputs = {
  rollWidth: document.getElementById("linerRollWidth"),
  minOverlap: document.getElementById("linerMinOverlap"),
  rollLength: document.getElementById("linerRollLength"),
  floorLength: document.getElementById("linerFloorLength"),
  floorWidth: document.getElementById("linerFloorWidth"),
  depth: document.getElementById("linerDepth"),
  slope: document.getElementById("linerSlope"),
  extendFace: document.getElementById("linerExtendFaceToggle"),
};

/** Back to the same defaults a fresh project starts with — a blank roll width would break the
 *  liner calculation entirely, so the roll spec resets to real numbers, not blank like the floor
 *  dimensions (which have no sensible default of their own). Shared by New Project and the liner's
 *  own Reset button, so the "starting point" stays defined in exactly one place. */
function resetLinerInputs() {
  linerInputs.rollWidth.value = "1.3";
  linerInputs.minOverlap.value = "300";
  linerInputs.rollLength.value = "50";
  linerInputs.floorLength.value = "";
  linerInputs.floorWidth.value = "";
  linerInputs.depth.value = "";
  linerInputs.slope.value = "";
  linerInputs.extendFace.checked = false;
}

document.getElementById("linerResetBtn").addEventListener("click", () => {
  if (!window.confirm("Reset the Landfill liner's roll spec and floor dimensions back to their defaults?")) return;
  resetLinerInputs();
  computeAndRender();
});

/**
 * Models the excavation as a rectangular-floor truncated pyramid: a flat floor rising on a
 * uniform side slope on all four sides to its crest. Both wall pairs share the same slope
 * length (Pythagoras on depth + slope ratio doesn't depend on which floor edge it rises from);
 * only their trapezoid base widths differ, matching the floor's own length vs width.
 */
function computeLinerPlan(Lf, Wf, D, slopeRatio, w, oMin, extendFace) {
  if (!(Lf > 0) || !(Wf > 0) || !(D > 0) || !(slopeRatio >= 0) || !(w > 0) || oMin < 0 || oMin >= w) return null;

  const S = D * Math.sqrt(1 + slopeRatio * slopeRatio); // slope length, same up every wall
  const horizRun = D * slopeRatio; // crest set-back from the floor edge, per side

  const floorArea = Lf * Wf;
  const longWallArea = ((Lf + (Lf + 2 * horizRun)) / 2) * S * 2; // both long walls
  const endWallArea = ((Wf + (Wf + 2 * horizRun)) / 2) * S * 2; // both end walls
  const wallArea = longWallArea + endWallArea;
  const totalArea = floorArea + wallArea;

  // Main run: down one long wall, across the floor, up the other — one continuous panel per
  // strip, tiled across the floor length. Minimises seams crossing a slope (a real leachate-risk
  // point), matching how liner panels are actually laid out on site.
  const mainPanelLength = 2 * S + Wf;
  let mainResult = calcLift(Lf, w, oMin);

  // End walls: the two shorter sides, each its own panel run tiled across the floor width — same
  // strip-count math, idealised the same way the rest of this app treats a tapering face (strip
  // count comes from the baseline length; only the CUT length reflects the slope).
  let endResult = calcLift(Wf, w, oMin);

  // Extend mode, liner version: pin overlap to exactly the minimum on both runs — but unlike the
  // takeoff table, there's no "face length" here to grow instead. Lf/Wf/floorArea/wallArea are the
  // real dug excavation and can never change, so this only affects how each run's overlap is
  // reported, not the excavation itself.
  if (extendFace) {
    if (mainResult && mainResult.n > 1) mainResult = { ...mainResult, overlap: oMin };
    if (endResult && endResult.n > 1) endResult = { ...endResult, overlap: oMin };
  }

  return { S, horizRun, floorArea, wallArea, totalArea, mainPanelLength, mainResult, endResult };
}

function renderLiner() {
  const w = parseFloat(linerInputs.rollWidth.value) || 0;
  const oMin = (parseFloat(linerInputs.minOverlap.value) || 0) / 1000;
  const rollLength = parseFloat(linerInputs.rollLength.value) || 0;
  const Lf = parseFloat(linerInputs.floorLength.value) || 0;
  const Wf = parseFloat(linerInputs.floorWidth.value) || 0;
  const D = parseFloat(linerInputs.depth.value) || 0;
  const slopeRaw = parseFloat(linerInputs.slope.value);

  // Same "blank isn't an error, an explicit bad value is" distinction as the takeoff table's own
  // spec warnings — a fresh, not-yet-filled-in liner shouldn't greet the user with a wall of red.
  const specIssues = [];
  if (oMin < 0) {
    specIssues.push(`Minimum overlap can't be negative.`);
  } else if (oMin >= w) {
    specIssues.push(`Minimum overlap (${fmt.mm(oMin)} mm) must be smaller than the roll width (${w} m).`);
  }
  const rollLengthRaw = linerInputs.rollLength.value;
  if (rollLengthRaw.trim() !== "" && parseFloat(rollLengthRaw) <= 0) {
    specIssues.push(`Roll length must be greater than zero — "Rolls to order" will show as 0 until it's fixed.`);
  }
  [
    ["floorLength", "Floor length"],
    ["floorWidth", "Floor width"],
    ["depth", "Depth"],
  ].forEach(([key, label]) => {
    const raw = linerInputs[key].value;
    if (raw.trim() !== "" && parseFloat(raw) <= 0) specIssues.push(`${label} must be greater than zero.`);
  });
  const specWarningEl = document.getElementById("linerSpecWarning");
  specWarningEl.hidden = specIssues.length === 0;
  specWarningEl.innerHTML = specIssues.map((m) => `<span>${escapeHtml(m)}</span>`).join("<br>");

  const plan = computeLinerPlan(Lf, Wf, D, Number.isFinite(slopeRaw) ? slopeRaw : 0, w, oMin, linerInputs.extendFace.checked);

  const emptyEl = document.getElementById("linerEmpty");
  const resultsEl = document.getElementById("linerResults");
  if (!plan) {
    emptyEl.hidden = false;
    resultsEl.hidden = true;
    window.__geogridLinerRolls = [];
    return;
  }
  emptyEl.hidden = true;
  resultsEl.hidden = false;

  document.getElementById("linerStatFloor").innerHTML = `${fmt.m(plan.floorArea)}<small> m²</small>`;
  document.getElementById("linerStatWalls").innerHTML = `${fmt.m(plan.wallArea)}<small> m²</small>`;
  document.getElementById("linerStatTotal").innerHTML = `${fmt.m(plan.totalArea)}<small> m²</small>`;
  document.getElementById("linerStatSlope").innerHTML = `${fmt.m(plan.S)}<small> m</small>`;
  document.getElementById("linerStatPanels").textContent = plan.mainResult.n + plan.endResult.n * 2;

  // Pooled across the main run and both end walls, same bin-packing the main roll schedule uses —
  // a short end-wall panel can fill out what a long main-run panel leaves on a roll.
  const pieces = [];
  for (let i = 0; i < plan.mainResult.n; i++) pieces.push({ label: `Main run · panel ${i + 1}`, length: plan.mainPanelLength, seq: i });
  for (let i = 0; i < plan.endResult.n; i++) {
    pieces.push({ label: `End wall A · panel ${i + 1}`, length: plan.S, seq: 1000 + i });
    pieces.push({ label: `End wall B · panel ${i + 1}`, length: plan.S, seq: 2000 + i });
  }
  const rolls = rollLength > 0 ? packRollsDetailed(pieces, rollLength) : [];
  window.__geogridLinerRolls = rolls;
  document.getElementById("linerStatRolls").textContent = rolls.length;

  document.getElementById("linerMainDesc").textContent =
    `${plan.mainResult.n} panel${plan.mainResult.n === 1 ? "" : "s"} × ${fmt.m(plan.mainPanelLength)} m long (down ${fmt.m(plan.S)} m of slope, ${fmt.m(Wf)} m across the floor, up ${fmt.m(plan.S)} m of the far slope), tiled across the ${fmt.m(Lf)} m floor length.`;
  renderDiagram(document.getElementById("linerMainDiagram"), Lf, plan.mainResult, w);

  document.getElementById("linerEndDesc").textContent =
    `${plan.endResult.n} panel${plan.endResult.n === 1 ? "" : "s"} × ${fmt.m(plan.S)} m long, per end wall (×2), tiled across the ${fmt.m(Wf)} m floor width.`;
  renderDiagram(document.getElementById("linerEndDiagram"), Wf, plan.endResult, w);
}

Object.values(linerInputs).forEach((el) => el.addEventListener("input", computeAndRender));

/* ============================================================
   State snapshot — serialize/restore everything a project is (spec, settings, every lift row
   including DXF/mesh-derived extents, and the liner inputs). Shared by Autosave below (one fixed
   slot, always tracking whatever's currently open) and the named-project Save/Load/Delete further
   down (explicit snapshots the foreman picks a name for) — same shape either way, just a different
   localStorage key.
   ============================================================ */

function buildStateSnapshot() {
  const rows = Array.from(tbody.querySelectorAll(".lift-row")).map((row) => ({
    liftId: row.dataset.liftId,
    rl: row.querySelector(".rl-input").value,
    isIntermediate: !row.querySelector(".intermediate-badge").hidden,
    mode: row.dataset.mode,
    faceLength: row.querySelector(".face-length").value,
    coords: row.querySelector(".face-coords").value,
    embed: row.querySelector(".embed-length").value,
    extentsPoints: row._extentsPoints || null,
    faceCycle: row._faceCycle || 0,
    batteredLevel: !!row._batteredLevel,
    product: row.querySelector(".product-select").value,
    // A manually built mixed-product sequence — null when the row is on ordinary automatic layout.
    // _manualStripsSaved carries a sequence built earlier and since toggled off back to automatic, so
    // reopening the saved project doesn't lose it even though it's not currently active.
    manualStrips: row._manualStrips || null,
    manualStripsSaved: row._manualStripsSaved || null,
    manualActiveProduct: row._manualActiveProduct || null,
  }));
  return {
    version: 2,
    projectName: document.getElementById("projectName").value,
    settings: {
      rollGroupSize: settingsInputs.rollGroupSize.value,
      installRate: settingsInputs.installRate.value,
      baseLevel: settingsInputs.baseLevel.value,
      extendFace: settingsInputs.extendFace.checked,
      packSide: settingsInputs.packSide.checked,
      packSideValue: settingsInputs.packSideValue.value,
    },
    products: snapshotProductRows(),
    rows,
    liner: {
      rollWidth: linerInputs.rollWidth.value,
      minOverlap: linerInputs.minOverlap.value,
      rollLength: linerInputs.rollLength.value,
      floorLength: linerInputs.floorLength.value,
      floorWidth: linerInputs.floorWidth.value,
      depth: linerInputs.depth.value,
      slope: linerInputs.slope.value,
      extendFace: linerInputs.extendFace.checked,
    },
  };
}

/** Rebuilds the settings panel, lift table, and liner inputs from a saved state. Returns true if anything was restored. */
function applyStateSnapshot(state) {
  const hasRows = state && Array.isArray(state.rows) && state.rows.length;
  const l = state && state.liner;
  const hasLiner = l && (l.floorLength || l.floorWidth || l.depth || l.slope);
  if (!state || (!hasRows && !hasLiner)) return false;

  if (state.projectName != null) document.getElementById("projectName").value = state.projectName;
  const s = state.settings || {};
  if (s.rollGroupSize != null) settingsInputs.rollGroupSize.value = s.rollGroupSize;
  if (s.installRate != null) settingsInputs.installRate.value = s.installRate;
  if (s.baseLevel != null) settingsInputs.baseLevel.value = s.baseLevel;
  if (s.extendFace != null) settingsInputs.extendFace.checked = !!s.extendFace;
  if (s.packSideValue != null) settingsInputs.packSideValue.value = s.packSideValue;
  if (s.packSide != null) {
    settingsInputs.packSide.checked = !!s.packSide;
    packSideField.hidden = !s.packSide;
    packSideHint.hidden = !s.packSide;
  }

  // A project saved before the product list became editable (version 1) stored RE580's spec as
  // fixed settings.* fields and Strata's as a separate top-level strata block instead of a products
  // array — synthesize the same two products from those old fields so nothing already saved is lost.
  if (Array.isArray(state.products) && state.products.length) {
    renderProductTable(state.products);
  } else {
    renderProductTable(legacyProductRowsFrom(state));
  }

  if (l) {
    if (l.rollWidth != null) linerInputs.rollWidth.value = l.rollWidth;
    if (l.minOverlap != null) linerInputs.minOverlap.value = l.minOverlap;
    if (l.rollLength != null) linerInputs.rollLength.value = l.rollLength;
    if (l.floorLength != null) linerInputs.floorLength.value = l.floorLength;
    if (l.floorWidth != null) linerInputs.floorWidth.value = l.floorWidth;
    if (l.depth != null) linerInputs.depth.value = l.depth;
    if (l.slope != null) linerInputs.slope.value = l.slope;
    if (l.extendFace != null) linerInputs.extendFace.checked = !!l.extendFace;
  }

  // Loading a named project needs to fully replace whatever's currently in the table — unlike the
  // boot-time autosave restore (the only other caller), which always runs against an empty table.
  tbody.innerHTML = "";

  // A project saved before rows carried their own liftId (see newLiftId) tracked "Installed" by RL
  // text instead — count how many rows share each such RL so the migration below only runs where
  // it's unambiguous (one row, not a same-RL group the old scheme couldn't tell apart anyway).
  const legacyRlCounts = new Map();
  (state.rows || []).forEach((r) => {
    if (!r.liftId && r.rl) legacyRlCounts.set(r.rl, (legacyRlCounts.get(r.rl) || 0) + 1);
  });

  (state.rows || []).forEach((r) => {
    const row = addLiftRow(r.rl || "", r.mode === "length" ? r.faceLength || "" : "", r.embed || "", null, !!r.isIntermediate, r.liftId || null);
    if (!r.liftId && r.rl && legacyRlCounts.get(r.rl) === 1 && isLiftInstalled(r.rl)) {
      setLiftInstalled(row.dataset.liftId, true);
    }
    if (r.product) row.querySelector(".product-select").value = r.product;
    if (r.mode === "coords") {
      row.dataset.mode = "coords";
      row.querySelector(".face-input__length").hidden = true;
      row.querySelector(".face-coords").hidden = false;
      row.querySelector(".face-coords").value = r.coords || "";
      const modeBtn = row.querySelector(".mode-toggle");
      setModeToggleIcon(modeBtn, true);
      modeBtn.title = "Pasted-coordinate arc length — click to switch to a straight length";
    } else if (r.mode === "extents" && Array.isArray(r.extentsPoints) && r.extentsPoints.length) {
      applyExtents(row, r.extentsPoints);
      // faceCycle is the current field; extentsSwapped is what a project saved before "Swap
      // face/back" became a full cycle (see pickFaceByIndex) used — true meant exactly one swap,
      // which is what faceCycle 1 still means, so it maps across losslessly.
      row._faceCycle = r.faceCycle != null ? r.faceCycle : r.extentsSwapped ? 1 : 0;
      row._batteredLevel = !!r.batteredLevel;
      if (Array.isArray(r.manualStrips)) row._manualStrips = r.manualStrips;
      if (Array.isArray(r.manualStripsSaved)) row._manualStripsSaved = r.manualStripsSaved;
      if (r.manualActiveProduct) row._manualActiveProduct = r.manualActiveProduct;
    }
  });

  return true;
}

/* ============================================================
   Autosave — one fixed slot (not per-project), always tracking whatever's currently open, saved on
   every recompute and restored on load. A refresh or an accidentally-closed tab shouldn't cost a
   foreman their afternoon's data entry. Separate from the named-project Save/Load below, and from
   the install-tracking progress above (which IS deliberately keyed by project name).
   ============================================================ */
const AUTOSAVE_KEY = "geogrid-autosave";

function saveAutosave() {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(buildStateSnapshot()));
  } catch {
    /* storage full or unavailable — autosave just won't persist across reloads */
  }
}

function restoreAutosave() {
  try {
    return applyStateSnapshot(JSON.parse(localStorage.getItem(AUTOSAVE_KEY)));
  } catch {
    return false;
  }
}

/* ============================================================
   Named projects — explicit snapshots under a name the foreman picks (the Project field), separate
   from the single always-on autosave slot above. Save/Load/Delete only ever run when a button is
   clicked, never automatically, so switching jobs never silently overwrites anything.
   ============================================================ */
const PROJECT_INDEX_KEY = "geogrid-project-names";
const PROJECT_KEY_PREFIX = "geogrid-project::";

function listSavedProjects() {
  try {
    const names = JSON.parse(localStorage.getItem(PROJECT_INDEX_KEY));
    return Array.isArray(names) ? names.filter((n) => typeof n === "string") : [];
  } catch {
    return [];
  }
}

function refreshProjectList() {
  const select = document.getElementById("projectSelect");
  const loadBtn = document.getElementById("loadProjectBtn");
  const deleteBtn = document.getElementById("deleteProjectBtn");
  const names = listSavedProjects().sort((a, b) => a.localeCompare(b));
  const current = document.getElementById("projectName").value.trim();

  select.innerHTML = names.length
    ? names.map((n) => `<option value="${escapeHtml(n)}"${n === current ? " selected" : ""}>${escapeHtml(n)}</option>`).join("")
    : `<option value="">— none saved yet —</option>`;
  select.disabled = !names.length;
  loadBtn.disabled = !names.length;
  deleteBtn.disabled = !names.length;
}

document.getElementById("saveProjectBtn").addEventListener("click", () => {
  const statusEl = document.getElementById("projectStatus");
  const name = document.getElementById("projectName").value.trim();
  if (!name) {
    statusEl.textContent = "Enter a project name first.";
    statusEl.className = "cutplan-status is-error";
    return;
  }
  try {
    localStorage.setItem(PROJECT_KEY_PREFIX + name, JSON.stringify(buildStateSnapshot()));
    const names = listSavedProjects();
    if (!names.includes(name)) {
      names.push(name);
      localStorage.setItem(PROJECT_INDEX_KEY, JSON.stringify(names));
    }
    refreshProjectList();
    statusEl.textContent = `Saved as "${name}".`;
    statusEl.className = "cutplan-status is-ok";
  } catch {
    statusEl.textContent = "Couldn't save — local storage may be full.";
    statusEl.className = "cutplan-status is-error";
  }
});

document.getElementById("loadProjectBtn").addEventListener("click", () => {
  const statusEl = document.getElementById("projectStatus");
  const name = document.getElementById("projectSelect").value;
  if (!name) return;

  let state;
  try {
    state = JSON.parse(localStorage.getItem(PROJECT_KEY_PREFIX + name));
  } catch {
    state = null;
  }
  if (!applyStateSnapshot(state)) {
    statusEl.textContent = `Couldn't load "${name}" — it may be corrupted.`;
    statusEl.className = "cutplan-status is-error";
    return;
  }
  computeAndRender();
  statusEl.textContent = `Loaded "${name}".`;
  statusEl.className = "cutplan-status is-ok";
});

document.getElementById("deleteProjectBtn").addEventListener("click", () => {
  const statusEl = document.getElementById("projectStatus");
  const name = document.getElementById("projectSelect").value;
  if (!name) return;
  if (!window.confirm(`Delete the saved project "${name}"? This can't be undone.`)) return;

  localStorage.removeItem(PROJECT_KEY_PREFIX + name);
  localStorage.setItem(PROJECT_INDEX_KEY, JSON.stringify(listSavedProjects().filter((n) => n !== name)));
  refreshProjectList();
  statusEl.textContent = `Deleted "${name}".`;
  statusEl.className = "cutplan-status is-ok";
});

document.getElementById("exportProjectBtn").addEventListener("click", () => {
  const name = document.getElementById("projectName").value.trim() || "untitled-project";
  const blob = new Blob([JSON.stringify(buildStateSnapshot(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[^a-z0-9-_]+/gi, "_")}.geogrid.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

document.getElementById("importProjectInput").addEventListener("change", async (e) => {
  const statusEl = document.getElementById("importProjectStatus");
  const file = e.target.files[0];
  e.target.value = ""; // same file re-selected twice in a row should still fire 'change'
  if (!file) return;

  let state;
  try {
    state = JSON.parse(await file.text());
  } catch {
    statusEl.textContent = `Couldn't read "${file.name}" — not a valid project file.`;
    statusEl.className = "cutplan-status is-error";
    return;
  }
  if (!applyStateSnapshot(state)) {
    statusEl.textContent = `Couldn't read "${file.name}" — not a valid project file.`;
    statusEl.className = "cutplan-status is-error";
    return;
  }
  computeAndRender();
  refreshProjectList();
  statusEl.textContent = `Imported "${file.name}". Use Save as project above to keep it in this browser too.`;
  statusEl.className = "cutplan-status is-ok";
});

document.getElementById("projectName").addEventListener("input", saveAutosave);
document.getElementById("projectName").addEventListener("input", refreshProjectList);

/** Clears the table, settings, and liner inputs back to their defaults — the working autosave slot
 *  reflects that empty state again too (computeAndRender saves it), so reopening this same page
 *  later won't bring the old data back either. Anything not explicitly Saved as a project is lost —
 *  hence the confirm, same as the named-project Delete button. */
document.getElementById("newProjectBtn").addEventListener("click", () => {
  if (!window.confirm("Clear everything and start a new blank project? Anything not saved under a project name will be lost.")) return;

  document.getElementById("projectName").value = "Untitled cut-face reinforcement";
  settingsInputs.rollGroupSize.value = "";
  settingsInputs.installRate.value = "";
  settingsInputs.baseLevel.value = "";
  settingsInputs.extendFace.checked = false;
  settingsInputs.packSide.checked = false;
  settingsInputs.packSideValue.value = "left";
  packSideField.hidden = true;
  packSideHint.hidden = true;

  renderProductTable(defaultProductRows());
  resetLinerInputs();

  ["genStartRL", "genSpacing", "genCount", "interFromRL", "interToRL", "bulkPasteInput"].forEach((id) => {
    document.getElementById(id).value = "";
  });
  ["genStatus", "interStatus", "dxfLengthsStatus", "benchedStatus", "batteredStatus", "dxfExtentsStatus", "bulkPasteStatus", "projectStatus"].forEach((id) => {
    const el = document.getElementById(id);
    el.textContent = "";
    el.className = "cutplan-status";
  });

  lastBatteredTriangles = null;
  document.getElementById("rebuildBatteredBtn").hidden = true;

  tbody.innerHTML = "";
  switchTab("takeoff");
  computeAndRender();
  refreshProjectList();
});

/* ============================================================
   Boot — restore the last autosaved project, if any; otherwise start empty
   and use "Generate lift rows" or "Add lift" to begin.
   ============================================================ */
restoreAutosave();
refreshProjectList();
computeAndRender();
