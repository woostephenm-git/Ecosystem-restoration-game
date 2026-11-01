// Gauges place a variable's known value on its typical range, so high and low read at a glance.
// They show knowledge, not truth: a marker for a measured value, a band for an estimate,
// an empty track when unknown.
import { fmtUnit } from '../sim/format';
import { bounds, type Known } from '../sim/knowledge';
import type { Variable } from '../sim/schema';

export type Level = 'low' | 'mid' | 'high';

/** Position of a value on the variable's scale, 0 to 1, clamped. */
export function scalePos(v: Variable, x: number): number {
  const s = v.scale;
  const t = s.log ? (Math.log(Math.max(x, s.min)) - Math.log(s.min)) / (Math.log(s.max) - Math.log(s.min)) : (x - s.min) / (s.max - s.min);
  return Math.min(1, Math.max(0, t));
}

/** Low, mid or high by thirds of the scale; null when unknown or an estimate spans more than one third. */
export function level(v: Variable, k: Known): Level | null {
  const b = bounds(k);
  if (!b) return null;
  const third = (x: number): Level => {
    const t = scalePos(v, x);
    return t < 1 / 3 ? 'low' : t > 2 / 3 ? 'high' : 'mid';
  };
  const lo = third(b.lo);
  return lo === third(b.hi) ? lo : null;
}

function ariaText(v: Variable, k: Known): string {
  const range = `on a typical range of ${fmtUnit(v, v.scale.min)} to ${fmtUnit(v, v.scale.max)}`;
  const lv = level(v, k);
  if (k.state === 'unknown') return `${v.name} unknown ${range}`;
  return `${v.name} ${lv ?? 'uncertain'} ${range}`;
}

export function gauge(v: Variable, k: Known, size: 'mini' | 'full' = 'mini'): string {
  const b = bounds(k);
  const pct = (x: number) => `${(scalePos(v, x) * 100).toFixed(1)}%`;
  const ref = v.scale.reference;
  const parts: string[] = [];
  if (ref) parts.push(`<span class="g-ref" style="left:${pct(ref.value)}"></span>`);
  if (b && k.state === 'estimate') {
    const l = scalePos(v, b.lo);
    const r = scalePos(v, b.hi);
    parts.push(`<span class="g-band" style="left:${(l * 100).toFixed(1)}%;width:${Math.max(1.5, (r - l) * 100).toFixed(1)}%"></span>`);
  } else if (b) {
    // A measured value is a marker only. Shaded track always means "somewhere in this range".
    parts.push(`<span class="g-mark" style="left:${pct(b.lo)}"></span>`);
  }
  const track = `<span class="g-track ${b ? '' : 'unknown'}">${parts.join('')}</span>`;
  if (size === 'mini') return `<span class="gauge mini" role="img" aria-label="${ariaText(v, k)}">${track}</span>`;

  const lv = level(v, k);
  // Keep the reference label clear of the axis ends so it is never cut off.
  const refLeft = ref ? Math.min(85, Math.max(15, scalePos(v, ref.value) * 100)) : 0;
  const refLabel = ref ? `<span class="g-reflabel" style="left:${refLeft.toFixed(1)}%">${ref.label} ${fmtUnit(v, ref.value)}</span>` : '';
  const levelText = !b ? 'Not known yet' : lv ? `${lv[0].toUpperCase()}${lv.slice(1)} for this kind of pond` : 'Range spans low to high';
  return `<div class="gauge full" role="img" aria-label="${ariaText(v, k)}">
    <div class="g-head"><span class="g-level ${lv ?? ''}">${levelText}</span>${v.scale.log ? '<span class="g-note">log scale</span>' : ''}</div>
    ${track}
    <div class="g-axis"><span>${fmtUnit(v, v.scale.min)}</span>${refLabel}<span>${fmtUnit(v, v.scale.max)}</span></div>
  </div>`;
}
