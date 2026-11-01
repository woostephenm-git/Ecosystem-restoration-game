// Turns raw data files into a validated, cross-referenced bundle.
// Raw files are passed in keyed by their path relative to data/, so the same
// loader works in the browser (bundled JSON) and in Node (read from disk).
import { z } from 'zod';
import {
  BoundaryConditionsSchema,
  InterventionSchema,
  LayerSchema,
  LinkSchema,
  MapSchema,
  MethodSchema,
  MissionSchema,
  TerrainSchema,
  VariableSchema,
  ZoneSchema,
  type BoundaryConditions,
  type Factor,
  type GameMap,
  type Intervention,
  type Layer,
  type Link,
  type Method,
  type Mission,
  type Terrain,
  type Variable,
  type Zone,
} from './schema';

export type RawFiles = Record<string, unknown>;

/** A link after normalisation: product links always carry explicit factors. */
export type NormalLink = Link & { factors?: Factor[] };

export interface DataBundle {
  layers: Map<string, Layer>;
  zones: Zone[];
  variables: Map<string, Variable>;
  links: NormalLink[];
  methods: Map<string, Method>;
  interventions: Map<string, Intervention>;
  missions: Map<string, Mission>;
  maps: Map<string, GameMap>;
  boundaryConditions: Map<string, BoundaryConditions>;
  terrains: Map<string, Terrain>;
}

export class DataError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid game data:\n  - ${problems.join('\n  - ')}`);
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, file: string, problems: string[]): T | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    problems.push(`${file} at ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  return undefined;
}

function parseList<T>(schema: z.ZodType<T>, files: RawFiles, file: string, problems: string[]): T[] {
  const raw = files[file];
  if (raw === undefined) {
    problems.push(`${file} is missing`);
    return [];
  }
  return parse(z.array(schema), raw, file, problems) ?? [];
}

function indexById<T extends { id: string }>(items: T[], file: string, problems: string[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.id)) problems.push(`${file}: duplicate id "${item.id}"`);
    map.set(item.id, item);
  }
  return map;
}

export function loadData(files: RawFiles): DataBundle {
  const problems: string[] = [];

  const layers = indexById(parseList(LayerSchema, files, 'layers.json', problems), 'layers.json', problems);
  const zones = parseList(ZoneSchema, files, 'zones.json', problems).sort((a, b) => a.order - b.order);
  const variables = indexById(parseList(VariableSchema, files, 'variables.json', problems), 'variables.json', problems);
  const rawLinks = parseList(LinkSchema, files, 'links.json', problems);
  const methods = indexById(parseList(MethodSchema, files, 'methods.json', problems), 'methods.json', problems);
  const interventions = indexById(parseList(InterventionSchema, files, 'interventions.json', problems), 'interventions.json', problems);

  const missions = new Map<string, Mission>();
  const maps = new Map<string, GameMap>();
  const boundaryConditions = new Map<string, BoundaryConditions>();
  const terrains = new Map<string, Terrain>();
  for (const [path, raw] of Object.entries(files)) {
    if (path.startsWith('missions/')) {
      const m = parse(MissionSchema, raw, path, problems);
      if (m) missions.set(m.id, m);
    } else if (path.startsWith('maps/')) {
      const m = parse(MapSchema, raw, path, problems);
      if (m) maps.set(path, m);
    } else if (path.startsWith('terrain/')) {
      const t = parse(TerrainSchema, raw, path, problems);
      if (t) terrains.set(path, t);
    } else if (path.startsWith('bc/')) {
      const b = parse(BoundaryConditionsSchema, raw, path, problems);
      if (b) boundaryConditions.set(path, b);
    }
  }

  const zoneIds = new Set(zones.map((z) => z.id));
  const needVar = (ref: string, where: string) => {
    if (!variables.has(ref)) problems.push(`${where}: unknown variable "${ref}"`);
  };

  for (const v of variables.values()) {
    if (!layers.has(v.layer)) problems.push(`variables.json ${v.id}: unknown layer "${v.layer}"`);
    if (!zoneIds.has(v.zone)) problems.push(`variables.json ${v.id}: unknown zone "${v.zone}"`);
    for (const ref of v.inferred_from ?? []) needVar(ref, `variables.json ${v.id}.inferred_from`);
    const lat = v.lateral;
    if (lat) {
      if ('of' in lat) needVar(lat.of, `variables.json ${v.id}.lateral.of`);
      if ('discharge' in lat) needVar(lat.discharge, `variables.json ${v.id}.lateral.discharge`);
      if ('boundary' in lat && lat.boundary) {
        needVar(lat.boundary, `variables.json ${v.id}.lateral.boundary`);
        const b = variables.get(lat.boundary);
        if (b && b.kind !== 'boundary') problems.push(`variables.json ${v.id}.lateral.boundary: "${lat.boundary}" is not a boundary variable`);
      }
    }
  }

  const links: NormalLink[] = [];
  const linkIds = new Set<string>();
  for (const link of rawLinks) {
    const where = `links.json ${link.id}`;
    if (linkIds.has(link.id)) problems.push(`links.json: duplicate id "${link.id}"`);
    linkIds.add(link.id);
    link.from.forEach((ref) => needVar(ref, `${where}.from`));
    needVar(link.to, `${where}.to`);
    link.discovered_by.forEach((ref) => needVar(ref, `${where}.discovered_by`));
    const target = variables.get(link.to);
    if (target?.kind === 'boundary' || target?.kind === 'lateral') problems.push(`${where}: ${target.kind} variables cannot be link targets`);

    if (link.function === 'product') {
      const factors: Factor[] = link.factors ?? link.from.map((v) => ({ var: v, shape: 'identity' as const }));
      const factorVars = new Set(factors.map((f) => f.var));
      for (const f of factorVars) if (!link.from.includes(f)) problems.push(`${where}: factor "${f}" is not listed in "from"`);
      for (const f of link.from) if (!factorVars.has(f)) problems.push(`${where}: "from" lists "${f}" but no factor uses it`);
      links.push({ ...link, factors });
    } else {
      if (link.from.length !== 1) problems.push(`${where}: ${link.function} links take exactly one source`);
      links.push(link);
    }
  }

  for (const m of methods.values()) m.reveals.forEach((ref) => needVar(ref, `methods.json ${m.id}.reveals`));
  for (const i of interventions.values()) i.effects.forEach((e) => needVar(e.variable, `interventions.json ${i.id}.effects`));

  for (const mission of missions.values()) {
    const where = `mission ${mission.id}`;
    if (!files[mission.map]) problems.push(`${where}: map "${mission.map}" not found`);
    if (!files[mission.boundary_conditions]) problems.push(`${where}: boundary conditions "${mission.boundary_conditions}" not found`);
    mission.layers_enabled.forEach((l) => {
      if (!layers.has(l)) problems.push(`${where}: unknown layer "${l}"`);
    });
    mission.methods.forEach((m) => {
      if (!methods.has(m)) problems.push(`${where}: unknown method "${m}"`);
    });
    mission.interventions.forEach((i) => {
      if (!interventions.has(i)) problems.push(`${where}: unknown intervention "${i}"`);
    });
    needVar(mission.objective.variable, `${where}.objective`);
    mission.final_survey.forEach((id) => needVar(id, `${where}.final_survey`));
    mission.limiting_factors.factors.forEach((f) => needVar(f.variable, `${where}.limiting_factors.${f.id}`));
  }

  for (const [path, map] of maps) {
    for (const ref of Object.keys(map.defaults)) needVar(ref, `${path} defaults`);
    const ids = new Set<string>();
    const cells = new Set<string>();
    for (const tile of map.tiles) {
      for (const ref of Object.keys(tile.initial)) needVar(ref, `${path} tile ${tile.id}.initial`);
      if (ids.has(tile.id)) problems.push(`${path}: duplicate tile id "${tile.id}"`);
      ids.add(tile.id);
      if (tile.row >= map.rows || tile.col >= map.cols) problems.push(`${path} tile ${tile.id}: outside the ${map.rows}x${map.cols} grid`);
      const cell = `${tile.row},${tile.col}`;
      if (cells.has(cell)) problems.push(`${path} tile ${tile.id}: another tile already sits at row ${tile.row}, col ${tile.col}`);
      cells.add(cell);
    }
    for (const e of [...map.inlets, ...map.outlets]) if (!ids.has(e.tile)) problems.push(`${path}: inlet or outlet names unknown tile "${e.tile}"`);
    if (map.level_variable) {
      needVar(map.level_variable, `${path} level_variable`);
      if (variables.get(map.level_variable) && variables.get(map.level_variable)!.kind !== 'boundary') problems.push(`${path}: level_variable must be a boundary variable`);
    }
    for (const ref of Object.keys(map.flood_initial)) needVar(ref, `${path} flood_initial`);
    const bodyIds = new Set(map.bodies.map((b) => b.id));
    for (const tile of map.tiles) if (tile.body && !bodyIds.has(tile.body)) problems.push(`${path} tile ${tile.id}: unknown body "${tile.body}"`);
    if (map.terrain && !files[map.terrain]) problems.push(`${path}: terrain "${map.terrain}" not found`);
  }
  for (const [path, bc] of boundaryConditions) {
    for (const ref of Object.keys(bc.values)) {
      needVar(ref, `${path}`);
      if (variables.get(ref) && variables.get(ref)!.kind !== 'boundary') problems.push(`${path}: "${ref}" is not a boundary variable`);
    }
  }

  if (problems.length) throw new DataError(problems);
  return { layers, zones, variables, links, methods, interventions, missions, maps, boundaryConditions, terrains };
}
