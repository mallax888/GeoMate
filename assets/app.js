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

function addLiftRow(rl = "", faceLength = "", embed = "") {
  const frag = rowTemplate.content.cloneNode(true);
  const row = frag.querySelector(".lift-row");
  row.querySelector(".rl-input").value = rl;
  row.querySelector(".face-length").value = faceLength;
  row.querySelector(".embed-length").value = embed;
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

  tbody.appendChild(frag);
  return row;
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
    const L =
      mode === "coords"
        ? parseCoordsLength(row.querySelector(".face-coords").value)
        : parseFloat(row.querySelector(".face-length").value) || 0;
    const embed = parseFloat(row.querySelector(".embed-length").value) || 0;

    const strips = row.querySelector(".strip-count");
    const overlapCell = row.querySelector(".overlap-value");
    const areaCell = row.querySelector(".area-value");
    const diagram = row.querySelector(".strip-diagram");

    const result = oMin < w ? calcLift(L, w, oMin) : null;

    if (!result || L <= 0 || embed <= 0) {
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
    const area = result.materialWidth * embed;
    areaCell.textContent = fmt.m(area);
    renderDiagram(diagram, L, result, w);

    liftResults.push({
      rl,
      L,
      embed,
      n: result.n,
      overlap: result.overlap,
      materialWidth: result.materialWidth,
      area,
      theoreticalArea: L * embed,
    });
  });

  renderSummary(liftResults, rollLength);
  renderSequence(liftResults, w);
  window.__geogridResults = liftResults; // exposed for CSV export
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

  // Group strips by embedment length (rounded to mm) to pool roll cutting.
  const groups = new Map();
  results.forEach((r) => {
    const key = Math.round(r.embed * 1000);
    if (!groups.has(key)) groups.set(key, { embed: r.embed, strips: 0 });
    groups.get(key).strips += r.n;
  });

  let totalRolls = 0;
  let totalPurchased = 0;
  let totalUsed = 0;
  const rollTableBody = document.getElementById("rollTableBody");
  rollTableBody.innerHTML = "";

  const groupRows = Array.from(groups.values()).sort((a, b) => a.embed - b.embed);
  groupRows.forEach((g) => {
    let rolls, purchased;
    if (rollLength <= 0) {
      rolls = 0;
      purchased = 0;
    } else if (g.embed <= rollLength) {
      const stripsPerRoll = Math.max(1, Math.floor(rollLength / g.embed));
      rolls = Math.ceil(g.strips / stripsPerRoll);
      purchased = rolls * rollLength;
    } else {
      const rollsPerStrip = Math.ceil(g.embed / rollLength);
      rolls = g.strips * rollsPerStrip;
      purchased = rolls * rollLength;
    }
    const used = g.strips * g.embed;
    totalRolls += rolls;
    totalPurchased += purchased;
    totalUsed += used;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmt.m(g.embed)} m</td>
      <td>${fmt.int(g.strips)}</td>
      <td>${fmt.int(rolls)}</td>
      <td>${fmt.m(purchased - used)} m</td>
    `;
    rollTableBody.appendChild(tr);
  });

  document.getElementById("statRolls").textContent = fmt.int(totalRolls);

  const offcutWaste = totalPurchased - totalUsed;
  const offcutWastePct = totalPurchased > 0 ? (offcutWaste / totalPurchased) * 100 : 0;
  const wasteOffcutEl = document.getElementById("wasteOffcut");
  if (totalPurchased > 0) {
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
const takeoffView = document.getElementById("takeoffView");
const sequenceView = document.getElementById("sequenceView");
const staggerToggle = document.getElementById("staggerToggle");
const sequenceList = document.getElementById("sequenceList");

tabTakeoff.addEventListener("click", () => switchTab("takeoff"));
tabSequence.addEventListener("click", () => switchTab("sequence"));
staggerToggle.addEventListener("change", computeAndRender);
document.getElementById("printSequenceBtn").addEventListener("click", () => window.print());

function switchTab(which) {
  const onSequence = which === "sequence";
  takeoffView.hidden = onSequence;
  sequenceView.hidden = !onSequence;
  tabTakeoff.classList.toggle("is-active", !onSequence);
  tabTakeoff.setAttribute("aria-selected", String(!onSequence));
  tabSequence.classList.toggle("is-active", onSequence);
  tabSequence.setAttribute("aria-selected", String(onSequence));
  document.getElementById("addLiftBtn").hidden = onSequence;
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

    li.innerHTML = `
      <div class="sequence-card__head">
        <span class="sequence-card__order">${i + 1}</span>
        <span class="sequence-card__rl">RL ${r.rl || "—"}</span>
      </div>
      <ol class="sequence-card__steps">
        <li>Roll out ${r.n} strip${r.n === 1 ? "" : "s"} across the ${fmt.m(r.L)} m face${
      r.n > 1 ? `, lapping each by ${fmt.mm(r.overlap)} mm` : ""
    }, embedded ${fmt.m(r.embed)} m back into the fill.</li>
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
    "RL,Face length (m),Embedment (m),Strips,Overlap (mm),Material width (m),Area (m2),Theoretical area (m2)",
  ];
  results.forEach((r) => {
    lines.push(
      [
        csvEscape(r.rl),
        r.L.toFixed(3),
        r.embed.toFixed(3),
        r.n,
        Math.round(r.overlap * 1000),
        r.materialWidth.toFixed(3),
        r.area.toFixed(3),
        r.theoreticalArea.toFixed(3),
      ].join(",")
    );
  });

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
