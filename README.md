# Ecosystem Restoration Game

An isometric ecosystem restoration game about diagnosis: symptoms appear in one layer while the cause lives in another. This repo holds the vertical slice, **Mission 1: Clearwater Pond**, built from `restoration-game-design.md` (the design doc that is the source of truth).

## Run it

```bash
npm install
npm run dev        # play at http://localhost:5173 (add ?seed=123 for a fixed seed)
                   # the dev server starts with a $100,000 testing budget; ?budget=7000 plays the real one
npm test           # unit and scripted mission tests
npm run sim -- solution   # headless run of a scripted plan, prints pond state every 60 days
```

Scenarios for `npm run sim`: `nothing`, `plant`, `removal`, `solution`, `solution_noplant`, `solution_deep`, `full`. Add a seed after the scenario name, e.g. `npm run sim -- solution 2`.

## Layout

```
data/                 all variables, links, methods, interventions, missions (JSON, human-editable)
  missions/ maps/ bc/ mission definitions, tile maps, boundary conditions
src/sim/              headless simulation core: no DOM, no rendering
  schema.ts           zod schemas for every data file
  loader.ts           validation and cross-reference checks
  functions.ts        link function library (linear, saturating, threshold, exponential_decay, product)
  engine.ts           variable graph: stocks, derived variables, multi-rate updates, interventions, map pass
  grid.ts             map geometry: neighbours, D8 flow directions, flow accumulation
  knowledge.ts        what the player knows: unknown / estimate (bounds) / measured
  game.ts             budget, sampling, interventions, link discovery, limiting factors, hints, outcome
src/ui/               investigation view (vanilla TypeScript, renders from Game)
tests/                vitest: function library, loader, engine, knowledge, Mission 1 scenarios
scripts/              tuning helpers
```

## Build plan status (design doc section 8)

1. Project skeleton: done.
2. Headless simulation core: done.
3. Single-tile Clearwater sim with scripted tests: done. Tests check that planting first fails, removal without a barrier works briefly then fails, removal + barrier + planting succeeds, and the system shows hysteresis.
4. Investigation view: done.
5. Small isometric map: done as a 3×3 grid. D8 routing, mixing, carp dispersal and plant spread run in the map pass. The map view shows boundary conditions and per-variable knowledge overlays, and clicking a tile opens the investigation view.
6. Interventions, time controls, objective, win and lose: done.
7. Playtest and tune: first pass only.

## Decisions taken on open questions

These were marked Open or Proposed in the design doc. Each is easy to change.

- **Engine:** TypeScript + Vite in the browser, chosen over Godot 4. The sim core has no browser dependencies and could be ported.
- **Failure state:** the objective is scored at the deadline from the true state, then the player can keep running the pond as a sandbox.
- **Budget:** one shared budget ($7,000) for sampling and interventions. The dev server overrides it with $100,000 for testing (`TESTING_BUDGET` in `src/ui/main.ts`). Production builds use the mission's budget.
- **Scales:** every variable has a typical range (`scale` in `data/variables.json`), with an optional reference mark (a threshold or target). Gauges show low, mid or high by thirds of that range.
- **Measurement staleness:** visual observations update daily. Coarse-visible variables fall back to a visual estimate 30 days after a measurement. Lab-only variables keep their last measurement and are tagged with their age.
- **Pin coordinates:** `pin.y` is a fraction of the variable's zone height, not of the whole drawing, so pins stay in their zone when zone heights change.
- **Grid scale:** 50 m tiles. Clearwater Pond is 3×3 tiles (2.25 ha), with depths from 0.6 m in the margins to 1.6 m in the centre.
- **Lateral processes:** the map pass writes `lateral` variables (water exchange, incoming concentrations, carp arriving, neighbouring plant cover). Ordinary links read them. Each lateral input is a weighted sum of other tiles' values and boundary values, so the knowledge model works out what is known about it from what is known about its sources.
- **D8 on flat water:** a pond's surface is flat, so tiles with no downhill neighbour route one step closer to the outlet. All water also mixes with its face neighbours.
- **Scopes:** planting is per tile ($300). Carp removal, the barrier and alum act on the whole pond. Fish surveys and the inflow fish trap cover the whole water body. Other sampling covers one tile.
- **Seed bank:** set low (a pond turbid for decades has a depleted seed bank), so restoring clarity without planting is too slow.
- **Additions beyond the doc:** a `light_bed` variable (light at the bed, calculated from Secchi depth and water depth once both are known), an oxygen-profile method, and an inflow fish trap that reveals carp immigration.

## Model notes

- Light: `Kd = 1.7 / Secchi` (Poole-Atkins); light at the bed = `exp(-Kd × depth)`.
- Turbid state: carp around 440 kg/ha, suspended sediment around 50 mg/L, Secchi around 0.45 m, about 1% of surface light at the bed.
- Clear state: Secchi around 2.5 m, plant cover around 70%. It holds up to roughly 250 kg/ha of carp. A bare pond stays turbid at 200 kg/ha (tested).
- Feedback loops that create the two stable states: plants trap sediment and suppress carp spawning; bare sediment plus carp keeps the water dark; low oxygen releases legacy phosphorus, which feeds algae, which use up more oxygen.
