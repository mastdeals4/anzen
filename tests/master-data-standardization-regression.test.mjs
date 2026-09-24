import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGING_TYPES,
  COUNTRIES,
  normalizePackagingType,
  normalizeCountry,
  formatProductPackaging,
} from '../src/constants/masterData.ts';

test('1. Master Data: PACKAGING_TYPES canonical vocabulary', () => {
  assert.deepEqual(
    [...PACKAGING_TYPES],
    ['Bag', 'Drum', 'Tin', 'Box', 'Carton', 'Pallet'],
    'PACKAGING_TYPES must contain exactly Bag, Drum, Tin, Box, Carton, Pallet'
  );
});

test('2. Master Data: normalizePackagingType normalizes variants to canonical', () => {
  // Bags
  assert.equal(normalizePackagingType('bag'), 'Bag');
  assert.equal(normalizePackagingType('BAG'), 'Bag');
  assert.equal(normalizePackagingType('bags'), 'Bag');
  assert.equal(normalizePackagingType('sack bag'), 'Bag');
  assert.equal(normalizePackagingType('woven bag'), 'Bag');
  assert.equal(normalizePackagingType('25kg woven bag'), 'Bag');
  assert.equal(normalizePackagingType('25 KGS'), 'Bag');

  // Drums
  assert.equal(normalizePackagingType('drum'), 'Drum');
  assert.equal(normalizePackagingType('DRUM'), 'Drum');
  assert.equal(normalizePackagingType('drums'), 'Drum');
  assert.equal(normalizePackagingType('25kg Drum'), 'Drum');
  assert.equal(normalizePackagingType('25kg durm'), 'Drum');

  // Tin
  assert.equal(normalizePackagingType('tin'), 'Tin');
  assert.equal(normalizePackagingType('TIN'), 'Tin');
  assert.equal(normalizePackagingType('tins'), 'Tin');

  // Box
  assert.equal(normalizePackagingType('box'), 'Box');
  assert.equal(normalizePackagingType('BOX'), 'Box');
  assert.equal(normalizePackagingType('boxes'), 'Box');

  // Carton
  assert.equal(normalizePackagingType('carton'), 'Carton');
  assert.equal(normalizePackagingType('CARTON'), 'Carton');
  assert.equal(normalizePackagingType('cartons'), 'Carton');
  assert.equal(normalizePackagingType('ctn'), 'Carton');

  // Pallet
  assert.equal(normalizePackagingType('pallet'), 'Pallet');
  assert.equal(normalizePackagingType('PALLET'), 'Pallet');
  assert.equal(normalizePackagingType('pallets'), 'Pallet');
  assert.equal(normalizePackagingType('plt'), 'Pallet');

  // Invalid / Empty
  assert.equal(normalizePackagingType(''), null);
  assert.equal(normalizePackagingType(null), null);
  assert.equal(normalizePackagingType(undefined), null);
  assert.equal(normalizePackagingType('unknown_type'), null);
});

test('3. Master Data: COUNTRIES contains canonical dataset and ISO codes', () => {
  assert.ok(COUNTRIES.length > 30, 'COUNTRIES dataset should be comprehensive');

  const china = COUNTRIES.find(c => c.name === 'China');
  assert.ok(china, 'China must exist in COUNTRIES');
  assert.equal(china.code, 'CN');
  assert.equal(china.code3, 'CHN');
  assert.ok(china.aliases?.includes('PRC'));
  assert.ok(china.aliases?.includes('CH'));

  const india = COUNTRIES.find(c => c.name === 'India');
  assert.ok(india, 'India must exist in COUNTRIES');
  assert.equal(india.code, 'IN');
  assert.equal(india.code3, 'IND');

  const indonesia = COUNTRIES.find(c => c.name === 'Indonesia');
  assert.ok(indonesia, 'Indonesia must exist in COUNTRIES');
  assert.equal(indonesia.code, 'ID');
  assert.equal(indonesia.code3, 'IDN');

  const usa = COUNTRIES.find(c => c.name === 'United States');
  assert.ok(usa, 'United States must exist in COUNTRIES');
  assert.equal(usa.code, 'US');
  assert.equal(usa.code3, 'USA');

  const japan = COUNTRIES.find(c => c.name === 'Japan');
  assert.ok(japan, 'Japan must exist in COUNTRIES');
  assert.equal(japan.code, 'JP');
  assert.equal(japan.code3, 'JPN');
});

test('4. Master Data: normalizeCountry normalizes names, ISO codes, and aliases', () => {
  // China
  assert.equal(normalizeCountry('China'), 'China');
  assert.equal(normalizeCountry('china'), 'China');
  assert.equal(normalizeCountry('CHINA'), 'China');
  assert.equal(normalizeCountry('CN'), 'China');
  assert.equal(normalizeCountry('cn'), 'China');
  assert.equal(normalizeCountry('CHN'), 'China');
  assert.equal(normalizeCountry('PRC'), 'China');
  assert.equal(normalizeCountry('P.R. China'), 'China');
  assert.equal(normalizeCountry("People's Republic of China"), 'China');

  // India
  assert.equal(normalizeCountry('India'), 'India');
  assert.equal(normalizeCountry('india'), 'India');
  assert.equal(normalizeCountry('INDIA'), 'India');
  assert.equal(normalizeCountry('IN'), 'India');
  assert.equal(normalizeCountry('in'), 'India');
  assert.equal(normalizeCountry('IND'), 'India');

  // Indonesia
  assert.equal(normalizeCountry('Indonesia'), 'Indonesia');
  assert.equal(normalizeCountry('indonesia'), 'Indonesia');
  assert.equal(normalizeCountry('INDONESIA'), 'Indonesia');
  assert.equal(normalizeCountry('ID'), 'Indonesia');
  assert.equal(normalizeCountry('id'), 'Indonesia');
  assert.equal(normalizeCountry('IDN'), 'Indonesia');

  // United States
  assert.equal(normalizeCountry('United States'), 'United States');
  assert.equal(normalizeCountry('united states'), 'United States');
  assert.equal(normalizeCountry('US'), 'United States');
  assert.equal(normalizeCountry('USA'), 'United States');
  assert.equal(normalizeCountry('America'), 'United States');

  // Japan
  assert.equal(normalizeCountry('Japan'), 'Japan');
  assert.equal(normalizeCountry('japan'), 'Japan');
  assert.equal(normalizeCountry('JP'), 'Japan');
  assert.equal(normalizeCountry('JPN'), 'Japan');

  // Invalid / Empty
  assert.equal(normalizeCountry(''), null);
  assert.equal(normalizeCountry(null), null);
  assert.equal(normalizeCountry(undefined), null);
  assert.equal(normalizeCountry('XYZ_NON_EXISTENT'), null);
});

test('5. Master Data: formatProductPackaging produces consistent strings', () => {
  assert.equal(formatProductPackaging('Bag', 25, 'KG'), 'Bag · 25 KG/pack');
  assert.equal(formatProductPackaging('bag', '25', 'kg'), 'Bag · 25 KG/pack');
  assert.equal(formatProductPackaging('Drum', 50, 'kg'), 'Drum · 50 KG/pack');
  assert.equal(formatProductPackaging('Box', 250, 'KG'), 'Box · 250 KG/pack');
  assert.equal(formatProductPackaging('Carton', null, 'KG'), 'Carton');
  assert.equal(formatProductPackaging('Pallet', undefined, 'KG'), 'Pallet');
  assert.equal(formatProductPackaging(null, 25, 'KG'), '25 KG/pack');
  assert.equal(formatProductPackaging(null, null, 'KG'), '—');
});
