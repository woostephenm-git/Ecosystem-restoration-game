// Number formatting shared by the game layer and the UI. Pure functions only.
import type { Variable } from './schema';

export function fmt(v: Variable, x: number): string {
  return x.toFixed(v.display_decimals);
}

export function fmtUnit(v: Variable, x: number): string {
  return withUnit(v, fmt(v, x));
}

/** Append the variable's unit to already formatted text: "12 mg/L", but "12%" and "0.3/day". */
export function withUnit(v: Variable, text: string): string {
  return v.unit.startsWith('%') || v.unit.startsWith('/') ? `${text}${v.unit}` : `${text} ${v.unit}`;
}

export function fmtRange(v: Variable, lo: number, hi: number): string {
  return `${fmt(v, lo)} to ${fmt(v, hi)}`;
}

/** Round to the precision the variable is displayed at, so measured values match what is shown. */
export function roundTo(v: Variable, x: number): number {
  const f = Math.pow(10, v.display_decimals);
  return Math.round(x * f) / f;
}

export function fmtMoney(x: number): string {
  return `$${Math.round(x).toLocaleString('en-US')}`;
}

export function calendar(missionDay: number, startDayOfYear: number, startYear = 1): { year: number; month: string; label: string } {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
  const abs = startDayOfYear + missionDay;
  const year = startYear + Math.floor(abs / 365);
  const doy = ((abs % 365) + 365) % 365;
  let m = 0;
  while (doy >= cum[m + 1]) m++;
  const day = doy - cum[m] + 1;
  return { year, month: months[m], label: `Year ${year}, ${day} ${months[m]}` };
}
