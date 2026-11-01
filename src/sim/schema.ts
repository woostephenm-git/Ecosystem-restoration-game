// Schemas for every data file. The engine trusts nothing that has not passed through here.
import { z } from 'zod';

const id = z.string().regex(/^[a-z0-9_]+$/, 'ids are lower_snake_case');

export const LayerSchema = z.object({
  id,
  name: z.string(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
});

export const ZoneSchema = z.object({
  id,
  name: z.string(),
  order: z.number().int(),
});

const TransformSchema = z.discriminatedUnion('fn', [
  z.object({ fn: z.literal('none') }),
  z.object({ fn: z.literal('reciprocal'), k: z.number() }),
  z.object({ fn: z.literal('exp_neg'), k: z.number() }),
]);

/**
 * Map-pass processes. Each produces, per tile, a linear combination of other
 * tiles' values and boundary values, so the knowledge model can propagate bounds through it.
 */
const LateralSchema = z.discriminatedUnion('process', [
  /** Water exchanged per day as a fraction of tile volume: D8 throughflow plus mixing with neighbours. */
  z.object({ process: z.literal('water_exchange'), discharge: id }),
  /** Mean concentration of the water arriving: from upstream tiles, the inlet (`boundary`), and mixing. */
  z.object({ process: z.literal('incoming_concentration'), of: id, boundary: id.optional(), discharge: id }),
  /**
   * Movement between neighbouring tiles is given as a diffusivity in m²/day, so the
   * per-tile rate (diffusivity / tile area) stays physical when the tile size changes.
   */
  /** Organisms arriving per day from neighbouring tiles, plus `boundary` immigration at inlet tiles. */
  z.object({ process: z.literal('dispersal_in'), of: id, diffusivity_m2_per_day: z.number().min(0), boundary: id.optional() }),
  /** Diffusivity / tile area, times the number of neighbouring water tiles: the per-day leaving rate. */
  z.object({ process: z.literal('neighbour_count'), diffusivity_m2_per_day: z.number().min(0) }),
  /** Sum over neighbouring water tiles of diffusivity / tile area times the variable. */
  z.object({ process: z.literal('neighbour_sum'), of: id, diffusivity_m2_per_day: z.number().min(0) }),
]);

export const VariableSchema = z
  .object({
    id,
    name: z.string(),
    layer: id,
    zone: id,
    unit: z.string(),
    kind: z.enum(['stock', 'derived', 'boundary', 'lateral']),
    derived: z.object({ base: z.number(), transform: TransformSchema }).optional(),
    /** Lateral inputs are written by a map-pass process each day (design doc 3.1), then read by ordinary links. */
    lateral: LateralSchema.optional(),
    update_interval_days: z.number().int().positive(),
    observable: z.enum(['none', 'coarse', 'full']),
    coarse_bins: z.array(z.number()).min(2).optional(),
    observe_source: z.string().optional(),
    inferred_from: z.array(id).optional(),
    initial_knowledge: z.enum(['unknown', 'estimate', 'measured']),
    estimate: z.object({ spread: z.number().positive(), source: z.string() }).optional(),
    display_decimals: z.number().int().min(0),
    /**
     * Typical range for this kind of site, so the UI can show at a glance whether a value is
     * high or low. `log` for variables spanning orders of magnitude. `reference` marks a
     * meaningful level (a threshold or target).
     */
    scale: z
      .object({
        min: z.number(),
        max: z.number(),
        log: z.boolean().optional(),
        reference: z.object({ value: z.number(), label: z.string() }).optional(),
      })
      .refine((s) => s.max > s.min && (!s.log || s.min > 0), 'scale needs max > min, and min > 0 when log'),
    min: z.number().optional(),
    max: z.number().optional(),
    pin: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
    description: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'derived' && !v.derived) ctx.addIssue({ code: 'custom', message: `${v.id}: derived variables need a "derived" block` });
    if (v.kind !== 'derived' && v.derived) ctx.addIssue({ code: 'custom', message: `${v.id}: only derived variables take a "derived" block` });
    if (v.observable === 'coarse' && !v.coarse_bins) ctx.addIssue({ code: 'custom', message: `${v.id}: coarse observables need coarse_bins` });
    if (v.initial_knowledge === 'estimate' && !v.estimate) ctx.addIssue({ code: 'custom', message: `${v.id}: initial estimate needs an "estimate" block` });
    if ((v.kind === 'lateral') !== !!v.lateral) ctx.addIssue({ code: 'custom', message: `${v.id}: lateral variables, and only they, take a "lateral" block` });
  });

const FactorSchema = z.discriminatedUnion('shape', [
  z.object({ var: id, shape: z.literal('identity') }),
  z.object({ var: id, shape: z.literal('power'), p: z.number() }),
  z.object({ var: id, shape: z.literal('saturating'), half: z.number().positive() }),
  z.object({ var: id, shape: z.literal('threshold'), at: z.number(), width: z.number().min(0), direction: z.enum(['above', 'below']) }),
  z.object({ var: id, shape: z.literal('decay'), rate: z.number() }),
  z.object({ var: id, shape: z.literal('complement'), cap: z.number().positive() }),
]);

const LinkBase = {
  id,
  from: z.array(id).min(1),
  to: id,
  label: z.string(),
  strength: z.enum(['weak', 'moderate', 'strong']),
  discovered_by: z.array(id),
};

export const LinkSchema = z.discriminatedUnion('function', [
  z.object({ ...LinkBase, function: z.literal('linear'), params: z.object({ k: z.number() }) }),
  z.object({ ...LinkBase, function: z.literal('saturating'), params: z.object({ k: z.number(), half: z.number().positive() }) }),
  z.object({
    ...LinkBase,
    function: z.literal('threshold'),
    params: z.object({ k: z.number(), at: z.number(), width: z.number().min(0), direction: z.enum(['above', 'below']) }),
  }),
  z.object({ ...LinkBase, function: z.literal('exponential_decay'), params: z.object({ k: z.number(), rate: z.number() }) }),
  z.object({ ...LinkBase, function: z.literal('product'), params: z.object({ k: z.number() }), factors: z.array(FactorSchema).min(1).optional() }),
]);

export const MethodSchema = z.object({
  id,
  name: z.string(),
  cost: z.number().min(0),
  reveals: z.array(id).min(1),
  scope: z.enum(['tile', 'water_body']),
  /** Days before the method can be repeated (a fish survey needs a permit and stresses the fish). */
  rest_days: z.number().int().positive().optional(),
  mark: z.object({ kind: z.enum(['secchi', 'bottle', 'probe', 'net', 'trap', 'core']), label: z.string() }),
});

export const InterventionSchema = z.object({
  id,
  name: z.string(),
  description: z.string(),
  cost: z.number().min(0),
  scope: z.enum(['tile', 'water_body']),
  effects: z.array(z.object({ variable: id, op: z.enum(['add', 'multiply', 'set']), value: z.number() })).min(1),
  duration_days: z.number().int().positive(),
  repeatable: z.boolean(),
  /** For designers and instructors only; never shown to players (e.g. why this is a red herring). */
  design_note: z.string().optional(),
});

const BoundaryValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('constant'), value: z.number() }),
  z.object({
    type: z.literal('seasonal'),
    mean: z.number(),
    amplitude: z.number(),
    period_days: z.number().positive(),
    peak_day: z.number(),
    noise: z.number().min(0).default(0),
  }),
]);

export const BoundaryConditionsSchema = z.object({
  id,
  values: z.record(z.string(), BoundaryValueSchema),
});

const Face = z.enum(['N', 'E', 'S', 'W']);

export const MapSchema = z.object({
  id,
  name: z.string(),
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
  tile_size_m: z.number().positive(),
  /** Exchange between neighbouring water tiles, per day, as a fraction of volume. */
  /** Path, relative to data/, of the renderer's heightfield. The sim never reads it. */
  terrain: z.string().optional(),
  /** Water surface elevation, in the same datum as bed_elevation. */
  water_level: z.number(),
  /** Mixing between neighbouring water tiles. Per-tile exchange = this / tile area. */
  mixing_m2_per_day: z.number().min(0),
  /**
   * Boundary variable that raises the pond surface (e.g. a weir). When set, pond depths follow
   * the surface, and land bordering the pond floods once water over it is deeper than `flood_depth`.
   */
  level_variable: id.optional(),
  flood_depth: z.number().positive().default(0.1),
  /** Stock values for newly flooded tiles. Stocks not listed take the mean of neighbouring pond water. */
  flood_initial: z.record(z.string(), z.number()).default({}),
  /** Water bodies. Only simulated bodies' tiles run the sim; the rest are scenery. */
  bodies: z.array(z.object({ id, name: z.string(), simulated: z.boolean() })).min(1),
  /** Initial stock values shared by every tile; a tile's own `initial` overrides them. */
  defaults: z.record(z.string(), z.number()),
  tiles: z
    .array(
      z.object({
        id: z.string(),
        row: z.number().int().min(0),
        col: z.number().int().min(0),
        description: z.string(),
        /** Water body this tile belongs to; absent on land. */
        body: id.optional(),
        initial: z.record(z.string(), z.number()),
      }),
    )
    .min(1),
  inlets: z.array(z.object({ tile: z.string(), face: Face, name: z.string(), share: z.number().positive() })).min(1),
  outlets: z.array(z.object({ tile: z.string(), face: Face, name: z.string() })).min(1),
});

const ConditionSchema = z.union([
  z.object({ var: id, known: z.boolean() }),
  /** Measured, as opposed to estimated or unknown. */
  z.object({ var: id, measured: z.boolean() }),
  z.object({ var: id, op: z.enum(['<', '>']), value: z.number() }),
  z.object({ var: id, op: z.enum(['<', '>']), ratio_of: id, factor: z.number() }),
  z.object({ intervention: id, done: z.boolean() }),
  z.object({ days_since_intervention: id, gt: z.number() }),
]);

const FactorTextSchema = z.object({
  unknown: z.string(),
  suspected: z.string(),
  limiting: z.string(),
  likely: z.string(),
  not_limiting: z.string(),
});

export const MissionSchema = z.object({
  id,
  title: z.string(),
  briefing: z.string(),
  map: z.string(),
  boundary_conditions: z.string(),
  layers_enabled: z.array(id).min(1),
  budget: z.number().min(0),
  start: z.object({ year: z.number().int(), day_of_year: z.number().int().min(0).max(364) }),
  spinup_days: z.number().int().min(0),
  objective: z.object({
    variable: id,
    target: z.number(),
    aggregate: z.enum(['mean_over_water']),
    deadline_years: z.number().positive(),
    text: z.string(),
  }),
  methods: z.array(id),
  interventions: z.array(id),
  measurement_fresh_days: z.number().int().positive(),
  limiting_factors: z.object({
    title: z.string(),
    factors: z.array(
      z.object({
        id,
        name: z.string(),
        variable: id,
        limiting_when: z.enum(['above', 'below']),
        threshold: z.number(),
        suspect_when: z.array(ConditionSchema).optional(),
        text: FactorTextSchema,
      }),
    ),
  }),
  hints: z.array(z.object({ id, when: z.array(ConditionSchema).min(1), text: z.string() })),
  /** Pond-wide means recorded at the start and by the final survey, shown side by side. */
  final_survey: z.array(id).min(1),
  /**
   * Applying for more funding: the player maps what limits `target`, two steps deep. Free,
   * decided after `days`, and worth `grant` if every arrow is one the simulation supports.
   */
  funding: z.object({ grant: z.number().min(0), days: z.number().int().positive(), target: id, target_name: z.string() }).optional(),
  /** Shown when the objective is met. Text may use {variable_id}, {target}, {budget_left} and {date}. */
  success_letter: z
    .object({
      from: z.string(),
      address: z.string(),
      salutation: z.string(),
      paragraphs: z.array(z.string()).min(1),
      signoff: z.string(),
      signature: z.string(),
      role: z.string(),
    })
    .optional(),
});

export type Layer = z.infer<typeof LayerSchema>;
export type Zone = z.infer<typeof ZoneSchema>;
export type Variable = z.infer<typeof VariableSchema>;
export type Link = z.infer<typeof LinkSchema>;
export type Factor = z.infer<typeof FactorSchema>;
export type Transform = z.infer<typeof TransformSchema>;
export type Method = z.infer<typeof MethodSchema>;
export type Intervention = z.infer<typeof InterventionSchema>;
export type BoundaryConditions = z.infer<typeof BoundaryConditionsSchema>;
export type BoundaryValue = z.infer<typeof BoundaryValueSchema>;
export type GameMap = z.infer<typeof MapSchema>;
export type Mission = z.infer<typeof MissionSchema>;
export type Condition = z.infer<typeof ConditionSchema>;
export type LimitingFactorDef = Mission['limiting_factors']['factors'][number];

/** Fine heightfield for the 3D map: (size × resolution + 1)² samples, row-major from `origin`. */
export const TerrainSchema = z
  .object({
    id,
    origin: z.number(),
    size: z.number().positive(),
    resolution: z.number().int().positive(),
    playable: z.number().int().positive(),
    water_level: z.number(),
    channels: z.array(z.array(z.tuple([z.number(), z.number()]))),
    heights: z.array(z.number()),
  })
  .refine((t) => t.heights.length === (t.size * t.resolution + 1) ** 2, 'heights must hold (size × resolution + 1)² samples');

export type Terrain = z.infer<typeof TerrainSchema>;
