"use strict";

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
  });

  function updateThemeIcons() {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const current = document.documentElement.getAttribute("data-theme") || (prefersDark ? "dark" : "light");
    document.getElementById("themeIconDark").hidden = current === "dark";
    document.getElementById("themeIconLight").hidden = current !== "dark";
  }
})();

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

/** Longest chain = face; the longest, most anti-parallel remaining chain = back. */
function pickFaceAndBack(chains) {
  const sorted = chains.slice().sort((a, b) => b.length - a.length);
  const face = sorted[0];
  let back = sorted[1] || null, bestDot = back ? face.dir.x * back.dir.x + face.dir.y * back.dir.y : 1;
  for (let i = 2; i < sorted.length; i++) {
    const c = sorted[i];
    if (c.length < face.length * 0.15) continue;
    const dot = face.dir.x * c.dir.x + face.dir.y * c.dir.y;
    if (dot < bestDot) { bestDot = dot; back = c; }
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

function castRay(origin, dir, poly, excludeEdges) {
  let best = Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    if (excludeEdges.some((e) => e.from === p && e.to === q)) continue;
    const sx = q.x - p.x, sy = q.y - p.y;
    const denom = dir.x * sy - dir.y * sx;
    if (Math.abs(denom) < 1e-9) continue;
    const dx = p.x - origin.x, dy = p.y - origin.y;
    const t = (dx * sy - dy * sx) / denom;
    const u = (dx * dir.y - dy * dir.x) / denom;
    if (t > 1e-6 && u >= -1e-6 && u <= 1 + 1e-6 && t < best) best = t;
  }
  return best;
}

function inwardNormal(tangent) {
  return { x: -tangent.y, y: tangent.x };
}

/** Full cut plan for one lift's extents polygon: face length, strip count/overlap, and each strip's clipped cut length. */
function computeCutPlan(rawPoints, w, oMin, swapped) {
  const poly = ensureCCW(rawPoints.map((p) => ({ x: p.x, y: p.y })));
  const chains = chainEdges(poly);
  if (chains.length < 2) return null;
  let { face, back } = pickFaceAndBack(chains);
  if (swapped && back) { const t = face; face = back; back = t; }

  const result = calcLift(face.length, w, oMin);
  if (!result) return null;
  const pitch = result.n > 1 ? w - result.overlap : 0;

  const cutLengths = [];
  for (let i = 0; i < result.n; i++) {
    const station = Math.max(0, Math.min(face.length, i * pitch + w / 2));
    const pt = pointAtStation(face, station);
    const normal = inwardNormal(pt.tangent);
    const dist = castRay(pt, normal, poly, face.edges);
    cutLengths.push(Number.isFinite(dist) ? dist : 0);
  }

  return {
    poly,
    face,
    back,
    faceLength: face.length,
    n: result.n,
    overlap: result.overlap,
    materialWidth: result.materialWidth,
    cutLengths,
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

  const visited = new Set();
  const loops = [];
  boundary.forEach(({ p, q }) => {
    const startKey = keyOf(p);
    if (visited.has(edgeKey(startKey, keyOf(q)))) return;
    const loop = [p];
    let currentKey = startKey;
    let guard = 0;
    while (guard++ < 100000) {
      let next = null;
      for (const o of adj.get(currentKey) || []) {
        const ek = edgeKey(currentKey, o.to);
        if (!visited.has(ek)) { next = o; break; }
      }
      if (!next) break;
      visited.add(edgeKey(currentKey, next.to));
      currentKey = next.to;
      if (currentKey === startKey) break;
      loop.push(next.point);
    }
    if (loop.length >= 3) loops.push(loop);
  });
  return loops.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
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
    const closed = !!(entity.flags & 1);
    if (!closed) return;
    const pts = entity.pts.slice();
    const first = pts[0], last = pts[pts.length - 1];
    if (Math.hypot(last.x - first.x, last.y - first.y) < 1e-9) pts.pop();
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
function packRolls(lengths, rollLength) {
  if (!(rollLength > 0)) return { rolls: 0, purchased: 0, used: 0, offcut: 0 };
  const sorted = lengths.filter((l) => l > 1e-6).slice().sort((a, b) => b - a);
  const bins = [];
  let rolls = 0, purchased = 0, used = 0;
  sorted.forEach((len) => {
    used += len;
    if (len > rollLength) {
      const need = Math.ceil(len / rollLength);
      rolls += need;
      purchased += need * rollLength;
      return;
    }
    for (let i = 0; i < bins.length; i++) {
      if (bins[i] >= len - 1e-9) { bins[i] -= len; return; }
    }
    rolls += 1;
    purchased += rollLength;
    bins.push(rollLength - len);
  });
  return { rolls, purchased, used, offcut: purchased - used };
}

/* ============================================================
   DOM wiring
   ============================================================ */

const tbody = document.getElementById("liftTableBody");
const rowTemplate = document.getElementById("liftRowTemplate");
const emptyState = document.getElementById("emptyState");

const settingsInputs = {
  rollWidth: document.getElementById("rollWidth"),
  minOverlapMm: document.getElementById("minOverlap"),
  rollLength: document.getElementById("rollLength"),
};

function readSettings() {
  return {
    w: parseFloat(settingsInputs.rollWidth.value) || 0,
    oMin: (parseFloat(settingsInputs.minOverlapMm.value) || 0) / 1000,
    rollLength: parseFloat(settingsInputs.rollLength.value) || 0,
  };
}

function addLiftRow(rl = "", faceLength = "", embed = "", insertBeforeNode = null, isIntermediate = false) {
  const frag = rowTemplate.content.cloneNode(true);
  const row = frag.querySelector(".lift-row");
  row.querySelector(".rl-input").value = rl;
  row.querySelector(".face-length").value = faceLength;
  row.querySelector(".embed-length").value = embed;
  row.querySelector(".intermediate-badge").hidden = !isIntermediate;
  row.dataset.mode = "length";

  const modeBtn = row.querySelector(".mode-toggle");
  const lengthWrap = row.querySelector(".face-input__length");
  const coordsBox = row.querySelector(".face-coords");

  modeBtn.addEventListener("click", () => {
    const toCoords = row.dataset.mode === "length";
    row.dataset.mode = toCoords ? "coords" : "length";
    modeBtn.textContent = toCoords ? "XY" : "L";
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

  row.querySelector(".row-remove").addEventListener("click", () => {
    row.remove();
    computeAndRender();
  });

  row.querySelector(".extents-release").addEventListener("click", () => {
    releaseExtents(row);
    computeAndRender();
  });

  tbody.insertBefore(frag, insertBeforeNode);
  return row;
}

function applyExtents(row, points) {
  row._extentsPoints = points;
  row._extentsSwapped = false;
  row.dataset.mode = "extents";
  row.querySelector(".face-input__length").hidden = true;
  row.querySelector(".face-coords").hidden = true;
  row.querySelector(".extents-badge").hidden = false;
  row.querySelector(".mode-toggle").hidden = true;
}

function releaseExtents(row) {
  row._extentsPoints = null;
  row.dataset.mode = "length";
  row.querySelector(".extents-badge").hidden = true;
  row.querySelector(".face-input__length").hidden = false;
  row.querySelector(".face-coords").hidden = true;
  row.querySelector(".embed-length").hidden = false;
  const modeBtn = row.querySelector(".mode-toggle");
  modeBtn.hidden = false;
  modeBtn.textContent = "L";
  modeBtn.title = "Straight length — click to switch to pasted coordinates";
}

document.getElementById("addLiftBtn").addEventListener("click", () => {
  addLiftRow();
  computeAndRender();
});

document.getElementById("genBtn").addEventListener("click", () => {
  const start = parseFloat(document.getElementById("genStartRL").value) || 0;
  const spacingMm = parseFloat(document.getElementById("genSpacing").value) || 0;
  const count = Math.max(1, Math.round(parseFloat(document.getElementById("genCount").value) || 0));
  const spacing = spacingMm / 1000;

  tbody.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const rl = (start + i * spacing).toFixed(2);
    addLiftRow(rl, "", "");
  }
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
  const stripPx = w * scale;
  const pitchPx = n > 1 ? (w - overlap) * scale : 0;
  const ns = "http://www.w3.org/2000/svg";

  for (let i = 0; i < n; i++) {
    const x = pad + i * pitchPx;
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
      const overlapPx = stripPx - pitchPx;
      const ox = x;
      const orect = document.createElementNS(ns, "rect");
      orect.setAttribute("x", ox.toFixed(2));
      orect.setAttribute("y", 6);
      orect.setAttribute("width", Math.max(overlapPx, 0).toFixed(2));
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

/* ============================================================
   Compute + render everything
   ============================================================ */

const fmt = {
  int: (v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }),
  m: (v) => v.toLocaleString(undefined, { maximumFractionDigits: 2 }),
  mm: (v) => Math.round(v * 1000).toLocaleString(),
  pct: (v) => `${v.toFixed(1)}%`,
};

function wasteLevel(pct) {
  if (pct <= 8) return "good";
  if (pct <= 18) return "warn";
  return "critical";
}

function computeAndRender() {
  const { w, oMin, rollLength } = readSettings();
  const specWarning = document.getElementById("specWarning");
  if (oMin >= w) {
    specWarning.hidden = false;
    specWarning.textContent = `Minimum overlap (${fmt.mm(oMin)} mm) must be smaller than the roll width (${w} m).`;
  } else {
    specWarning.hidden = true;
  }

  const rows = Array.from(tbody.querySelectorAll(".lift-row"));
  emptyState.hidden = rows.length > 0;

  const liftResults = [];

  rows.forEach((row) => {
    const rl = row.querySelector(".rl-input").value.trim();
    const mode = row.dataset.mode;
    const embedRangeEl = row.querySelector(".embed-range");
    const embedInput = row.querySelector(".embed-length");

    const strips = row.querySelector(".strip-count");
    const overlapCell = row.querySelector(".overlap-value");
    const areaCell = row.querySelector(".area-value");
    const diagram = row.querySelector(".strip-diagram");

    let L, result, stripLengths, theoreticalArea, cutPlan = null;

    if (mode === "extents" && row._extentsPoints) {
      cutPlan = oMin < w ? computeCutPlan(row._extentsPoints, w, oMin, row._extentsSwapped) : null;
      if (cutPlan) {
        L = cutPlan.faceLength;
        result = { n: cutPlan.n, overlap: cutPlan.overlap, materialWidth: cutPlan.materialWidth };
        stripLengths = cutPlan.cutLengths;
        theoreticalArea = cutPlan.polygonArea;
        row.querySelector(".face-length").value = L.toFixed(2);
        embedInput.hidden = true;
        if (stripLengths.length) {
          const lo = Math.min(...stripLengths), hi = Math.max(...stripLengths);
          embedRangeEl.textContent = `${fmt.m(lo)}–${fmt.m(hi)} m cut`;
        }
      }
    } else {
      L = mode === "coords" ? parseCoordsLength(row.querySelector(".face-coords").value) : parseFloat(row.querySelector(".face-length").value) || 0;
      const embed = parseFloat(embedInput.value) || 0;
      embedInput.hidden = false;
      embedRangeEl.textContent = "";
      result = oMin < w ? calcLift(L, w, oMin) : null;
      if (result && embed > 0) {
        stripLengths = new Array(result.n).fill(embed);
        theoreticalArea = L * embed;
      }
    }

    if (!result || !L || L <= 0 || !stripLengths || !stripLengths.length) {
      strips.textContent = "—";
      overlapCell.textContent = "—";
      areaCell.textContent = "—";
      strips.classList.add("is-empty");
      overlapCell.classList.add("is-empty");
      areaCell.classList.add("is-empty");
      diagram.innerHTML = "";
      return;
    }

    strips.classList.remove("is-empty");
    overlapCell.classList.remove("is-empty");
    areaCell.classList.remove("is-empty");

    strips.textContent = result.n;
    overlapCell.textContent = result.n > 1 ? `${fmt.mm(result.overlap)} mm` : "—";
    const area = stripLengths.reduce((s, len) => s + w * len, 0);
    areaCell.textContent = fmt.m(area);
    renderDiagram(diagram, L, result, w);

    const footprint =
      mode === "extents" && cutPlan ? localFootprint(cutPlan) : rectFootprint(L, Math.max(...stripLengths));

    liftResults.push({
      rl,
      L,
      n: result.n,
      overlap: result.overlap,
      materialWidth: result.materialWidth,
      stripLengths,
      area,
      theoreticalArea,
      embed: mode === "extents" ? null : parseFloat(embedInput.value) || 0,
      cutPlan,
      mode,
      row,
      footprint,
    });
  });

  renderSummary(liftResults, rollLength);
  renderSequence(liftResults, w);
  renderCutPlan(liftResults, w);
  render3D(liftResults);
  window.__geogridResults = liftResults; // exposed for CSV export
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

/** Re-express an extents polygon in the same local frame: origin at the face's start, x along the face, y into the fill. */
function localFootprint(cutPlan) {
  const origin = cutPlan.face.edges[0].from;
  const dir = cutPlan.face.dir;
  const perp = inwardNormal(dir);
  return cutPlan.poly.map((p) => {
    const rx = p.x - origin.x, ry = p.y - origin.y;
    return { x: rx * dir.x + ry * dir.y, y: rx * perp.x + ry * perp.y };
  });
}

function renderSummary(results, rollLength) {
  const totalStrips = results.reduce((s, r) => s + r.n, 0);
  const totalArea = results.reduce((s, r) => s + r.area, 0);
  const totalTheoreticalArea = results.reduce((s, r) => s + r.theoreticalArea, 0);
  const overlapWasteArea = totalArea - totalTheoreticalArea;
  const overlapWastePct = totalTheoreticalArea > 0 ? (overlapWasteArea / totalTheoreticalArea) * 100 : 0;

  document.getElementById("statLifts").textContent = fmt.int(results.length);
  document.getElementById("statStrips").textContent = fmt.int(totalStrips);
  document.getElementById("statArea").innerHTML = `${fmt.m(totalArea)}<small> m²</small>`;

  const wasteOverlapEl = document.getElementById("wasteOverlap");
  if (totalTheoreticalArea > 0) {
    wasteOverlapEl.textContent = `${fmt.m(overlapWasteArea)} m² (${fmt.pct(overlapWastePct)})`;
    wasteOverlapEl.className = `waste-row__pct level-${wasteLevel(overlapWastePct)}`;
  } else {
    wasteOverlapEl.textContent = "—";
    wasteOverlapEl.className = "waste-row__pct";
  }

  // Every individual strip length across the whole project, flattened for bin-packing and for the breakdown table.
  const allLengths = results.flatMap((r) => r.stripLengths);

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

  const packed = packRolls(allLengths, rollLength);
  document.getElementById("statRolls").textContent = fmt.int(packed.rolls);

  const offcutWaste = packed.offcut;
  const offcutWastePct = packed.purchased > 0 ? (offcutWaste / packed.purchased) * 100 : 0;
  const wasteOffcutEl = document.getElementById("wasteOffcut");
  if (packed.purchased > 0) {
    wasteOffcutEl.textContent = `${fmt.m(offcutWaste)} m (${fmt.pct(offcutWastePct)})`;
    wasteOffcutEl.className = `waste-row__pct level-${wasteLevel(offcutWastePct)}`;
  } else {
    wasteOffcutEl.textContent = "—";
    wasteOffcutEl.className = "waste-row__pct";
  }
}

/* ============================================================
   Installation sequence view
   ============================================================ */

const tabTakeoff = document.getElementById("tabTakeoff");
const tabSequence = document.getElementById("tabSequence");
const tabCutPlan = document.getElementById("tabCutPlan");
const tab3D = document.getElementById("tab3D");
const takeoffView = document.getElementById("takeoffView");
const sequenceView = document.getElementById("sequenceView");
const cutPlanView = document.getElementById("cutPlanView");
const view3DPanel = document.getElementById("view3DPanel");
const staggerToggle = document.getElementById("staggerToggle");
const sequenceList = document.getElementById("sequenceList");
const cutPlanList = document.getElementById("cutPlanList");
const cutPlanEmpty = document.getElementById("cutPlanEmpty");

tabTakeoff.addEventListener("click", () => switchTab("takeoff"));
tabSequence.addEventListener("click", () => switchTab("sequence"));
tabCutPlan.addEventListener("click", () => switchTab("cutplan"));
tab3D.addEventListener("click", () => switchTab("view3d"));
staggerToggle.addEventListener("change", computeAndRender);
document.getElementById("printSequenceBtn").addEventListener("click", () => window.print());

const TABS = {
  takeoff: { tab: tabTakeoff, view: takeoffView },
  sequence: { tab: tabSequence, view: sequenceView },
  cutplan: { tab: tabCutPlan, view: cutPlanView },
  view3d: { tab: tab3D, view: view3DPanel },
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

function renderSequence(results, w) {
  sequenceList.innerHTML = "";
  const stagger = staggerToggle.checked;

  results.forEach((r, i) => {
    const li = document.createElement("li");
    li.className = "sequence-card";

    let staggerNote = "";
    if (stagger && r.n > 1) {
      const pitch = w - r.overlap;
      const offsetMm = Math.round((pitch / 2) * 1000);
      staggerNote =
        i % 2 === 1
          ? `<div class="sequence-card__stagger">Offset the first strip ${offsetMm.toLocaleString()} mm in from the left edge (not flush) to stagger lap joints from the lift below.</div>`
          : i > 0
          ? `<div class="sequence-card__stagger">Start the first strip flush with the left edge.</div>`
          : "";
    }

    const next = results[i + 1];
    const fillTarget = next ? `RL ${next.rl || "the next lift"}` : "final design surface";
    const embedText =
      r.mode === "extents"
        ? `cut individually per the Cut Plan tab (${fmt.m(Math.min(...r.stripLengths))}–${fmt.m(Math.max(...r.stripLengths))} m)`
        : `embedded ${fmt.m(r.embed)} m back into the fill`;

    li.innerHTML = `
      <div class="sequence-card__head">
        <span class="sequence-card__order">${i + 1}</span>
        <span class="sequence-card__rl">RL ${r.rl || "—"}</span>
      </div>
      <ol class="sequence-card__steps">
        <li>Roll out ${r.n} strip${r.n === 1 ? "" : "s"} across the ${fmt.m(r.L)} m face${
      r.n > 1 ? `, lapping each by ${fmt.mm(r.overlap)} mm` : ""
    }, ${embedText}.</li>
        <li>Pin/stake the grid as required, then place and compact fill up to ${fillTarget}.</li>
      </ol>
      ${staggerNote}
      <svg class="sequence-card__diagram" viewBox="0 0 480 40" preserveAspectRatio="none"></svg>
    `;

    sequenceList.appendChild(li);
    const svg = li.querySelector(".sequence-card__diagram");
    renderDiagram(svg, r.L, { n: r.n, overlap: r.overlap, materialWidth: r.materialWidth }, w, 480, 40);
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

    const hasZ = polygons.some((p) => Math.abs(p.meanZ) > 1e-6);
    if (hasZ) polygons.sort((a, b) => a.meanZ - b.meanZ);

    const rows = Array.from(tbody.querySelectorAll(".lift-row"));
    const count = Math.min(rows.length, polygons.length);
    for (let i = 0; i < count; i++) applyExtents(rows[i], polygons[i].points);

    statusEl.textContent = `Matched ${count} of ${polygons.length} extents to ${rows.length} lift${rows.length === 1 ? "" : "s"}${
      hasZ ? " (sorted by elevation)" : " (file order — verify against RL order)"
    }.`;
    statusEl.className = "cutplan-status is-ok";
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
    const statusEl = document.getElementById("dxfMeshStatus");
    if (!file) return;

    try {
      const text = await file.text();
      const triangles = parseFn(text);
      if (!triangles.length) {
        statusEl.textContent = noTrianglesMessage;
        statusEl.className = "cutplan-status is-error";
        return;
      }

      const tol = (parseFloat(document.getElementById("meshTolerance").value) || 0) / 1000;
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

wireMeshUpload("dxfMeshInput", parseDXF3DFaces, "No 3DFACE triangles found in that file.");
wireMeshUpload("landxmlMeshInput", parseLandXMLSurface, "No TIN surface (Pnts/Faces) found in that LandXML file.");

cutPlanList.addEventListener("click", (e) => {
  const btn = e.target.closest(".cutplan-card__swap");
  if (!btn) return;
  const row = window.__geogridRowsById.get(btn.dataset.rowId);
  if (!row) return;
  row._extentsSwapped = !row._extentsSwapped;
  computeAndRender();
});

function renderCutPlan(results, w) {
  const extentsResults = results.filter((r) => r.mode === "extents" && r.cutPlan);
  cutPlanEmpty.hidden = extentsResults.length > 0;
  cutPlanList.innerHTML = "";
  window.__geogridRowsById = window.__geogridRowsById || new Map();

  extentsResults.forEach((r) => {
    const id = `row-${Math.random().toString(36).slice(2)}`;
    window.__geogridRowsById.set(id, r.row);

    const card = document.createElement("div");
    card.className = "cutplan-card";

    const trimCount = r.stripLengths.filter((len) => len < Math.max(...r.stripLengths) - 0.01).length;

    card.innerHTML = `
      <div class="cutplan-card__head">
        <span class="cutplan-card__rl">RL ${r.rl || "—"}</span>
        <span class="cutplan-card__meta">${r.n} strips · face ${fmt.m(r.L)} m · ${trimCount} need trimming</span>
        <button type="button" class="btn btn--ghost cutplan-card__swap" data-row-id="${id}">Swap face/back</button>
      </div>
      <div class="cutplan-card__body">
        <svg class="cutplan-card__plan" viewBox="0 0 400 260" preserveAspectRatio="xMidYMid meet"></svg>
        <ol class="cutplan-card__strips"></ol>
      </div>
    `;
    cutPlanList.appendChild(card);

    const stripsList = card.querySelector(".cutplan-card__strips");
    const maxLen = Math.max(...r.stripLengths);
    r.stripLengths.forEach((len, i) => {
      const li = document.createElement("li");
      const isTrim = len < maxLen - 0.01;
      if (isTrim) li.classList.add("is-trim");
      li.innerHTML = `<span>Strip ${i + 1}</span><span>${isTrim ? `cut to ${fmt.m(len)} m` : `${fmt.m(len)} m`}</span>`;
      stripsList.appendChild(li);
    });

    renderCutPlanSvg(card.querySelector(".cutplan-card__plan"), r.cutPlan, w);
  });
}

function renderCutPlanSvg(svg, cutPlan, w) {
  const ns = "http://www.w3.org/2000/svg";
  const { poly, face, cutLengths } = cutPlan;
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const W = 400, H = 260, pad = 16;
  const scale = Math.min((W - pad * 2) / Math.max(maxX - minX, 1e-6), (H - pad * 2) / Math.max(maxY - minY, 1e-6));
  const tx = (x) => pad + (x - minX) * scale;
  const ty = (y) => H - pad - (y - minY) * scale; // flip Y so "up" on screen matches larger Y

  const poly2d = poly.map((p) => `${tx(p.x).toFixed(1)},${ty(p.y).toFixed(1)}`).join(" ");
  const polyEl = document.createElementNS(ns, "polygon");
  polyEl.setAttribute("points", poly2d);
  polyEl.setAttribute("fill", "var(--accent-tint)");
  polyEl.setAttribute("stroke", "var(--line-strong)");
  polyEl.setAttribute("stroke-width", "1.5");
  svg.innerHTML = "";
  svg.appendChild(polyEl);

  const pitch = cutLengths.length > 1 ? w - cutPlan.overlap : 0;
  cutLengths.forEach((len, i) => {
    const station = Math.max(0, Math.min(face.length, i * pitch + w / 2));
    const pt = pointAtStation(face, station);
    const n = inwardNormal(pt.tangent);
    const x1 = tx(pt.x), y1 = ty(pt.y);
    const x2 = tx(pt.x + n.x * len), y2 = ty(pt.y + n.y * len);
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", x1.toFixed(1));
    line.setAttribute("y1", y1.toFixed(1));
    line.setAttribute("x2", x2.toFixed(1));
    line.setAttribute("y2", y2.toFixed(1));
    line.setAttribute("stroke", "var(--accent-strong)");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-linecap", "round");
    svg.appendChild(line);
  });
}

/* ============================================================
   3D view — hand-rolled axonometric projection on canvas,
   no libraries. Each lift's footprint is drawn as a flat plane
   at its RL, stacked and rotatable.
   ============================================================ */

const view3DCanvas = document.getElementById("view3DCanvas");
const view3DEmpty = document.getElementById("view3DEmpty");
const view3DState = { yaw: -0.6, pitch: 0.5, zoom: 1, panX: 0, panY: 0 };

function project3D(x, y, z, yaw, pitch) {
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
  const x1 = x * cosY - y * sinY;
  const y1 = x * sinY + y * cosY;
  const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
  const y2 = y1 * cosP - z * sinP;
  const z2 = y1 * sinP + z * cosP;
  return { sx: x1, sy: -z2, depth: y2 };
}

function render3D(results) {
  if (!view3DCanvas) return;
  const ctx = view3DCanvas.getContext("2d");
  const W = view3DCanvas.width, H = view3DCanvas.height;
  ctx.clearRect(0, 0, W, H);

  const lifts = results
    .filter((r) => r.footprint && r.footprint.length >= 3 && Number.isFinite(parseFloat(r.rl)))
    .map((r) => ({ rl: parseFloat(r.rl), rlLabel: r.rl, footprint: r.footprint }))
    .sort((a, b) => a.rl - b.rl);

  view3DEmpty.hidden = lifts.length > 0;
  if (!lifts.length) return;

  const baseRL = lifts[0].rl;
  const { yaw, pitch, zoom, panX, panY } = view3DState;

  let minSX = Infinity, maxSX = -Infinity, minSY = Infinity, maxSY = -Infinity;
  const projectedLifts = lifts.map((lift) => {
    const z = lift.rl - baseRL;
    const pts = lift.footprint.map((p) => project3D(p.x, p.y, z, yaw, pitch));
    pts.forEach((p) => {
      minSX = Math.min(minSX, p.sx);
      maxSX = Math.max(maxSX, p.sx);
      minSY = Math.min(minSY, p.sy);
      maxSY = Math.max(maxSY, p.sy);
    });
    const depth = pts.reduce((s, p) => s + p.depth, 0) / pts.length;
    return { ...lift, pts, depth };
  });

  const boxW = Math.max(maxSX - minSX, 1e-6);
  const boxH = Math.max(maxSY - minSY, 1e-6);
  const pad = 90;
  const fitScale = Math.min((W - pad * 2) / boxW, (H - pad * 2) / boxH);
  const scale = fitScale * zoom;
  const cx = W / 2 + panX, cy = H / 2 + panY;
  const midSX = (minSX + maxSX) / 2, midSY = (minSY + maxSY) / 2;
  const toScreen = (p) => ({ x: cx + (p.sx - midSX) * scale, y: cy + (p.sy - midSY) * scale });

  projectedLifts.sort((a, b) => a.depth - b.depth);

  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue("--accent").trim();
  const accentTint = style.getPropertyValue("--accent-tint").trim();
  const ink = style.getPropertyValue("--ink").trim();
  const inkMuted = style.getPropertyValue("--ink-muted").trim();

  ctx.font = "11px " + (style.getPropertyValue("--font-mono").trim() || "monospace");
  ctx.textBaseline = "middle";

  projectedLifts.forEach((lift) => {
    const screenPts = lift.pts.map(toScreen);
    ctx.beginPath();
    screenPts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = accentTint;
    ctx.globalAlpha = 0.82;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.1;
    ctx.stroke();

    const labelPt = screenPts[0];
    ctx.fillStyle = ink;
    ctx.textAlign = labelPt.x < cx ? "right" : "left";
    ctx.fillText(`RL ${lift.rlLabel}`, labelPt.x + (labelPt.x < cx ? -6 : 6), labelPt.y);
  });

  ctx.fillStyle = inkMuted;
  ctx.textAlign = "left";
  ctx.font = "10px " + (style.getPropertyValue("--font-mono").trim() || "monospace");
  ctx.fillText(`${lifts.length} lifts · RL ${lifts[0].rlLabel} → ${lifts[lifts.length - 1].rlLabel}`, 12, H - 14);
}

(function wire3DInteraction() {
  if (!view3DCanvas) return;
  let dragging = false, lastX = 0, lastY = 0;

  view3DCanvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    view3DCanvas.setPointerCapture(e.pointerId);
  });
  view3DCanvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    view3DState.yaw += dx * 0.008;
    view3DState.pitch = Math.max(0.05, Math.min(1.5, view3DState.pitch + dy * 0.006));
    render3D(window.__geogridResults || []);
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((evt) =>
    view3DCanvas.addEventListener(evt, () => (dragging = false))
  );
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
    render3D(window.__geogridResults || []);
  });
})();

/* ============================================================
   CSV export
   ============================================================ */

document.getElementById("exportBtn").addEventListener("click", () => {
  const results = window.__geogridResults || [];
  const { w, oMin, rollLength } = readSettings();
  const project = document.getElementById("projectName").value || "geogrid-takeoff";

  const lines = [
    `Project,${csvEscape(project)}`,
    `Roll width (m),${w}`,
    `Minimum overlap (mm),${Math.round(oMin * 1000)}`,
    `Roll length (m),${rollLength}`,
    "",
    "RL,Face length (m),Embedment (m),Strips,Overlap (mm),Material width (m),Area (m2),Theoretical area (m2),Source",
  ];
  results.forEach((r) => {
    lines.push(
      [
        csvEscape(r.rl),
        r.L.toFixed(3),
        r.mode === "extents" ? "variable" : r.embed.toFixed(3),
        r.n,
        Math.round(r.overlap * 1000),
        r.materialWidth.toFixed(3),
        r.area.toFixed(3),
        r.theoreticalArea.toFixed(3),
        r.mode === "extents" ? "DXF extents" : "manual",
      ].join(",")
    );
  });

  const extentsResults = results.filter((r) => r.mode === "extents");
  if (extentsResults.length) {
    lines.push("", "Cut schedule (DXF extents lifts)", "RL,Strip #,Cut length (m)");
    extentsResults.forEach((r) => {
      r.stripLengths.forEach((len, i) => {
        lines.push([csvEscape(r.rl), i + 1, len.toFixed(3)].join(","));
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

/* ============================================================
   Boot — seed with the 23-lift run already discussed
   ============================================================ */
(function boot() {
  const start = 49.7, spacing = 0.6, count = 23;
  for (let i = 0; i < count; i++) {
    addLiftRow((start + i * spacing).toFixed(2), "", "");
  }
  computeAndRender();
})();
