import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareOptimizedUpload } from '../src/services/storage/uploadOptimizationService.ts';

test('Upload Optimization Service — PDF lossless preservation', async () => {
  const fakePdfContent = '%PDF-1.4\n1 0 obj\n<< /Title (Sensitive Signed Document) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF';
  const pdfBlob = new Blob([fakePdfContent], { type: 'application/pdf' });
  const pdfFile = new File([pdfBlob], 'Contract_Signed.pdf', { type: 'application/pdf' });

  const result = await prepareOptimizedUpload(pdfFile);

  assert.equal(result.isOptimized, false, 'PDF must not undergo destructive compression');
  assert.equal(result.mimeType, 'application/pdf');
  assert.equal(result.originalSize, pdfFile.size);
  assert.equal(result.optimizedSize, pdfFile.size);
  assert.equal(result.savedBytes, 0);

  const text = await result.file.text();
  assert.equal(text, fakePdfContent, 'PDF content must be preserved byte-for-byte');
});

test('Upload Optimization Service — Excel spreadsheet lossless preservation', async () => {
  const fakeXlsxContent = 'PK\x03\x04fake_excel_zip_stream_with_formulas_and_macros';
  const xlsxBlob = new Blob([fakeXlsxContent], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const xlsxFile = new File([xlsxBlob], 'Q4_Financial_Model.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  const result = await prepareOptimizedUpload(xlsxFile);

  assert.equal(result.isOptimized, false, 'Excel file must not undergo destructive modification');
  assert.equal(result.originalSize, xlsxFile.size);
  assert.equal(result.optimizedSize, xlsxFile.size);
  assert.equal(result.savedBytes, 0);

  const text = await result.file.text();
  assert.equal(text, fakeXlsxContent, 'Excel workbook streams must be preserved byte-for-byte');
});

test('Upload Optimization Service — Small images skip compression', async () => {
  // 50 KB dummy image
  const smallBuffer = new Uint8Array(50 * 1024);
  const smallFile = new File([smallBuffer], 'icon.jpg', { type: 'image/jpeg' });

  const result = await prepareOptimizedUpload(smallFile);

  assert.equal(result.isOptimized, false, 'Small images (<80KB) must skip canvas re-encoding');
  assert.equal(result.originalSize, smallFile.size);
  assert.equal(result.optimizedSize, smallFile.size);
});

test('Upload Optimization Service — Unsupported/other binary formats pass through untouched', async () => {
  const zipContent = 'PK\x03\x04dummy_archive_content';
  const zipFile = new File([zipContent], 'data_backup.zip', { type: 'application/zip' });

  const result = await prepareOptimizedUpload(zipFile);

  assert.equal(result.isOptimized, false);
  assert.equal(result.mimeType, 'application/zip');
  assert.equal(result.originalSize, zipFile.size);
  assert.equal(result.optimizedSize, zipFile.size);
});

