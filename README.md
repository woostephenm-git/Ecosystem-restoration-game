# Ecosystem Restoration Game

An isometric ecosystem restoration game about diagnosis: symptoms appear in one layer while the cause lives in another. This repo holds the vertical slice, **Mission 1: Clearwater Pond**, built from `restoration-game-design.md` (the design doc that is the source of truth).

## Run it

```bash
npm install
npm run dev        # play at http://localhost:5173 (add ?seed=123 for a fixed seed)
                   # the dev server starts with a $100,000 testing budget; ?budget=8000 plays the real one
npm test           # unit and scripted mission tests (about a minute)
npm run sim -- solution   # headless run of a scripted plan: pond means every 90 days, then a map of plant cover
npm run gen-map    # re-bake the map and terrain from the terrain generator
npm run profile    # time one simulated year
```

Scenarios for `npm run sim`: `nothing`, `plant`, `removal`, `solution`, `solution_noplant`, `solution1`, `solution3`, `solution_deep`, `full`. Add a seed after the scenario name, e.g. `npm run sim -- solution 2`. Red-herring scenarios: `herrings`, `herrings_planted`, `solution3_weir`.

## Layout

```
data/                 all variables, links, methods, interventions, missions (JSON, human-editable)
  missions/ maps/ bc/ mission definitions, tile maps, boundary conditions
  terrain/            fine heightfield for the 3D map (the sim never reads it)
src/sim/              headless simulation core: no DOM, no rendering
  schema.ts           zod schemas for every data file
  loader.ts           validation and cross-reference checks
  functions.ts        link function library (linear, saturating, threshold, exponential_decay, product)
  engine.ts           variable graph, multi-rate updates with substeps, interventions, map pass
  grid.ts             map geometry: neighbours, steady water flow, land runoff (D8)
  knowledge.ts        what the player knows: unknown / estimate (bounds) / measured
  game.ts             budget, sampling, interventions, link discovery, limiting factors, hints, outcome
src/ui/               map screen and investigation view (vanilla TypeScript, renders from Game)
  map3d/              Three.js map, ported from the Marsh Specimen Bench artifact
tests/                vitest: function library, loader, engine, grid, knowledge, outcome, Mission 1 scenarios
scripts/              map generation, tuning and profiling helpers
```

## Build plan status (design doc section 8)

1. Project skeleton: done.
2. Headless simulation core: done.
3. Clearwater sim with scripted tests: done. Tests check that planting first fails, removal without a barrier clears the water only briefly, removal + barrier without planting fails, one planted tile is not enough, removal + barrier + planting succeeds, and the system shows hysteresis.
4. Investigation view: done.
5. Map: a 12 × 12 grid of 25 m tiles from the Marsh Specimen Bench terrain, in 3D.
6. Interventions, time controls, objective, win and lose: done.
7. Playtest and tune: first pass on the new map.

## The map

- `scripts/generate-map.ts` runs the bench's terrain formula once. It writes per-tile data (`data/maps/clearwater_pond.json`) and a fine heightfield (`data/terrain/clearwater_pond.json`). Both are ordinary data and can be hand-edited afterwards.
- A tile is water if its mean depth is over 0.1 m, or if a channel runs through it. Channels are narrower than a 25 m tile, so this keeps the inlet connected to the pond.
- **Clearwater Pond** is 35 tiles (about 2.2 ha, up to 1.5 m deep), from the west inlet (A5) to the east outlet (L8). A small hollow pond and all the land are scenery in Mission 1. You can inspect them (elevation, land cover, where runoff drains), but they are not simulated.
- The 3D view draws only observable state and knowledge: water colour from visible clarity, submerged plants from visible cover, ripples and mud plumes as a rough fish cue, and fish once surveyed. Reeds, lilies, grass and trees are scenery placed by depth band, kept off simulated pond tiles.
- Controls:
  - Click a tile to select it; click it again (or double-click, or press Enter) to investigate.
  - Shift-click or Shift-drag adds pond tiles to the planting selection.
  - Arrow keys move between tiles.
  - Drag to rotate, scroll to zoom. **Reset view** returns to the opening camera.
- **Graphics** switches to a low-quality mode (no shadows, half the plants). It turns on by itself if frames average over 45 ms.

## Decisions taken on open questions

These were marked Open or Proposed in the design doc, or decided in review. Each is easy to change.

- **Engine:** TypeScript + Vite in the browser, chosen over Godot 4. The sim core has no browser dependencies and could be ported.
- **Failure state:** the objective is scored at the deadline from the true state, then the player can keep running the pond as a sandbox.
- **Objective:** mean submerged plant cover over all of the pond's tiles, target 30% by the end of year 3.
- **Budget:** one shared $8,000 for sampling and interventions. The dev server overrides it with $100,000 for testing (`TESTING_BUDGET` in `src/ui/main.ts`).
- **Grid scale:** 25 m tiles on a 12 × 12 grid.
- **Water flow:** steady potential flow through the pond (ported from the bench), at tile resolution. Flow spreads across the basin and favours deep water rather than following one path. Face flows conserve water exactly. The map's surface animation uses the same solver on a finer grid.
- **Rates that scale with tile size:** mixing, carp movement and plant spread are diffusivities in m²/day, divided by tile area. Changing the tile size keeps them physical.
- **Integration:** daily stocks take as many substeps as the fastest exchange needs, so rate × step stays under 0.8. Spin-up runs once per mission with a fixed seed and is cached; the player's seed drives everything after it.
- **Lateral processes:** the map pass writes `lateral` variables (water exchange, incoming concentrations, carp arriving and leaving, plant fragments arriving), which ordinary links read. Each one is a weighted sum of other tiles' values and boundary values, so the knowledge model can work out what is known about it.
- **Carp wakes:** carp are a coarse observable. Bow wakes and trails of stirred-up mud give none / some / many (0–40, 40–150, 150–1000 kg/ha) for free, which makes carp a LIKELY limiting factor from the start; a survey gives the number.
- **Sampling costs:** per-tile methods are cheap because a 35-tile pond needs sampling in many places (Secchi $15, water grab $80, oxygen profile $120, sediment core $300). Whole-pond methods keep their price (fish survey $1,200, inflow fish trap $300).
- **Red herrings:** four plausible interventions that do not fix this pond: barley straw, algaecide, an upstream nitrate agreement, and raising the outlet weir (which backfires by cutting light at the bed). Each carries a `design_note` for instructors that players never see.
- **Scopes:** planting is per tile ($300 each, and the whole selection at once on the map). Carp removal, the barrier and alum act on the whole pond. Fish surveys and the inflow fish trap cover the whole water body. Other sampling covers one tile.
- **Seed bank:** nearly depleted, so restoring clarity without planting fails.
- **Scales:** every variable has a typical range (`scale` in `data/variables.json`), with an optional reference mark. Gauges show low, mid or high by thirds of that range.
- **Measurement staleness:** visual observations update daily. Coarse-visible variables fall back to a visual estimate 30 days after a measurement. Lab-only variables keep their last measurement and are tagged with their age.
- **Themes:** light on the map, ochre in the investigation view.

## Model notes

- Light: `Kd = 1.7 / Secchi` (Poole-Atkins); light at the bed = `exp(-Kd × depth)`.
- Turbid state: carp around 465 kg/ha (most at the inlet), suspended sediment around 50 mg/L, Secchi around 0.45 m. The shallow margins still get light, but carp uproot whatever grows.
- Restored state: Secchi around 2.5–3 m. Plant cover by the deadline depends on how many tiles were planted: one tile reaches about 6%, three about 41%, six about 58%.
- Feedback loops that create the two stable states: plants trap sediment and suppress carp spawning; bare sediment plus carp keeps the water dark; low oxygen releases legacy phosphorus, which feeds algae, which use up more oxygen.

## Known rough edges

- The water-flow overlay is drawn with 1-pixel WebGL lines and is faint.
- The bundle is about 850 KB (230 KB gzipped), mostly Three.js and the terrain.
