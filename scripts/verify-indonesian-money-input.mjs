import {
  formatIndonesianMoneyInput,
  parseIndonesianMoneyInput,
  parseIndonesianNumber,
} from '../src/utils/currency.ts';

const validCases = [
  ['55.359.075,50', 55359075.50],
  ['55.359.075', 55359075],
  ['55359075,50', 55359075.50],
  ['55359075', 55359075],
  ['0,50', 0.50],
  ['100,25', 100.25],
  [',50', 0.50],
  ['.50', 0.50],
  ['15019.50', 15019.50],
  ['15.019,50', 15019.50],
  ['15019,50', 15019.50],
  // Intermediate typing states: trailing comma or dot
  ['55.359.075,', 55359075],
  ['100,', 100],
  ['15019.', 15019],
];

for (const [input, expected] of validCases) {
  const actual = parseIndonesianMoneyInput(input);
  if (actual !== expected) {
    throw new Error(`${input} parsed as ${actual}; expected ${expected}`);
  }
}

for (const invalid of ['abc', '1,2,3', '1-2']) {
  if (parseIndonesianMoneyInput(invalid) !== null) {
    throw new Error(`Invalid money input was accepted: ${invalid}`);
  }
}

const formattedCases = [
  [55359075.50, '55.359.075,50'],
  [100, '100,00'],
  [0.50, '0,50'],
  [1000000, '1.000.000,00'],
];

for (const [input, expected] of formattedCases) {
  const actual = formatIndonesianMoneyInput(input);
  if (actual !== expected) {
    throw new Error(`${input} formatted as ${actual}; expected ${expected}`);
  }
}

const pasteCases = [
  ['Rp 55.359.075,50', 55359075.50],
  ['55,359,075.50', 55359075.50],
];

for (const [input, expected] of pasteCases) {
  const actual = parseIndonesianNumber(input);
  if (actual !== expected) {
    throw new Error(`Pasted value ${input} parsed as ${actual}; expected ${expected}`);
  }
}

console.log('Indonesian money-input regression passed.');
