// Unit tests for the battery runtime maths.  node tests/soc.test.mjs
import {
  socFromCellVolts, openCircuitVoltage, socFromVoltage, packEnergyWh,
  countDownSoc, remainingWh, runtimeHours, formatRuntime,
} from '../soc.js';

let pass = 0, fail = 0;
function eq(label, got, want, tol = 1e-9) {
  const ok = (typeof want === 'number' && typeof got === 'number')
    ? Math.abs(got - want) <= tol
    : JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
}

console.log('--- OCV curve ---');
eq('4.20 V/cell = 100%', socFromCellVolts(4.20), 100);
eq('3.00 V/cell = 0%',   socFromCellVolts(3.00), 0);
eq('above range clamps', socFromCellVolts(4.35), 100);
eq('below range clamps', socFromCellVolts(2.80), 0);
eq('3.80 V/cell = 55%',  socFromCellVolts(3.80), 55);
eq('3.70 V/cell interpolates to 38.33%', socFromCellVolts(3.70), 38.333333, 1e-3);

console.log('\n--- sag correction ---');
eq('resting voltage is unchanged', openCircuitVoltage(19.89, 0, false, 2), 19.89);
eq('loaded voltage adds I*R (2 packs)', openCircuitVoltage(20.00, 1.60, true, 2), 20.096, 1e-6);
eq('4 packs halves the sag', openCircuitVoltage(20.00, 1.60, true, 4), 20.048, 1e-6);
eq('SoC from 19.89 V resting', socFromVoltage(19.89, 0, false, 2), 82.25, 0.05);
eq('SoC from 20.09 V @1.62 A loaded', socFromVoltage(20.09, 1.62, true, 2), 88.744, 0.01);

console.log('\n--- energy and runtime ---');
eq('1 x 5 Ah pack = 100 Wh', packEnergyWh(5, 1), 100);
eq('2 x 5 Ah packs = 200 Wh', packEnergyWh(5, 2), 200);
eq('coulomb count consumes 32 Wh of 200', countDownSoc(100, 32, 200), 84);
eq('coulomb count clamps at 0', countDownSoc(5, 9999, 200), 0);
eq('remaining Wh at 50% of 200', remainingWh(50, 200), 100);
eq('100 Wh at 32.6 W = 3.07 h', runtimeHours(100, 32.6), 3.067485, 1e-5);
eq('negligible draw returns null', runtimeHours(100, 0.4), null);

console.log('\n--- formatting ---');
eq('5.0 h -> 5:00', formatRuntime(5.0), { value: '5:00', unit: 'h:mm left' });
eq('0.5 h -> 30 min', formatRuntime(0.5), { value: '30', unit: 'min left' });
eq('null -> dashes', formatRuntime(null), { value: '--', unit: '' });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
