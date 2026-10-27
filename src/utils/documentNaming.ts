const NON_ALNUM_UNDERSCORE = /[^a-z0-9]+/gi;

const sanitizePart = (value: string): string => {
  return value
    .toLowerCase()
    .replace(NON_ALNUM_UNDERSCORE, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'na';
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const buildNormalizedBaseKey = (product: string, supplier: string, docType: string): string => {
  return [product, supplier, docType].map(sanitizePart).join('_');
};

export const getFileExtension = (fileName: string): string => {
  const idx = fileName.lastIndexOf('.');
  return idx > -1 ? fileName.slice(idx + 1).toLowerCase() : '';
};

export const computeNextDocumentSuffix = (baseKey: string, existingStoragePaths: string[]): '' | `_${number}` => {
  const basePattern = new RegExp(`^${escapeRegExp(baseKey)}(?:_(\\d+))?(?:\\.[a-z0-9]+)?$`, 'i');
  let maxSuffix = -1;

  for (const path of existingStoragePaths) {
    const fileName = path.split('/').pop() || path;
    const match = fileName.match(basePattern);
    if (!match) continue;

    if (match[1]) {
      const numericSuffix = Number(match[1]);
      if (!Number.isNaN(numericSuffix)) {
        maxSuffix = Math.max(maxSuffix, numericSuffix);
      }
    } else {
      maxSuffix = Math.max(maxSuffix, 0);
    }
  }

  if (maxSuffix < 0) return '';
  return `_${maxSuffix + 1}`;
};

export const buildUniqueDocumentNames = ({
  product,
  supplier,
  docType,
  originalFilename,
  existingStoragePaths,
}: {
  product: string;
  supplier: string;
  docType: string;
  originalFilename: string;
  existingStoragePaths: string[];
}): { normalizedBaseKey: string; displayName: string; fileName: string } => {
  const normalizedBaseKey = buildNormalizedBaseKey(product, supplier, docType);
  const suffix = computeNextDocumentSuffix(normalizedBaseKey, existingStoragePaths);
  const extension = getFileExtension(originalFilename);
  const stem = `${normalizedBaseKey}${suffix}`;

  return {
    normalizedBaseKey,
    displayName: extension ? `${stem}.${extension}` : stem,
    fileName: extension ? `${stem}.${extension}` : stem,
  };
};
