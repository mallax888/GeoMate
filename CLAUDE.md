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
   A lift with corners in its face is no different: `calcLift` over the WHOLE
   face, so both ends land flush on the real ends of the wall. A floor that
   falls through to the boundary layout keeps **minimum pitch** there — do not
   let it inherit the wall's even spread, which would squeeze every seam
   tighter to land on a line nothing needs to match.
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
6. **Nothing is planned that covers no ground.** Two pieces used to reach the
   schedule carrying nothing: a strip starting at or past the end of its own
   corner segment (entirely outside the extents, its cut length falling back to
   the 2 m practical minimum), and a strip every square metre of which was
   already under its neighbours. Both are now dropped after the layout is
   built, on measurement (`stripLapShare`, `stripCoversNothing`), never on a
   guess. A strip still holding any ground of its own stays, however much of it
   laps — that is what ties the face in.
7. **No gaps. "All strips need to be back to back at least."** Two rules
   deliver this on a wall, and both are measured, not assumed:
   - A **corner segment spreads its strips evenly** across its own length
     (`segPitch`), landing flush at both ends. Minimum pitch plus a floored
     strip count left the segment short of its corner and slid the last strip
     up to close it, which only moved the shortfall inland and opened it as a
     gap between that strip and the one before — 2.6 m² of bare ground per
     segment. Even spreading only ever *adds* overlap beyond the product
     minimum, so it is always safe to lay.
   - A **sweep over what is actually bare**, at the end of `computeCutPlan`.
     Each pass grids the lift, takes the biggest patch no strip covers, and
     lays one full roll width over as much of it as a single piece can reach,
     square to whichever segment's bearing takes most of it, cut from where its
     band enters the lift out to the far end of the hole. A piece that takes
     nothing ends the sweep. Written as a sweep rather than a rule about
     corners because the same hole appears at a bend, at a raking end, and
     either side of a short segment. **Floors are excluded** (rule 5).

     It reaches **every** wall lift, including one whose face is a single
     straight run. Those used to return early from `computeCutPlan` and skip
     this rule, rule 6 and the end overrides with it. Only the opt-in "force
     every strip the same length from one side" keeps its own path, because its
     strips can be different WIDTHS and nothing else here is. In practice the
     sweep finds nothing to do on a straight face — a strip square to it reaches
     the boundary at every station by construction, and a pocket past a gap is
     already a stitch patch — but the rule is now enforced there rather than
     assumed. Measured: with the threshold dropped to 0.1 m² not one straight
     lift on RE580 produced a piece, and a shape whose extents rake past the end
     of a straight face came out fully covered.

   Two rectangles at different bearings, both flush to a face that bends,
   cannot also be flush to each other: the options are doubling up, a gap, or a
   piece across the join. This is the third. Expect ~20% more grid than lift
   area on a bendy wall — that is the lap, and it is the price of no gaps.
8. **Don't open the app on every control at once.** The left column is not one
   panel of settings, it is six separate tools (layout options, generate lifts,
   paste data, intermediate grids, import lengths, projects) plus the
   methodology note. Each is a `<details class="tool">`, shut by default: the
   summaries still name everything the column offers, and every control is one
   click away. The material schedule is a RESULTS panel — it carries
   `.is-empty` until there is something to total, which hides the tiles and
   shows one line instead of eight zeros. Measured: first load went from 2168 px
   and 306 words to 1005 px and 175, with the settings column 1570 px → 411.
   A test that drives a control in that column has to open its section first.
9. **Offer the way in where people are.** Loading extents from CAD is how this
   app is used, but the only door was a button inside the **Cut plan** tab —
   named after an OUTPUT, so nobody looks for a file upload behind it — while
   the opening screen listed generate / paste / add-by-hand and never mentioned
   DXF. The empty state now leads with it, and a second button sits beside
   "+ Add lift" so it is reachable from any tab (hidden on Cut plan, which has
   its own). Both call `startExtentsUpload`, which **switches to Cut plan first**
   and then opens the picker: the wall/floor question and the upload's status
   line live in that view, and asking "wall or floor" somewhere the user cannot
   see it is how a floor silently gets a wall layout. Note for tests: the empty
   state and the Cut plan block share the label "Upload extents DXF", so scope
   the selector (`#cutPlanView >> text=...`).
10. **A control that cannot act must not be shown.** The Face picker and the
   end-strip overrides only mean something to the boundary layout, so they are
   left out of the card on a centreline plan; the wedges left on the outside
   of a bend are not patched, because a rectangle covering one lies on ground
   the strips either side already reach.

## Architecture map (`assets/app.js`, ~6400 lines, no modules)

Geometry / cut planning — the part that is subtle:

- `stripCovers(frame, x, y)` — is this point under this strip. **One definition on
  purpose.** Four copies of it used to sit across two planners, and they have to
  agree to the last tolerance: one measures how much of a strip laps, another
  decides where a patch piece goes. If they drift apart, the sweep lays a piece
  over ground the lap measurement already called covered.
- `dxfCodeValuePairs(text)` — a DXF as the (group code, value) pairs it is made
  of. Every parser starts here; four of them carried their own copy.
- `chainFromEdges(edges)` — a run of edges as one chain with a length-weighted
  average direction. Both grouping functions end this way; they differ in where
  they CUT the runs, never in this.
- `calcLift(L, w, oMin)` — flush-both-ends stripping, overlap spread evenly.
- `minPitchLift(L, w, oMin)` — minimum-overlap stripping, last strip overshoots.
- `chainEdges(poly, angleThresholdDeg = 20)` — splits the boundary into
  candidate faces. Uses `groupDirsByAngle`.
- `needsTrueGeometry(cutPlan)` — which diagram a plan gets. The flat one draws
  strips edge to edge at the midpoint between ARRAY-adjacent strips, which
  assumes they march along the face in order; a patch piece sits wherever the
  hole was, so a straight lift carrying one has to go to the true-geometry
  renderer or the piece is drawn as a slab across its neighbours.
- `pickFaceAndBack` / `candidateFaceChains` — choose which chain is the face.
  `faceIsUsable` gates it on two independent failures, and **both are needed**:
  - `facePlaneMinDepth` vs `SEVERE_BEHIND_FACE_TOL` — the boundary wrapping
    behind the face, where no strip can sample. Measured against the face
    **polyline**, not one averaged plane through its first vertex: a curved
    face swings behind its own averaged plane all by itself (17° of gentle bend
    over 24 m put its far end 2.9 m "behind"), which rejected the real face on
    three lifts and handed them to a 7 m chain off the end of the extents — 65%
    of the lift with no grid on it.
  - `chainBearingSpread` vs `FACE_TURN_TOL` (45°) — the chain itself turning
    through more than a face can. `chainEdges` compares each edge to the one
    before, so a steady curve never trips its 20°: a quarter-circle fillet comes
    back as one chain and on a small lift wins on length. Fixing the plane test
    alone let that through, and RE580's top two lifts came out as twenty-odd
    half-metre corner segments with strips crossing at every angle. Measured on
    both walls: real faces spread **0–22°**, wrap-around arcs **90°**.

  Do not replace one with the other. The first is about the polygon, the
  second about the chain.

  Then `wallFaceConsensus` — **the wall face is one surface and every lift
  shares it**, so the lifts vote (weighted by face length, clustered by axis)
  and a lift disagreeing with the majority is re-picked onto a candidate that
  agrees. The vote is taken in `computeAndRender` before any lift is planned,
  so it does not depend on list order; a wrong first lift used to propagate
  when the reference was just "the lift below". The comparison is **signed**,
  unlike `refDir`'s: a boundary is walked one way round, so a lift's face and
  its back run in opposite directions and an unsigned match scores both at 1.
  On RE580 four lifts of twenty-seven were laid off the wrong edge — two off
  the back, two off an end square to the wall, putting their strips along the
  face instead of into the fill. An explicit Face-picker choice bypasses all of
  this (`pickFaceByIndex`), as it must.
- `splitFaceIntoCornerSegments(face)` — splits the chosen face into segments
  the strips fan around. Uses `groupDirsByAngleFromStart` at
  `CORNER_SPLIT_ANGLE_DEG` (3°).
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
- `splitFaceIntoCornerSegments` (corner splitting, `CORNER_SPLIT_ANGLE_DEG`) uses
  `groupDirsByAngleFromStart`.

Switching face-picking over to the cumulative version **has already been tried
and was reverted**: it changed which chain won as the face on some lifts,
turning correct renders into crossing, wrong-shape ones with ~63% more
material. If you think both should use the same function, they shouldn't.

`stripDirs` is written **by index**, not pushed, so it is short and sparse
while the install loop runs. It is filled out with explicit nulls before
anything splices the per-strip arrays in step — `splice` clamps its index to
the array's own length, so on a short `stripDirs` a bearing meant for one piece
silently lands on strip 1 instead, which is a rotated strip and a hole in the
lift. Every reader is `stripDirs[i] || seg.dir`, so a null reads as no
override.

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
  `index.html`/`app.js`/`style.css`.** Currently `geomate-v152`. `activate()`
  drops every other cache, which is what clears anything an older worker left.
- **The service worker is NETWORK-FIRST for the app** (page, script,
  stylesheet) with a 3.5 s timeout falling back to the stored copy, and
  cache-first for fonts, icons and the manifest. It was stale-while-revalidate
  for everything, which answers from the cache and refreshes afterwards — so
  every update took **two** visits to appear and the first always showed the
  old app. Reproduced and fixed with a persistent browser profile: deploy a
  change, open the app in a fresh tab, old worker shows the previous build and
  the new one shows the current build; both still open with no signal. Do not
  go back to cache-first for the app itself.
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

Also measure **bare ground**: grid the lift, mark every cell no strip covers,
cluster them, and report the total and the biggest patch (`bare_levels.js` in
the scratchpad). A layout change that reads fine on the drawing can still open
a hole, and the percentage is the only thing that catches it. Nothing should be
above ~1% bare, in patches no bigger than a 0.25 m boundary sliver.

For anything touching strip orientation, measure each strip against the face
tangent **at that strip's own station** (worst deviation from 90°, across
every lift, both pack directions, wall and floor). Comparing against the
segment's averaged direction proves nothing — that is perpendicular by
construction. Exclude pieces the planner deliberately turned (`stripDirs[i]`
set, the sliver rule) and the patch pieces from rule 7 — both are laid against
a neighbour or over a hole, not set out off the face, and a turn of 20°+ on a
sub-width segment is the rule working, not a defect. Ordinary strips come out
at 0.002° on the synthetic wall; the worst case across all four real project
DXFs was 2.683°, bounded by `CORNER_SPLIT_ANGLE_DEG`. Treat a regression past
that as a defect.

That bound is a **priced trade, not a target to tighten**. At 1° a 14.6 m face
split into six segments, each starting its own run at its own bearing, so the
runs crossed at every join and the lift carried four narrow gap-filling pieces
— overlap on overlap, on the drawing and on the schedule. Measured across
RE580: 1° → 536 strips / 661.0 m / 0.835°; 3° → 520 / 656.3 / 2.61°; 5° → 510 /
655.0 / 4.74°; 8° → 504 / 651.8 / 7.92°. Material moves ~1% across that whole
range, so the tolerance buys legibility and piece count and pays in squareness.
The user priced it at 3°, and **priced it again** after seeing what it looks
like on their own wall. Re-measured on RE580 (27 lifts, once strips ran as one
count along the face), counting how often two neighbouring strips are laid more
than 5° apart and so fan into each other:

| split | strips | grid over lift | bare | worst off-square | neighbours >5° apart |
|-------|--------|----------------|------|------------------|----------------------|
| 3°    | 519    | 11.1%          | 0.17%| 2.5°             | 21 (worst 18°)       |
| 5°    | 512    | 9.5%           | 0.05%| 4.7°             | 16                   |
| 8°    | 504    | 8.1%           | 0.06%| 7.9°             | 6                    |
| 12°   | 502    | 7.7%           | 0.07%| 5.1°             | 3                    |

Material moves 3.4% across the whole range. A looser threshold buys strips that
don't fan against each other and pays in squareness to the face. Shown all four,
**the user chose to stay at 3°** — rule 1 beats a tidier drawing. Some fanning
where the surveyed face kinks is therefore EXPECTED OUTPUT, not a defect: on
RE580 the face genuinely runs 44.5° → 36.9° → 49.3° over 3 m facets, and strips
square to facets 12° apart meet somewhere in the fill. Do not "fix" it, and do
not move the threshold without putting these measurements back in front of them.

**Never ship a change that regresses a previously-working, verified case**,
even if it fixes the case in front of you. Revert and find a narrower fix.
