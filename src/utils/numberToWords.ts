const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function enHundreds(n: number): string {
  if (n === 0) return '';
  if (n < 20) return ones[n];
  if (n < 100) {
    const t = tens[Math.floor(n / 10)];
    const o = ones[n % 10];
    return o ? `${t}-${o}` : t;
  }
  const h = ones[Math.floor(n / 100)];
  const rem = enHundreds(n % 100);
  return rem ? `${h} hundred ${rem}` : `${h} hundred`;
}

function enChunk(n: number): string {
  return enHundreds(n);
}

export function usdToWords(amount: number): string {
  if (!isFinite(amount) || amount < 0) return '';
  const rounded = Math.round(amount * 100);
  const dollars = Math.floor(rounded / 100);
  const cents = rounded % 100;

  const dollarWord = dollars === 0 ? 'zero' : '';

  let result = '';
  if (dollars > 0) {
    const billions = Math.floor(dollars / 1_000_000_000);
    const millions = Math.floor((dollars % 1_000_000_000) / 1_000_000);
    const thousands = Math.floor((dollars % 1_000_000) / 1_000);
    const remainder = dollars % 1_000;

    const parts: string[] = [];
    if (billions) parts.push(`${enChunk(billions)} billion`);
    if (millions) parts.push(`${enChunk(millions)} million`);
    if (thousands) parts.push(`${enChunk(thousands)} thousand`);
    if (remainder) parts.push(enChunk(remainder));
    result = parts.join(' ');
  }

  const dollarPart = `${result || dollarWord} dollar${dollars !== 1 ? 's' : ''}`;

  if (cents === 0) return capitalize(dollarPart);
  const centPart = `${enChunk(cents)} cent${cents !== 1 ? 's' : ''}`;
  return capitalize(`${dollarPart} and ${centPart}`);
}

function capitalize(input: string | null | undefined): string {
  if (!input) return '';

  const normalized = String(input).toLowerCase();
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

const idOnes = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan',
  'sepuluh', 'sebelas', 'dua belas', 'tiga belas', 'empat belas', 'lima belas', 'enam belas',
  'tujuh belas', 'delapan belas', 'sembilan belas'];
const idTens = ['', '', 'dua puluh', 'tiga puluh', 'empat puluh', 'lima puluh',
  'enam puluh', 'tujuh puluh', 'delapan puluh', 'sembilan puluh'];

function idHundreds(n: number): string {
  if (n === 0) return '';
  if (n < 20) return idOnes[n];
  if (n < 100) {
    const t = idTens[Math.floor(n / 10)];
    const o = idOnes[n % 10];
    return o ? `${t} ${o}` : t;
  }
  const h = Math.floor(n / 100);
  const rem = idHundreds(n % 100);
  const hundreds = h === 1 ? 'seratus' : `${idOnes[h]} ratus`;
  return rem ? `${hundreds} ${rem}` : hundreds;
}

export function idrToWords(amount: number): string {
  if (!isFinite(amount) || amount < 0) return '';
  const n = Math.round(amount);
  if (n === 0) return 'Nol rupiah';

  const billions = Math.floor(n / 1_000_000_000);
  const millions = Math.floor((n % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1_000);
  const remainder = n % 1_000;

  const parts: string[] = [];
  if (billions) parts.push(`${idHundreds(billions)} miliar`);
  if (millions) parts.push(`${idHundreds(millions)} juta`);
  if (thousands) {
    if (thousands === 1) parts.push('seribu');
    else parts.push(`${idHundreds(thousands)} ribu`);
  }
  if (remainder) parts.push(idHundreds(remainder));

  return capitalize(parts.join(' ') + ' rupiah');
}
