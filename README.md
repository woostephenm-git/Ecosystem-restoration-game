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
tests/                vitest: function library, loader, engine, grid, knowledge, outcome, debrief, Mission 1 scenarios
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
- The 3D view draws only observable state and knowledge: water colour from visible clarity, submerged plants from visible cover, and fish once surveyed. Reeds, lilies, grass and trees are scenery placed by depth band, kept off simulated pond tiles.
- Controls:
  - Click a tile to select it; click it again (or double-click, or press Enter) to investigate.
  - Shift-click or Shift-drag adds pond tiles to the planting selection.
  - Arrow keys move between tiles.
  - Drag to pan (it stops a tile beyond the map edge), Ctrl-drag (Cmd on a Mac) or right-drag to rotate, scroll to zoom. On touch screens, one finger pans and two fingers zoom and rotate. **Reset view** returns to the opening camera.
  - The "Show" drop-down sits above Reset view. Channel labels fade while the pointer is over them, so the tiles underneath stay visible.
- **Graphics** switches to a low-quality mode (no shadows, half the plants). It turns on by itself if frames average over 45 ms.

## Decisions taken on open questions

These were marked Open or Proposed in the design doc, or decided in review. Each is easy to change.

- **Engine:** TypeScript + Vite in the browser, chosen over Godot 4. The sim core has no browser dependencies and could be ported.
- **Failure state:** the objective is scored at the deadline from the true state, then the player can keep running the pond as a sandbox. After a failure, "Retry the mission" (on the result pop-up and the debrief) starts again from the briefing; a `?seed=` in the address is kept, so a seeded attempt replays the same conditions.
- **Objective:** mean submerged plant cover over all of the pond's tiles, target 30% by the end of year 3.
- **Budget:** one shared $8,000 for sampling and interventions. The dev server overrides it with $100,000 for testing (`TESTING_BUDGET` in `src/ui/main.ts`).
- **Grid scale:** 25 m tiles on a 12 × 12 grid.
- **Water flow:** steady potential flow through the pond (ported from the bench), at tile resolution. Flow spreads across the basin and favours deep water rather than following one path. Face flows conserve water exactly. The map's surface animation uses the same solver on a finer grid.
- **Rates that scale with tile size:** mixing, carp movement and plant spread are diffusivities in m²/day, divided by tile area. Changing the tile size keeps them physical.
- **Integration:** daily stocks take as many substeps as the fastest exchange needs, so rate × step stays under 0.8. Spin-up runs once per mission with a fixed seed and is cached; the player's seed drives everything after it.
- **Lateral processes:** the map pass writes `lateral` variables (water exchange, incoming concentrations, carp arriving and leaving, plant fragments arriving), which ordinary links read. Each one is a weighted sum of other tiles' values and boundary values, so the knowledge model can work out what is known about it.
- **Carp are hidden until surveyed:** nothing on the map hints at them (surface cues were tried and dropped). Murky water makes them a SUSPECTED limiting factor; a fish survey gives the number and draws the fish.
- **Sampling costs:** per-tile methods are cheap because a 35-tile pond needs sampling in many places (Secchi $15, water grab $80, oxygen profile $120, sediment core $300). Whole-pond methods: fish survey $300, inflow fish trap $300. A fish survey covers all 35 tiles, so at $300 it is the cheapest data per tile. To stop it becoming the reflex choice, a survey can only be repeated after 90 days (`rest_days` in `data/methods.json`; a permit limits how often the fish can be netted).
- **Red herrings:** four plausible interventions that do not fix this pond: barley straw, algaecide, an upstream nitrate agreement, and raising the outlet weir (which cuts light in the old pond but floods new shallows; in this mission the two roughly cancel). Each carries a `design_note` for instructors that players never see.
- **Scopes:** planting is per tile ($300 each, and the whole selection at once on the map). Carp removal, the barrier and alum act on the whole pond. Fish surveys and the inflow fish trap cover the whole water body. Other sampling covers one tile.
- **Seed bank:** nearly depleted, so restoring clarity without planting fails.
- **Scales:** every variable has a typical range (`scale` in `data/variables.json`), with an optional reference mark. Gauges show low, mid or high by thirds of that range. A shaded band always means an estimate's range; a measured value is a marker alone.
- **Measurement staleness:** visual observations update daily. Coarse-visible variables fall back to a visual estimate 30 days after a measurement. Lab-only variables keep their last measurement and are tagged with their age.
- **Themes:** light on the map and debrief, ochre in the investigation view. The top bar and mission drawer stay white everywhere.
- **Pond level and flooding:** raising the outlet weir lifts the pond surface (the `weir_rise` boundary variable). Every pond tile deepens, and land bordering the pond floods once under more than 10 cm of water. Flooded meadow joins the pond as bare, fish-free shallows with a phosphorus pulse from rewetted soil, and the flow solver is rebuilt for the new shape. Raising the weir by 30 cm floods six tiles. The 3D water surface follows the gauges.
- **Structures:** the outlet has a stone sill. Raising the weir shows scaffolding while the wall grows, then water spilling over the higher crest. The carp barrier stands across the inlet channel, with posts laid out bank to bank at the current water level, so it widens with the channel when the weir raises the pond. Both are turned to sit square across their channel's actual course (from the channel paths in the terrain data), not along the grid. Barley straw bales float on the deepest open water while that treatment runs: they bob, swing on their tethers, and turn brown and sit lower as the straw rots over its 60 days.
- **Map views:** a "Show" drop-down above Reset view picks the surface view, water flow, or a knowledge overlay.
- **Debrief:** after the deadline, the outcome screen and the top bar open a debrief. It plots the true daily values (not the player's measurements) for one pond tile or the median of all pond tiles, up to four variables at once. Each line is placed on its variable's typical range so they share one low/mid/high axis; hovering gives real values. Interventions are numbered markers with their duration shaded, listed under the chart, and the data is available as a monthly table. Time pauses while it is open.
- **Intervention order:** a fixed, hand-picked order in the mission file that alternates red herrings with the interventions that work, so the useful ones are not grouped at the top.
- **Cross-section:** the investigation view cuts each tile from its shallowest point to its deepest, read from the terrain heightfield. The shallow end goes on the side it lies towards (right if it is further east than the deep point, otherwise left, including a tie), and the ends are labelled with compass points. Maps without a heightfield take the profile from neighbouring tiles' bed elevations. Dry bank rises above the waterline; the depth scale sits at the deep end. The drawing moves: waves run along the surface (higher in stronger wind) with rings spreading now and then, particles drift and are carried along by the water flowing through the tile (fastest in the inlet and outlet channels, slowest in the side bays, still where no flow reaches; the speed is the tile's share of the inflow divided by its depth, on a square-root scale, moving towards whichever end of the cut is nearer downstream), plants and reeds sway from their roots, and surveyed carp swim back and forth through water deep enough for them. Every animation takes its start time from one shared clock, so motion carries on smoothly when the page re-renders on each sim tick. It is switched off for players who prefer reduced motion.
- **Water exchange in driver lists:** water exchange is the pathway; sediment, nutrients and algae are what it carries. In the model each inflow is one link (exchange × incoming concentration), so nothing is counted twice. The "Driven by" list now shows each of those links once, as "Incoming sediment via water exchange".
- **Applying for more funding:** a button under the interventions. It is free, takes 180 days while the pond carries on, and adds $2,000 if approved. The player places exactly two arrows between the variables they have sampled, which are scattered on the board in a fixed shuffle so their position hints at nothing: a red one from something that limits plant establishment, then a brown one from what drives that factor (for example carp → suspended sediment → plant establishment). Later applications show earlier arrows in bold green where the reviewers found support and dashed grey where they did not. The decision arrives as a pop-up that pauses time. Derived variables (Secchi depth, light at the bed, bottom oxygen) are left off the board: they are calculated straight from other variables, so arrows through them only restate a definition. With everything sampled, that leaves two valid chains in Mission 1: carp → suspended sediment and total phosphorus → algae, each into plant establishment. Water depth, legacy sediment phosphorus and nitrate stay on the board as plausible distractors. Any chain the simulation supports on this map is accepted: an arrow counts if a chain of links runs from one variable to the other, passing only through derived variables, and each link actually limits on at least one pond tile that day: a 10% change in its input moves its output by at least 1% (an elasticity of 0.1, `LIMITING_RESPONSE` in `game.ts`). Saturated links do not count. Nitrate does feed the algae, but at about 1.5 mg/L against a half-saturation of 0.1 mg/L its elasticity stays near 0.06, before and after restoration, so "nitrate → algae" is turned down with an explanation that nitrate is too plentiful to be limiting. The genuine links sit at 0.18 or more. Both arrows must be supported. A declined application still uses the 180 days and pays nothing. Applications can be repeated, one at a time, but each must show a relationship that has not been funded before.
- **Action buttons:** on the map, the interventions sit in the right-hand column beside the map, so they are visible without scrolling. On a desktop browser, sampling and intervention buttons show only their name and cost; pointing at one (or tabbing to it) shows its description and status in a box beside them. Narrow and touch screens keep descriptions inside the buttons.
- **Moving between tiles:** the investigation view has a 3 × 3 isometric picker beside the layer chips, turned like the map's opening view (north to the upper right). The centre is the open tile; pond tiles around it open on click, and land or off-map cells are shown but cannot be picked.
- **Mission drawer:** the objective, weather and inflow (the boundary conditions) and the field log slide down from a tab under the top bar, which summarises the objective while closed.

## Model notes

- Light: `Kd = 1.7 / Secchi` (Poole-Atkins); light at the bed = `exp(-Kd × depth)`.
- Turbid state: carp around 465 kg/ha (most at the inlet), suspended sediment around 50 mg/L, Secchi around 0.45 m. The shallow margins still get light, but carp uproot whatever grows.
- Restored state: Secchi around 2.5–3 m. Plant cover by the deadline depends on how many tiles were planted: one tile reaches about 6%, three about 41%, six about 58%.
- Feedback loops that create the two stable states: plants trap sediment and suppress carp spawning; bare sediment plus carp keeps the water dark; low oxygen releases legacy phosphorus, which feeds algae, which use up more oxygen.

## Known rough edges

- The water-flow overlay is drawn with 1-pixel WebGL lines and is faint.
- The bundle is about 850 KB (230 KB gzipped), mostly Three.js and the terrain.
