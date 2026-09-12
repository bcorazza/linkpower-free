// Battery state-of-charge and runtime maths for the PeakDo Link-Power Pack.
//
// Kept dependency-free and DOM-free so it can be unit tested (tests/soc.test.mjs).

export const CELLS = 5;               // DeWalt 20V MAX packs are 5S Li-ion
// Measured on real hardware (2026-09-12, 2 packs installed), two ways:
//   least-squares fit of V = a - R*I over a 0.58-1.65 A swing: R = 86 mOhm (R^2 0.73)
//   robust quartile two-point over the same data:                R = 89 mOhm
// They agree, so 87 mOhm is used. That is about what two healthy ~0.17 ohm
// packs in parallel should give, so the packs are in good shape.
//
// An earlier 40 s fit reported 181 mOhm; it was wrong because the pack voltage
// drifted downward over the window and the drift was misattributed to current.
// Separating the load bursts from the drift brought it down to the value above.
//
export const R_OHM_AT_2_PACKS = 0.087;
export const WH_PER_PACK_VOLTS = 20;  // DeWalt label 20V MAX capacity at 20 V

// Open-circuit voltage per cell -> state of charge for Li-ion.
export const OCV_TABLE = [
  [4.20, 100], [4.10, 95], [4.00, 85], [3.92, 75], [3.85, 65],
  [3.80, 55], [3.74, 45], [3.68, 35], [3.60, 25], [3.50, 15],
  [3.42, 8], [3.30, 3], [3.00, 0],
];

/** Interpolate state of charge (%) from a per-cell open-circuit voltage. */
export function socFromCellVolts(v) {
  if (!Number.isFinite(v)) return null;
  if (v >= OCV_TABLE[0][0]) return 100;
  const [vMin, sMin] = OCV_TABLE[OCV_TABLE.length - 1];
  if (v <= vMin) return 0;
  for (let i = 0; i < OCV_TABLE.length - 1; i++) {
    const [v1, s1] = OCV_TABLE[i];
    const [v2, s2] = OCV_TABLE[i + 1];
    if (v <= v1 && v >= v2) return s2 + (s1 - s2) * ((v - v2) / (v1 - v2));
  }
  return 0;
}

/**
 * Measured port voltage -> open-circuit voltage.
 * Under load the pack sags, so add back I x R. With the output off the reading
 * is already a true resting voltage and is returned unchanged.
 */
export function openCircuitVoltage(volts, amps, enabled, packs = 2) {
  if (!Number.isFinite(volts)) return null;
  if (!enabled || !(amps > 0.05)) return volts;
  const r = R_OHM_AT_2_PACKS * (2 / Math.max(1, Math.min(4, packs)));
  return volts + amps * r;
}

/** Measured port voltage -> state of charge (%). */
export function socFromVoltage(volts, amps, enabled, packs = 2) {
  const ocv = openCircuitVoltage(volts, amps, enabled, packs);
  if (ocv === null) return null;
  return socFromCellVolts(ocv / CELLS);
}

/** Nameplate energy of the installed packs, in Wh. */
export function packEnergyWh(ahPerPack, packs) {
  return Math.max(0.5, ahPerPack) * WH_PER_PACK_VOLTS * Math.max(1, Math.min(4, packs));
}

/** Coulomb counting from a voltage anchor. Clamped to 0..100. */
export function countDownSoc(anchorSoc, usedWh, totalWh) {
  if (!Number.isFinite(anchorSoc) || !(totalWh > 0)) return null;
  return Math.max(0, Math.min(100, anchorSoc - ((usedWh || 0) / totalWh) * 100));
}

export function remainingWh(socPct, totalWh) {
  return (Math.max(0, Math.min(100, socPct)) / 100) * totalWh;
}

/** Hours of runtime at a given draw, or null if the draw is negligible. */
export function runtimeHours(wh, watts) {
  if (!(watts > 1)) return null;
  return wh / watts;
}

/** Format hours as "h:mm", or minutes when under an hour. */
export function formatRuntime(hours) {
  if (hours === null || !Number.isFinite(hours)) return { value: '--', unit: '' };
  if (hours >= 1) {
    return { value: `${Math.floor(hours)}:${String(Math.round((hours % 1) * 60)).padStart(2, '0')}`, unit: 'h:mm left' };
  }
  return { value: (hours * 60).toFixed(0), unit: 'min left' };
}
