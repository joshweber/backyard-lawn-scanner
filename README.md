# Backyard Lawn Scanner

A web app that uses WebXR AR (Android Chrome + ARCore) to scan the outline of a lawn, correct it against tape measurements, and export an AutoCAD `.dxf` at real scale.

## Deploy (GitHub Pages)

AR only works over **HTTPS**, so host it:

1. Create a GitHub repo and push this folder to it.
2. Repo **Settings > Pages > Deploy from a branch > main / root**.
3. Open `https://<you>.github.io/<repo>/` in **Chrome on your Android phone**.

There is no build step. Three.js loads from a CDN (unpkg), so the phone needs internet the first time.

To try the plan view and DXF export on a PC: `npm run serve` (needs Node) and open http://localhost:8080. AR itself will be disabled there.

## Scanning an 11 m x 6 m lawn

1. Tap **Scan with AR**. Move the phone slowly over the grass until the green ring appears.
2. Layer `Lawn boundary` is selected by default. Stand at a start corner and tap **Add Point**.
3. Straight edges: walk to the next corner and tap **Add Point**.
4. Curved edges: tap **Trace: ON** and walk slowly along the curve (a point is dropped every 30 cm and later simplified). Turn it off for straight sections. Tap **Add Point** at corners.
5. Walk back to the start and **aim the ring at the first point**, then tap **Finish**. The gap between where you ended and where you started (the closure error) is spread around the loop.
6. Change the layer drop-down to add obstacles, trees (tap the centre, then the edge), the water source (tap), or hardscape lines. Tap **Done** when finished.

Tips: good light, walk slowly, avoid pointing at plain, featureless surfaces, and keep the scan to one session. Don't let the phone lose tracking (the app will say "Searching for ground").

## Tape correction

1. Tap **Tape reference**, then tap two points in the plan (e.g. both ends of the 11 m edge).
2. Enter the tape-measured distance (`11.02`, `1102 cm`, `36 ft` all work).
3. The whole drawing is rescaled. Add more references (e.g. a diagonal) and the scale becomes a least-squares best fit. Each reference shows how many mm it is still off, which helps spot a bad measurement or a skewed scan.

A single reference corrects overall scale only. It cannot fix a skewed shape: measure a diagonal too, and if it is still off, drag points in the plan view to fix it, or re-scan.

## Export

Choose metres or millimetres and **Download DXF**. The file is AutoCAD R2000 ASCII with `$INSUNITS` set, one layer per feature type:

| Layer | Contents |
|---|---|
| `LAWN_BOUNDARY` | closed polyline |
| `OBSTACLES` | closed polylines |
| `TREES` | circles |
| `WATER_SOURCE` | point plus a 0.2 m ring |
| `HARDSCAPE` | open polylines |
| `EDGE_LENGTHS` | optional text labels |

Curves are exported as dense polylines (`PEDIT` > Spline/Fit in AutoCAD if you want them smooth). Orientation is arbitrary: X/Y follow the direction your phone faced at the start of the AR session, so use `ROTATE`/`ALIGN` in AutoCAD.

**Save project** / **Load project** keep a JSON copy. The project is also autosaved in the phone browser.

## Tests

`npm test` runs the Node tests for geometry, loop closure, scaling and the DXF writer. AR capture can only be tested on a phone.

## Limitations

- Android Chrome with ARCore only (no iPhone). AR drift is typically 1-3% of distance walked, so use tape references.
- The AR code is untested on a device in this repo: do a trial scan on a patio or other known rectangle first.
