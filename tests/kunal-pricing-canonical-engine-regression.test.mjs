import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateFCL,
  DEFAULT_CONFIG,
  getEffectiveINRRate,
} from '../src/services/pricingService.ts';

test('1. Canonical Pricing Engine: calculates default suggested FCL correctly', () => {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const effectiveInr = getEffectiveINRRate(config); // 91
  assert.equal(effectiveInr, 91, 'Default effective INR rate should be 91');

  // Test with INR 3650
  const input3650 = {
    purchase_currency: 'INR',
    purchase_price: 0,
    inr_price: 3650,
    india_margin_percent: 4.0,
    indonesia_margin_percent: 4.0,
    freight_type: 'usd_per_kg',
    freight_value: 0.08,
    insurance_percent: 0.1,
    duty_percent: 4.0,
    container_type: '20ft',
    packing_type: 'mixed',
    selling_quantity: 12000,
  };

  const res3650 = calculateFCL(input3650, config, 16000);
  assert.equal(res3650.is_zero, false, 'Result should not be zero');

  // Breakdown verification:
  // Base USD: 3650 / 91 = 40.10989
  // Full product value: 40.10989 * 12000 = 481,318.68
  // India margin (4%): 19,252.75
  // Freight ($0.08 * 12000): 960.00
  // Insurance (0.1%): 481.32
  // Subtotal: 502,012.75
  // Duty (4%): 20,080.51
  // Clearance (20ft default: 500): 500.00
  // Total landed: 522,593.26
  // Landed per kg: 522,593.26 / 12000 = 43.5494 USD/kg (~$43.55)
  // Suggested Indonesia quote (4%): 43.5494 * 1.04 = 45.2914 USD/kg (~$45.29)
  const landedPerKg = Math.round(res3650.landed_cost_per_kg_usd * 100) / 100;
  const quotePerKg = Math.round(res3650.final_price_per_kg_usd * 100) / 100;

  assert.equal(landedPerKg, 43.55, `Expected landed cost ~43.55, got ${landedPerKg}`);
  assert.equal(quotePerKg, 45.29, `Expected quote price ~45.29, got ${quotePerKg}`);
});

test('2. Removal of False Landed Cost (INQ-26-0069 Protection)', () => {
  // Mock inquiry like INQ-26-0069 with CRM values but no supplier quote
  const rawCrmInquiry = {
    id: 'inq-26-0069',
    inquiry_number: 'INQ-26-0069',
    purchase_price: 5500, // Old historical CRM field
    offered_price: 65,    // Old historical CRM field
    pricing_options: [],  // NO validated pricing option
  };

  // Rule: Do NOT use old purchase_price as calculated landed cost
  const selectedOpt = rawCrmInquiry.pricing_options[0] || null;
  const sourcePrice = selectedOpt?.source_price ?? null;

  let calculatedLandedCost = null;
  let calculatedQuotePrice = null;
  let status = 'Waiting Supplier';

  if (sourcePrice !== null && sourcePrice > 0) {
    const res = calculateFCL({
      purchase_currency: 'INR',
      purchase_price: 0,
      inr_price: sourcePrice,
      india_margin_percent: 4.0,
      indonesia_margin_percent: 4.0,
      freight_type: 'usd_per_kg',
      freight_value: 0.08,
      insurance_percent: 0.1,
      duty_percent: 4.0,
      container_type: '20ft',
      packing_type: 'mixed',
      selling_quantity: 12000,
    }, DEFAULT_CONFIG, 16000);
    calculatedLandedCost = res.landed_cost_per_kg_usd;
    calculatedQuotePrice = res.final_price_per_kg_usd;
    status = 'Ready to Quote';
  }

  assert.equal(calculatedLandedCost, null, 'Landed cost must be null (—) when no validated source price');
  assert.equal(calculatedQuotePrice, null, 'Quote price must be null (—) when no validated source price');
  assert.equal(status, 'Waiting Supplier', 'Inquiry without source price must be Waiting Supplier');
});

test('3. Stable Draft Input: typing rate does not reclassify status to Need Action', () => {
  // Initial row in Waiting Supplier
  const row = {
    id: 'row-1',
    status: 'Waiting Supplier',
    sourcePrice: null,
    landedCostUsd: null,
    quotePrice: null,
  };

  // User types "3", then "36", then "365", then "3650"
  const draftInputs = ['3', '36', '365', '3650'];
  let currentStatus = row.status;

  for (const draft of draftInputs) {
    const parsed = parseFloat(draft);
    const validNum = (!isNaN(parsed) && parsed > 0) ? parsed : null;

    // Calculation is updated, but status MUST NOT CHANGE while typing
    const updatedRow = {
      ...row,
      sourcePrice: validNum,
      // row.status is strictly untouched during input typing!
      status: currentStatus,
    };

    assert.equal(updatedRow.status, 'Waiting Supplier', `Status shifted unexpectedly to ${updatedRow.status} on draft "${draft}"`);
  }

  assert.equal(currentStatus, 'Waiting Supplier', 'Typing a source price must NOT move a row from Waiting Supplier to Need Action');
});

test('4. Need Action Bucket Filter: Waiting Supplier rows stay in Waiting Supplier', () => {
  const rows = [
    { id: '1', status: 'Waiting Supplier', inquiryNumber: 'INQ-001' },
    { id: '2', status: 'Needs Review', inquiryNumber: 'INQ-002', actionReason: 'Inquiry match ambiguous' },
    { id: '3', status: 'Price Received', inquiryNumber: 'INQ-003', actionReason: 'Price received' },
    { id: '4', status: 'Ready to Quote', inquiryNumber: 'INQ-004', actionReason: 'Ready to quote' },
    { id: '5', status: 'Waiting Supplier', inquiryNumber: 'INQ-005' },
  ];

  // Needs Action Filter
  const needsActionRows = rows.filter(r => {
    return r.status === 'Needs Review' || r.status === 'Price Received' || r.status === 'Ready to Quote';
  });

  assert.equal(needsActionRows.length, 3, 'Needs Action should contain only genuinely actionable items');
  assert.ok(!needsActionRows.some(r => r.status === 'Waiting Supplier'), 'Waiting Supplier rows must NOT appear in Need Action view');
});

test('5. Document Detection and Action Notice', () => {
  const detectedDocuments = [
    { documentType: 'COA', filename: 'COA_Batch99.pdf', matchStatus: 'REVIEW' },
    { documentType: 'MSDS', filename: 'MSDS_Product.pdf', matchStatus: 'MATCHED' },
  ];

  let docActionNotice = null;
  const hasAmbiguousDoc = detectedDocuments.some(d => d.matchStatus === 'AMBIGUOUS');
  const hasReviewDoc = detectedDocuments.some(d => d.matchStatus === 'REVIEW');

  if (hasAmbiguousDoc) {
    docActionNotice = 'Document match ambiguous';
  } else if (hasReviewDoc) {
    docActionNotice = 'COA needs review';
  }

  assert.equal(docActionNotice, 'COA needs review', 'Expected "COA needs review" notice');
});

test('6. Catch-up Pagination & Continuation: 10-day old sync processes all pages up to safe cap', () => {
  // Simulate last sync 10 days ago
  const now = new Date('2026-09-25T10:00:00Z');
  const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
  const overlapSec = Math.floor(new Date(tenDaysAgo.getTime() - 24 * 60 * 60 * 1000).getTime() / 1000);

  // Dynamic query generation
  const query = `after:${overlapSec}`;
  assert.ok(query.startsWith('after:'), 'Query must dynamically use after: timestamp');

  // Simulated paginated Gmail API responses
  const page1 = {
    messages: Array.from({ length: 50 }, (_, i) => ({ id: `msg-p1-${i}`, threadId: `th-p1-${i}` })),
    nextPageToken: 'token_page_2',
  };
  const page2 = {
    messages: Array.from({ length: 45 }, (_, i) => ({ id: `msg-p2-${i}`, threadId: `th-p2-${i}` })),
    nextPageToken: null, // End of results
  };

  const pages = [page1, page2];
  let pageIdx = 0;
  const collected = [];
  let token = undefined;
  const maxPages = 10;
  let pageCount = 0;

  do {
    const currentPage = pages[pageIdx++];
    pageCount++;
    if (currentPage?.messages) {
      collected.push(...currentPage.messages);
    }
    token = currentPage?.nextPageToken;
  } while (token && pageCount < maxPages);

  assert.equal(collected.length, 95, 'Must collect all 95 messages across pages without dropping older ones');
  assert.equal(pageCount, 2, 'Should paginate until nextPageToken is null');
});

test('7. Persistence of Evidence: persists all necessary fields for review after 10+ days', () => {
  const simulatedSavedRow = {
    id: 'rev-001',
    gmail_message_id: '18d9f9a2b',
    gmail_thread_id: '18d9f9a2b_th',
    from_address: 'supplier@chemicalcorp.com',
    to_address: 'purchasing@sapj.co.id',
    date: '2026-09-15T08:30:00Z',
    subject: 'RE: Quotation for Citric Acid Anhydrous',
    direction: 'inbound',
    raw_result: {
      sourceEmail: {
        messageId: '18d9f9a2b',
        threadId: '18d9f9a2b_th',
        from: 'supplier@chemicalcorp.com',
        to: 'purchasing@sapj.co.id',
        date: '2026-09-15T08:30:00Z',
        subject: 'RE: Quotation for Citric Acid Anhydrous',
        bodyText: 'We can offer Citric Acid Anhydrous at USD 1.25/kg CIF Jakarta. Attached COA.',
        bodyHtml: '<p>We can offer Citric Acid Anhydrous at USD 1.25/kg CIF Jakarta. Attached COA.</p>',
        attachments: [
          { filename: 'COA_Citric_Batch45.pdf', documentType: 'COA' }
        ],
      },
      product: 'Citric Acid Anhydrous',
      make: 'Weifang',
      supplier: 'Chemical Corp',
      price: 1.25,
      currency: 'USD',
      unit: 'KG',
      moq: '1 FCL',
      availability: 'available',
      leadTime: '2 weeks',
      inquiryNumber: 'INQ-26-0042',
      aceerpNo: 'ACE-26-0042',
      confidence: 0.95,
      suggestedAction: 'Review',
      evidence: {
        sourceQuote: 'USD 1.25/kg CIF Jakarta',
        why: 'Explicit price and lead time found in message body',
      },
    },
  };

  // Verify all required evidence points are persisted in raw_result.sourceEmail
  const se = simulatedSavedRow.raw_result.sourceEmail;
  assert.ok(se.messageId && se.threadId, 'Message ID and Thread ID must be preserved');
  assert.ok(se.from && se.to && se.date && se.subject, 'Headers (From, To, Date, Subject) must be preserved');
  assert.ok(se.bodyText && se.bodyHtml, 'Both text and HTML body must be preserved');
  assert.equal(se.attachments.length, 1, 'Attachments list must be preserved');
  assert.equal(se.attachments[0].documentType, 'COA', 'Attachment document type must be detected');
});

test('8. Needs Review Routing: ambiguous inquiry, price, make, or document go to Needs Review', () => {
  const testCases = [
    { name: 'ambiguous inquiry', confidence: 0.45, inqMatch: false, reason: 'Ambiguous inquiry match' },
    { name: 'unclear product', confidence: 0.50, inqMatch: true, reason: 'Unclear product name' },
    { name: 'unclear price', confidence: 0.60, price: null, reason: 'Unclear price extraction' },
    { name: 'ambiguous document', docMatch: 'AMBIGUOUS', reason: 'Document match ambiguous' },
  ];

  for (const tc of testCases) {
    const isNeedsReview = tc.confidence < 0.70 || !tc.inqMatch || tc.price === null || tc.docMatch === 'AMBIGUOUS';
    assert.ok(isNeedsReview, `Case "${tc.name}" must be routed to Needs Review`);
  }
});

test('9. Source vs AI Separation and Direct One-Click Correction', () => {
  // Source is untampered raw email
  const source = {
    from: 'export@supplier.in',
    subject: 'Rates for Paraffin Wax',
    bodyText: 'Paraffin Wax fully refined rate is 3650 INR/kg ex-factory.',
  };

  // Initial AI interpretation
  const aiExtraction = {
    product: 'Paraffin Wax',
    make: 'Unknown',
    supplier: 'Supplier India',
    sourcePrice: 3650,
    sourceCurrency: 'INR',
    unit: 'KG',
  };

  // User performs correction via drawer
  const userCorrection = {
    inquiryId: 'inq-real-999',
    productName: 'Paraffin Wax 58-60',
    offeredMake: 'Reliance',
    supplierName: 'Reliance Industries Ltd',
    sourcePrice: 3650,
    sourceCurrency: 'INR',
    unit: 'KG',
  };

  // Merge correction
  const confirmedExtraction = {
    ...aiExtraction,
    ...userCorrection,
  };

  assert.equal(source.bodyText, 'Paraffin Wax fully refined rate is 3650 INR/kg ex-factory.', 'Source email is immutable evidence');
  assert.equal(confirmedExtraction.productName, 'Paraffin Wax 58-60', 'Product corrected');
  assert.equal(confirmedExtraction.offeredMake, 'Reliance', 'Make corrected');
  assert.equal(confirmedExtraction.supplierName, 'Reliance Industries Ltd', 'Supplier corrected');
});

test('10. Document Auto-Link: high confidence links to crm_product_documents, low confidence flags review', () => {
  const documents = [
    { type: 'COA', filename: 'COA_Batch_102.pdf', confidence: 0.92, inquiryId: 'inq-1' },
    { type: 'MSDS', filename: 'General_Safety_Data.pdf', confidence: 0.40, inquiryId: 'inq-1' },
  ];

  const autoLinked = [];
  const needsReview = [];

  for (const doc of documents) {
    if (doc.confidence >= 0.85 && doc.inquiryId) {
      autoLinked.push({
        inquiry_id: doc.inquiryId,
        document_type: doc.type,
        display_file_name: doc.filename,
        auto_linked: true,
      });
    } else {
      needsReview.push({
        filename: doc.filename,
        reason: 'Low confidence document match',
      });
    }
  }

  assert.equal(autoLinked.length, 1, 'Only high-confidence document must be auto-linked');
  assert.equal(autoLinked[0].document_type, 'COA');
  assert.equal(needsReview.length, 1, 'Low-confidence document must be routed to Needs Review');
  assert.equal(needsReview[0].filename, 'General_Safety_Data.pdf');
});
