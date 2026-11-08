import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEmailAttachment } from '../src/services/crm/emailAttachmentFilter.ts';

describe('ANZEN CRM Document Bank — Email Attachment Filter Rules', () => {
  it('excludes bounce notifications and mail delivery subsystem attachments', () => {
    const res = evaluateEmailAttachment({
      filename: 'details.txt',
      mimeType: 'text/plain',
      size: 2048,
      emailSender: 'mailer-daemon@googlemail.com',
      emailSubject: 'Delivery Status Notification (Failure)',
    });
    assert.equal(res.disposition, 'EXCLUDE');
    assert.match(res.reason, /bounce/i);
  });

  it('excludes signature images, company logos and icons', () => {
    const res1 = evaluateEmailAttachment({
      filename: 'image001.png',
      mimeType: 'image/png',
      size: 4500,
      emailSubject: 'Re: Quotation',
    });
    assert.equal(res1.disposition, 'EXCLUDE');

    const res2 = evaluateEmailAttachment({
      filename: 'company_logo.jpg',
      mimeType: 'image/jpeg',
      size: 12000,
      emailSubject: 'Partnership',
    });
    assert.equal(res2.disposition, 'EXCLUDE');

    const res3 = evaluateEmailAttachment({
      filename: 'linkedin_icon.png',
      mimeType: 'image/png',
      size: 1200,
    });
    assert.equal(res3.disposition, 'EXCLUDE');
  });

  it('excludes tracking pixels and miniature files <= 1.5 KB', () => {
    const res = evaluateEmailAttachment({
      filename: 'pixel.gif',
      mimeType: 'image/gif',
      size: 43,
      emailSubject: 'Marketing update',
    });
    assert.equal(res.disposition, 'EXCLUDE');
  });

  it('excludes telecom bills and utility invoices', () => {
    const res = evaluateEmailAttachment({
      filename: '2024pmkeuangan131.pdf',
      mimeType: 'application/pdf',
      size: 398305,
      emailSubject: 'Informasi Tagihan Telkom Bulan Oktober 2026',
    });
    assert.equal(res.disposition, 'EXCLUDE');
    assert.match(res.reason, /utility/i);
  });

  it('excludes video/multimedia files (e.g. Capsule.mp4)', () => {
    const res = evaluateEmailAttachment({
      filename: 'Capsule.mp4',
      mimeType: 'video/mp4',
      size: 16176405,
      emailSubject: 'Partnership Proposal',
    });
    assert.equal(res.disposition, 'EXCLUDE');
    assert.match(res.reason, /multimedia/i);
  });

  it('prioritises pharmaceutical certificates: COA, MSDS, GMP, SPEC, TDS, Halal, DMF', () => {
    const coa = evaluateEmailAttachment({
      filename: 'COA_Lactose_Monohydrate_200Mesh.pdf',
      mimeType: 'application/pdf',
      size: 501669,
      emailSubject: 'RE: Lactose Monohydrate COA',
    });
    assert.equal(coa.disposition, 'STORE_AUTOMATICALLY');
    assert.equal(coa.documentType, 'COA');

    const msds = evaluateEmailAttachment({
      filename: 'Paracetamol_MSDS_Rev4.pdf',
      mimeType: 'application/pdf',
      size: 340000,
    });
    assert.equal(msds.disposition, 'STORE_AUTOMATICALLY');
    assert.equal(msds.documentType, 'MSDS');

    const gmp = evaluateEmailAttachment({
      filename: 'GMP_Certificate_Wuhan_2026.pdf',
      mimeType: 'application/pdf',
      size: 850000,
    });
    assert.equal(gmp.disposition, 'STORE_AUTOMATICALLY');
    assert.equal(gmp.documentType, 'GMP');

    const spec = evaluateEmailAttachment({
      filename: 'Technical_Specification_Metformin_USP.pdf',
      mimeType: 'application/pdf',
      size: 210000,
    });
    assert.equal(spec.disposition, 'STORE_AUTOMATICALLY');
    assert.equal(spec.documentType, 'SPEC');
  });

  it('prioritises product catalogues and pricelists', () => {
    const cat = evaluateEmailAttachment({
      filename: 'Vasudha_Pharma_Product_Catalog_2026.pdf',
      mimeType: 'application/pdf',
      size: 7116529,
      emailSubject: 'Introductory mail from Vasudha Pharma',
    });
    assert.equal(cat.disposition, 'STORE_AUTOMATICALLY');
    assert.equal(cat.documentType, 'PRODUCT_CATALOGUE');

    const price = evaluateEmailAttachment({
      filename: 'Invertin_Price_List_2026.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 55000,
    });
    assert.equal(price.disposition, 'STORE_AUTOMATICALLY');
    assert.equal(price.documentType, 'PRICE_LIST');
  });

  it('correctly classifies purchase orders without labeling as OTHER or technical doc', () => {
    const po = evaluateEmailAttachment({
      filename: 'PO 1305.pdf',
      mimeType: 'application/pdf',
      size: 342479,
      emailSubject: 'PO 1305/SB/BB/11/26 (DOMPERIDONE MALEATE)',
      emailSender: 'rmp2.admin@sanbe-farma.com',
    });
    assert.equal(po.disposition, 'STORE_AUTOMATICALLY');
    assert.equal(po.documentType, 'PURCHASE_ORDER');
  });

  it('excludes invertin_logo.png and large image001.png signature files', () => {
    const logo = evaluateEmailAttachment({
      filename: 'invertin_logo.png',
      mimeType: 'image/png',
      size: 14888,
      emailSubject: 'Attn: Mr. Kunal Lunkad – Ingredients Rare in the Indonesian Market',
    });
    assert.equal(logo.disposition, 'EXCLUDE');

    const image001 = evaluateEmailAttachment({
      filename: 'image001.png',
      mimeType: 'image/png',
      size: 109204,
      emailSubject: 'RE: Paracetamol//Indonesia/PFI NO. 246',
    });
    assert.equal(image001.disposition, 'EXCLUDE');
  });

  it('protects scanned image certificates from being discarded blindly', () => {
    const scannedCoa = evaluateEmailAttachment({
      filename: 'scanned_cert_coa_lot_9921.jpeg',
      mimeType: 'image/jpeg',
      size: 320000,
      emailSubject: 'COA Scan',
    });
    assert.equal(scannedCoa.disposition, 'STORE_AUTOMATICALLY');
    assert.equal(scannedCoa.documentType, 'COA');
    assert.equal(scannedCoa.isImageCertCandidate, true);
  });

  it('queues uncertain general attachments for review before import without auto-uploading', () => {
    const uncertain = evaluateEmailAttachment({
      filename: 'Supplier_Information_Sheet.pdf',
      mimeType: 'application/pdf',
      size: 150000,
      emailSubject: 'Introduction',
      hasMatchedInquiry: false,
    });
    assert.equal(uncertain.disposition, 'REVIEW_BEFORE_IMPORT');
    assert.equal(uncertain.documentType, 'OTHER');
  });
});

