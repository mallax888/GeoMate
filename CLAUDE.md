# GeoMate — working notes for Claude

Read this before changing anything. It captures decisions and constraints that
are expensive to rediscover and easy to break.

## What this is

A client-side-only static PWA for geogrid/reinforced-fill installation
takeoffs on civil earthworks projects (retaining walls and floor/basal
reinforcement). No build step, no framework, no dependencies, no backend —
`index.html` + `assets/app.js` + `assets/style.css`, served as static files.
Nothing leaves the page; all state lives in `localStorage`.

The user is a site engineer using this for real motorway retaining-wall and
floor-reinforcement takeoffs. Output drives actual material orders, so
correctness of quantities matters more than elegance.

## Non-negotiable domain rules

These come from the user directly. Violating them makes output wrong on site.

1. **Strips are positioned perpendicular to the road.** This is "rule 1" and
   it overrides tidiness, material efficiency, and strip-count minimisation.
   If a fix makes the layout cheaper but the strips stop tracking the curve
   perpendicular, the fix is wrong.
2. **Strips only go inside the extents** (the white dashed boundary in the Cut
   Plan diagram). That boundary is the geogrid extent — nothing outside it.
3. **Strips are rectangular, always.** They come off a long roll and are cut
   square. Never render or model a strip as a clipped/trapezoidal/curved
   shape. Coverage against an irregular boundary is shown by drawing the
   *full rectangle* faintly plus a solid clipped overlay on top of it — the
   overlay is a visual indication of real coverage, not a different strip
   shape. See `renderCutPlanSvg`, `renderCutPlanSvgCornered`,
   `renderCutPlanSvgManual`, which all follow this pattern for both main
   strips and stitch patches.
4. **Wall vs Floor reinforcement differ at the ends.** Wall faces need both
   ends flush (`calcLift` — evenly spread extra overlap across all seams).
   Floor is laid back-to-back where ends are not critical, so it uses minimum
   pitch and lets the last strip overshoot (`minPitchLift`). Minimum overlap
   stays user-configurable in both modes because it is product-dependent.
   Corner segments (`segCount > 1`) always use minimum pitch regardless.
5. **A floor is never laid off the boundary.** The boundary layout fans the
   strips round every bend, which is the thing this app exists to avoid. A
   floor uses one of two layouts instead, both drawn in true plan orientation
   (`centrelineMode`, which is what sends a plan to `renderCutPlanSvgCornered`
   even on a single segment — the flat renderer straightens a bent corridor
   into a rectangle nobody can match against the CAD):
   - **Road centrelines loaded** (`computeCentrelineCutPlan`) — strips square
     to the nearest alignment. Ground belongs to whichever centreline is
     nearest and a road stops dead on that line, so both sides of a fork end
     square. Then strips grow into any ground no other strip covers, the piece
     whose neighbours already cover ≥45% of it is dropped, and the survivors
     grow again — alternating, because each move makes room for the other.
     What is still bare and straddles two roads gets a patch piece
     (`stripIsStitch`, drawn in the stitch colour).
   - **No centrelines** (`computeParallelCutPlan`) — one bearing for the whole
     lift, square to its longest run, so every strip is parallel to every
     other. The Face picker chooses *which* run and is labelled "Run".
   The user's standing instruction: on a floor, **extend the strips rather
   than cut extra pieces, and small bare corners are fine.** Do not trade that
   away for a coverage percentage.
6. **A control that cannot act must not be shown.** The Face picker and the
   end-strip overrides only mean something to the boundary layout, so they are
   left out of the card on a centreline plan; the wedges left on the outside
   of a bend are not patched, because a rectangle covering one lies on ground
   the strips either side already reach.

## Architecture map (`assets/app.js`, ~6400 lines, no modules)

Geometry / cut planning — the part that is subtle:

- `calcLift(L, w, oMin)` — flush-both-ends stripping, overlap spread evenly.
- `minPitchLift(L, w, oMin)` — minimum-overlap stripping, last strip overshoots.
- `chainEdges(poly, angleThresholdDeg = 20)` — splits the boundary into
  candidate faces. Uses `groupDirsByAngle`.
- `pickFaceAndBack` / `candidateFaceChains` — choose which chain is the face.
- `splitFaceIntoCornerSegments(face)` — splits the chosen face into segments
  the strips fan around. Uses `groupDirsByAngleFromStart` at
  `CORNER_SPLIT_ANGLE_DEG` (1°).
- `computeCutPlan(rawPoints, w, oMin, faceCycle, refDir, packSide, stripSide,
  avoidStitches, neighborDir, floorMode)` — the core planner.
- `computeManualCutPlan(...)` — the click-to-place manual strip builder.
- `clipPolyToConvex(subject, clip)` — Sutherland-Hodgman. Subject may be
  non-convex; **the clip polygon must be convex** (it's a strip rectangle here).
- `tessellateBulge(p0, p1, bulge)` — DXF arc/bulge → polyline.

### The two angle-grouping functions — do not merge them

`groupDirsByAngle` compares each edge to the **immediately preceding** edge.
`groupDirsByAngleFromStart` compares each edge to its **group's own first**
edge, so a smooth curve's cumulative drift can't be silently averaged away.

They are deliberately separate:

- `chainEdges` (face-picking, 20°) uses `groupDirsByAngle`.
- `splitFaceIntoCornerSegments` (corner splitting, 5°) uses
  `groupDirsByAngleFromStart`.

Switching face-picking over to the cumulative version **has already been tried
and was reverted**: it changed which chain won as the face on some lifts,
turning correct renders into crossing, wrong-shape ones with ~63% more
material. If you think both should use the same function, they shouldn't.

`mergeShortCornerSegments(segments)` uses a **fixed 0.1 m noise floor**. It
once scaled with strip width, which over-merged tight-radius curves into
coarse segments and broke rule 1 on narrower strips. Don't retie it to width,
and don't raise it: any segment under the floor is folded into a neighbour by
a merge that force-averages the combined edges (a 180° threshold that never
splits), so a coarse floor hands that merge more slivers to average away. That
is not a hypothetical — at a 1° split threshold with the floor still at 0.3 m,
one lift's merge averaged edges ~18° apart and its worst strip skew went from
2.7° to 9.3°, i.e. tightening the split threshold alone made accuracy *worse*.
The split threshold and this floor have to move together.

Other areas: DXF/LandXML parsing (`parseDXF*`, `parseLandXMLSurface`,
`sliceMeshAt`, `benchBoundaryAt`), roll packing (`packRolls*`,
`buildRollPieces`), the product manager and cross-project product library,
rendering (`renderCutPlan*`, `renderSummary`, `renderSequence`), print/CSV
export, and state persistence.

`localStorage` keys: `geogrid-autosave`, `geogrid-project-names`,
`geogrid-product-library`.

## Conventions

- **Bump `CACHE_NAME` in `sw.js` on every deploy that touches
  `index.html`/`app.js`/`style.css`.** Currently `geomate-v111`. Forgetting
  this means users keep running stale code offline.
- Product library commits happen on `focusout`, **not** `input` — committing
  on `input` created a library entry per keystroke ("Sta", "Star", "Start"…).
  Keep `input` for live UI refresh only.
- Deploy flow: push to `main`, then sync the deploy workspace with
  `git fetch origin main -q && git reset --hard origin/main -q`.

## Verifying changes to cut-plan geometry

Geometry changes here regress silently — a fix for one lift shape quietly
breaks another. The established workflow, which has caught real regressions:

1. Serve the folder (`python3 -m http.server 8931`) and drive it with
   headless Playwright (Chromium at `/opt/pw-browsers/chromium`).
2. `window.__geogridCutPlanResults` exposes every lift's computed cut plan —
   read it directly rather than scraping the DOM.
3. Dump **all** lifts × test files × both pack directions to JSON before and
   after the change and diff them. Spot-checking a few lifts is not enough.
   A correct fix should show *zero* face-length changes unless face-picking
   was intentionally touched.
4. Check label clashes via `getBBox()` overlap, and check coverage gaps by
   reconstructing strip positions from `stripLocalStarts` / `stripWidths` /
   `stripSegmentIndex`.
5. Screenshot the affected lifts and actually look at them.

Verify a bulge/arc change against **ground-truth circles**, checking centre
and side — endpoint-only matching passes for a mirrored circle.

For anything touching strip orientation, measure each strip against the face
tangent **at that strip's own station** (worst deviation from 90°, across
every lift, both pack directions, wall and floor). Comparing against the
segment's averaged direction proves nothing — that is perpendicular by
construction. The current worst case across all four real project DXFs is
0.835°, bounded by `CORNER_SPLIT_ANGLE_DEG`; treat a regression past ~1° as a
defect.

**Never ship a change that regresses a previously-working, verified case**,
even if it fixes the case in front of you. Revert and find a narrower fix.
