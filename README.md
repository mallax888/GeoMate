# Geogrid Takeoff

A browser-based calculator for planning lift-by-lift geogrid reinforced fill
installations: strip layout across each lift's face, overlap spacing, and a
project-wide roll quantity / off-cut takeoff.

Runs entirely client-side — open `index.html` directly, or serve the folder
with any static file server. No build step, no dependencies, no data leaves
the page.

```
python3 -m http.server 8000   # then open http://localhost:8000
```

## What it does

For each lift you enter a face length (or paste path coordinates for a
curved/kinked face and it computes the true arc length), an embedment
length, and the project-wide roll spec (width, minimum overlap, roll
length). For every lift it works out:

- the fewest full-width strips that still meet the minimum overlap
- the actual overlap, spread evenly across every seam (never a trimmed
  strip)
- the material area used, and how much of that is unavoidable overlap
  ("waste")

Across the whole project it then pools strips that share an embedment
length and packs them into 1×roll-length pieces, so cutting off-cut is
minimised rather than calculated per lift in isolation — then reports
total rolls to order and total off-cut waste.

Export the full lift-by-lift and roll breakdown as CSV from the summary
panel.

## Project structure

```
index.html          page structure
assets/style.css    design tokens + layout (light/dark via prefers-color-scheme)
assets/app.js       calculation logic + rendering, no framework
assets/fonts/       self-hosted IBM Plex Sans / Plex Mono (woff2)
```

## Calculation notes

Given face length `L`, roll width `w`, minimum overlap `oMin`:

```
n       = ceil((L − oMin) / (w − oMin))      strip count
overlap = (n·w − L) / (n − 1)                 evenly spread, ≥ oMin
```

Roll off-cut is computed per unique embedment length across *all* lifts
combined (`stripsPerRoll = floor(rollLength / embedment)`), not per lift,
so shared embedment lengths get packed together for the least waste.
