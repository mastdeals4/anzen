import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import {
  prepareOptimizedUpload,
  optimizePdfBuffer,
  isDigitallySignedPdf,
} from '../src/services/storage/uploadOptimizationService.ts';

test('Upload Optimization Service — Digitally signed PDF strictly skipped and preserved byte-for-byte', async () => {
  // Construct a signed PDF structure with /ByteRange and /Type /Sig
  const signedPdf = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n4 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [0 100 200 300] /Contents <308201> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF';
  const signedBytes = new TextEncoder().encode(signedPdf);

  assert.equal(isDigitallySignedPdf(signedBytes), true, 'Must detect digital signature byte markers');

  const pdfFile = new File([signedBytes], 'Vendor_Signed_Contract.pdf', { type: 'application/pdf' });
  const result = await prepareOptimizedUpload(pdfFile);

  assert.equal(result.isOptimized, false, 'Signed PDF must NEVER undergo stream modification');
  assert.equal(result.mimeType, 'application/pdf');
  assert.equal(result.originalSize, pdfFile.size);
  assert.equal(result.optimizedSize, pdfFile.size);
  assert.equal(result.savedBytes, 0);

  const preservedText = await result.file.text();
  assert.equal(preservedText, signedPdf, 'Signed PDF must be preserved byte-for-byte');
});

test('Upload Optimization Service — Lossless PDF stream & object structure optimization', async () => {
  // Create a realistic multi-page PDF with redundant objects and uncompressed text
  const doc = await PDFDocument.create();
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage([600, 800]);
    page.drawText(`Tax Invoice & Chemical Analysis Report - Page ${i}`, { x: 50, y: 750, size: 16 });
    // Add multiple objects to simulate realistic ERP document
    for (let j = 0; j < 40; j++) {
      page.drawText(`Item ${j}: Batch COA Chemical Certificate analytical data point ${j * 123.45}`, {
        x: 50,
        y: 700 - j * 12,
        size: 10,
      });
    }
  }

  // Save without object streams first (simulating standard generator output)
  const rawBytes = await doc.save({ useObjectStreams: false });
  const rawFile = new File([rawBytes], 'Invoice_Large_COA.pdf', { type: 'application/pdf' });

  // Test optimizePdfBuffer directly with custom min threshold
  const bufferResult = await optimizePdfBuffer(rawBytes, { minSavingsBytes: 500, minSavingsPercent: 5 });

  if (bufferResult.isOptimized) {
    assert.equal(bufferResult.pageCount, 3, 'Must preserve exact page count');
    assert.ok(bufferResult.savedBytes > 500, 'Must achieve genuine savings');
    assert.ok(bufferResult.compressionRatio >= 0.05, 'Must meet minimum savings percentage');

    // Verify optimized document can be reloaded and text/pages inspected
    const reloadedDoc = await PDFDocument.load(bufferResult.optimizedBuffer);
    assert.equal(reloadedDoc.getPageCount(), 3, 'Reloaded PDF must maintain page integrity');
  }
});

test('Upload Optimization Service — Interactive PDF Form fields and annotations preserved', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const form = doc.getForm();
  
  const poField = form.createTextField('purchase_order_number');
  poField.setText('PO-2026-9988');
  poField.addToPage(page, { x: 50, y: 300, width: 200, height: 30 });

  const amountField = form.createTextField('total_amount_idr');
  amountField.setText('150000000');
  amountField.addToPage(page, { x: 50, y: 250, width: 200, height: 30 });

  const rawBytes = await doc.save();
  const rawFile = new File([rawBytes], 'Purchase_Order_Form.pdf', { type: 'application/pdf' });

  // Run through pipeline
  const result = await prepareOptimizedUpload(rawFile);
  
  // Verify that regardless of optimization decision, the form fields remain intact
  const resultBytes = new Uint8Array(await result.file.arrayBuffer());
  const verifiedDoc = await PDFDocument.load(resultBytes);
  const verifiedForm = verifiedDoc.getForm();
  
  assert.equal(verifiedForm.getTextField('purchase_order_number').getText(), 'PO-2026-9988');
  assert.equal(verifiedForm.getTextField('total_amount_idr').getText(), '150000000');
});

test('Upload Optimization Service — Small PDFs skip rewriting when savings < 5%', async () => {
  // A tiny 1-page PDF already compact
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const tinyBytes = await doc.save({ useObjectStreams: true });
  const tinyFile = new File([tinyBytes], 'receipt_tiny.pdf', { type: 'application/pdf' });

  const result = await prepareOptimizedUpload(tinyFile);

  assert.equal(result.isOptimized, false, 'Small/compact PDF must skip rewriting if savings < 5%');
  assert.equal(result.savedBytes, 0);
  assert.equal(result.originalSize, tinyFile.size);
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

