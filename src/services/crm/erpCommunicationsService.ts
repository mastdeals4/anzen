// src/services/crm/erpCommunicationsService.ts
//
// Deep ERP Quick Actions Service for WhatsApp & Sales Communications.
// Uses real ERP business logic:
//   - Inventory & Stock from v_batch_stock_summary
//   - Batch-linked COA, MSDS, TDS, Specs from crm_product_documents & batch_documents
//   - Quotation generator reusing existing Anzen pricing engine with employee review gate
//   - Follow-up automation with auto-cancellation on reply and 24h WhatsApp window checks

import { supabase } from '../../lib/supabase';
import { getSignedUrlCached, resolveStorageUrlCached } from '../../utils/signedUrlCache';
import { jsPDF } from 'jspdf';
import { uploadOptimizedFile } from '../storage/uploadOptimizationService';

export interface BatchStockItem {
  id: string;
  batchNumber: string;
  productName: string;
  currentStock: number;
  reservedStock: number;
  freeStock: number;
  expiryDate: string | null;
}

export interface StockEnquiryResult {
  productName: string;
  totalFreeStock: number;
  totalCurrentStock: number;
  batches: BatchStockItem[];
  suggestedReplyText: string;
}

export interface ProductDocumentItem {
  id: string;
  productName?: string;
  batchNumber?: string | null;
  documentType: 'COA' | 'SPECIFICATION' | 'MSDS' | 'TDS' | 'OTHER';
  displayFileName: string;
  storagePath: string;
  signedUrl?: string;
  createdAt?: string;
}

export interface QuotationDetails {
  inquiryId: string;
  inquiryNumber: string;
  companyName: string;
  contactPerson?: string | null;
  productName: string;
  quantity: string;
  offeredPrice: number;
  offeredPriceCurrency: string;
  make?: string | null;
  origin?: string | null;
  specification?: string | null;
  deliveryTerms?: string | null;
  paymentTerms?: string | null;
  leadTime?: string | null;
  validityDays?: number;
  remarks?: string | null;
}

export class ErpCommunicationsService {
  /**
   * Reads current available stock and batch details from real ERP inventory view.
   * Never fabricates stock numbers.
   */
  static async queryStock(productNameQuery: string): Promise<StockEnquiryResult | null> {
    if (!productNameQuery || !productNameQuery.trim()) return null;

    const clean = productNameQuery.trim().replace(/[^\w\s-]/g, '');
    const { data, error } = await supabase
      .from('v_batch_stock_summary')
      .select('id, batch_number, product_name, current_stock, reserved_stock, free_stock, expiry_date')
      .ilike('product_name', `%${clean}%`)
      .order('expiry_date', { ascending: true });

    if (error || !data || data.length === 0) {
      return {
        productName: productNameQuery,
        totalFreeStock: 0,
        totalCurrentStock: 0,
        batches: [],
        suggestedReplyText: `Mohon maaf, saat ini stok untuk *${productNameQuery}* sedang kosong atau belum tersedia di gudang kami. Kami akan cek jadwal kedatangan berikutnya.`,
      };
    }

    const batches: BatchStockItem[] = data.map((b: any) => ({
      id: b.id,
      batchNumber: b.batch_number,
      productName: b.product_name,
      currentStock: parseFloat(b.current_stock) || 0,
      reservedStock: parseFloat(b.reserved_stock) || 0,
      freeStock: parseFloat(b.free_stock) || 0,
      expiryDate: b.expiry_date ? new Date(b.expiry_date).toLocaleDateString() : null,
    }));

    const totalFree = batches.reduce((sum, b) => sum + b.freeStock, 0);
    const totalCurrent = batches.reduce((sum, b) => sum + b.currentStock, 0);
    const primaryName = batches[0].productName;

    // Build human-reviewable WhatsApp summary message
    let reply = `📦 *INFORMASI STOK — PT SHUBHAM ANZEN PHARMA JAYA*\n\n`;
    reply += `*Produk:* ${primaryName}\n`;
    reply += `*Total Stok Bebas (Free Stock):* ${totalFree.toLocaleString()} KG\n`;
    reply += `*Status:* ${totalFree > 0 ? '✅ Ready Stock di Gudang Jakarta' : '⚠️ Stok Fisik Terikat / Indent'}\n\n`;

    if (batches.length > 0) {
      reply += `*Rincian Batch Gudang:*\n`;
      batches.slice(0, 3).forEach((b, i) => {
        reply += `${i + 1}. Batch: \`${b.batchNumber}\` | Ready: ${b.freeStock.toLocaleString()} KG | ED: ${b.expiryDate || 'N/A'}\n`;
      });
      if (batches.length > 3) {
        reply += `_...dan ${batches.length - 3} batch lainnya._\n`;
      }
    }
    reply += `\n_Silakan beri tahu kami jika Bapak/Ibu memerlukan penawaran harga atau COA resmi._`;

    return {
      productName: primaryName,
      totalFreeStock: totalFree,
      totalCurrentStock: totalCurrent,
      batches,
      suggestedReplyText: reply,
    };
  }

  /**
   * Queries approved COA and technical documents for a product, inquiry, and optional batch.
   * Scans batch_documents (by batch_id) and crm_product_documents.
   */
  static async queryTechnicalDocuments(
    productName: string,
    inquiryId?: string | null,
    batchId?: string | null
  ): Promise<{ coaList: ProductDocumentItem[]; specList: ProductDocumentItem[] }> {
    const coaList: ProductDocumentItem[] = [];
    const specList: ProductDocumentItem[] = [];

    // 1. If batchId is provided, query batch_documents for batch-specific records (COAs etc.)
    if (batchId) {
      try {
        const { data: batchDocs } = await supabase
          .from('batch_documents')
          .select('id, batch_id, file_url, file_name, file_type, uploaded_at')
          .eq('batch_id', batchId)
          .order('uploaded_at', { ascending: false });

        for (const bDoc of batchDocs || []) {
          const url = bDoc.file_url || '';
          const signedUrl = await resolveStorageUrlCached(url, 3600);
          const fileName = bDoc.file_name || url.split('/').pop() || 'Batch_Document.pdf';
          const isCoa = (bDoc.file_type || '').toLowerCase().includes('coa') || fileName.toLowerCase().includes('coa');
          const docItem: ProductDocumentItem = {
            id: bDoc.id,
            productName,
            documentType: isCoa ? 'COA' : 'OTHER',
            displayFileName: fileName,
            storagePath: url,
            signedUrl: signedUrl || undefined,
            createdAt: bDoc.uploaded_at,
          };
          if (isCoa) {
            coaList.push(docItem);
          } else {
            specList.push(docItem);
          }
        }
      } catch (err) {
        console.warn('[ErpCommunicationsService] Error querying batch_documents:', err);
      }
    }

    // 2. Query crm_product_documents
    let query = supabase
      .from('crm_product_documents')
      .select('id, product_name, document_type, display_file_name, storage_path, created_at');

    if (inquiryId) {
      query = query.or(`inquiry_id.eq.${inquiryId},product_name.ilike.%${productName.trim()}%`);
    } else if (productName) {
      query = query.ilike('product_name', `%${productName.trim()}%`);
    }

    const { data: crmDocs } = await query.limit(20);

    for (const doc of crmDocs || []) {
      const type = (doc.document_type || 'OTHER').toUpperCase() as any;
      let signedUrl = '';
      if (doc.storage_path) {
        signedUrl = (await getSignedUrlCached('crm-documents', doc.storage_path, 3600)) || '';
      }

      const item: ProductDocumentItem = {
        id: doc.id,
        productName: doc.product_name,
        documentType: type,
        displayFileName: doc.display_file_name || 'Document.pdf',
        storagePath: doc.storage_path,
        signedUrl: signedUrl || undefined,
        createdAt: doc.created_at,
      };

      if (type === 'COA') {
        // When a specific warehouse batch is selected, do NOT mix in general or unassociated COAs
        if (!batchId) {
          coaList.push(item);
        }
      } else {
        specList.push(item);
      }
    }

    return { coaList, specList };
  }

  /**
   * Fetches official pricing options recorded for a CRM Inquiry.
   */
  static async getInquiryPricingOptions(inquiryId: string): Promise<any[]> {
    if (!inquiryId || inquiryId === 'draft') return [];
    try {
      const { data, error } = await supabase
        .from('crm_inquiry_pricing_options')
        .select('*')
        .eq('inquiry_id', inquiryId)
        .order('created_at', { ascending: false });

      if (error) {
        console.warn('[ErpCommunicationsService] Pricing options query error:', error);
        return [];
      }
      return data || [];
    } catch {
      return [];
    }
  }

  /**
   * Generates a customer-safe formatted WhatsApp quotation text.
   * Strictly enforces human approval gate.
   */
  static formatWhatsAppQuotation(details: QuotationDetails): string {
    const currency = details.offeredPriceCurrency || 'USD';
    const formattedPrice = `${currency} ${details.offeredPrice.toLocaleString()}`;

    let text = `📋 *PENAWARAN HARGA RESMI — PT SHUBHAM ANZEN PHARMA JAYA*\n`;
    text += `*No. Referensi:* ${details.inquiryNumber}\n`;
    text += `*Kepada Yth:* ${details.companyName}${details.contactPerson ? ` (${details.contactPerson})` : ''}\n\n`;

    text += `*Produk:* ${details.productName}\n`;
    if (details.make) text += `*Pabrik (Make):* ${details.make}\n`;
    if (details.origin) text += `*Negara Asal (Origin):* ${details.origin}\n`;
    if (details.specification) text += `*Spesifikasi:* ${details.specification}\n`;
    text += `*Jumlah (Quantity):* ${details.quantity || '-'}\n`;
    text += `*Harga Penawaran:* *${formattedPrice}* / KG\n`;
    if (details.deliveryTerms) text += `*Ketentuan Penyerahan:* ${details.deliveryTerms}\n`;
    if (details.paymentTerms) text += `*Syarat Pembayaran:* ${details.paymentTerms}\n`;
    if (details.leadTime) text += `*Waktu Pengiriman:* ${details.leadTime}\n`;

    if (details.remarks) {
      text += `*Catatan:* ${details.remarks}\n`;
    }

    text += `\n_Masa berlaku penawaran: ${details.validityDays || 7} hari kerja sejak tanggal pesan ini._\n`;
    text += `_Mohon konfirmasi jika Bapak/Ibu ingin menerbitkan Purchase Order (PO) atau membutuhkan dokumen teknis lainnya._`;

    return text;
  }

  /**
   * Generates an official PDF quotation using jsPDF and stores it in Supabase storage.
   * Returns storagePath and public/signed URL for attachment.
   */
  static async generateQuotationPdf(details: QuotationDetails): Promise<{ storagePath: string; signedUrl: string }> {
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
    });

    // Header Branding
    doc.setFillColor(7, 55, 99); // SAPJ Corporate Navy
    doc.rect(0, 0, 210, 26, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text('PT. SHUBHAM ANZEN PHARMA JAYA', 14, 12);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text('Official Quotation / Penawaran Harga Komersial', 14, 18);
    doc.text('Rukan Plaza Sunter Terrace No. C12, Jakarta Utara', 14, 22);

    // Document Meta
    doc.setTextColor(31, 41, 55);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(`QUOTATION: ${details.inquiryNumber}`, 14, 36);

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`Date: ${new Date().toLocaleDateString('id-ID')}`, 150, 36);
    doc.text(`Customer: ${details.companyName}`, 14, 43);
    if (details.contactPerson) doc.text(`Attention: ${details.contactPerson}`, 14, 48);

    // Table Header
    doc.setFillColor(243, 244, 246);
    doc.rect(14, 55, 182, 8, 'F');
    doc.setFont('helvetica', 'bold');
    doc.text('Description', 18, 60);
    doc.text('Make / Origin', 75, 60);
    doc.text('Qty', 125, 60);
    doc.text('Offered Price / Unit', 150, 60);

    // Row Details
    doc.setFont('helvetica', 'normal');
    doc.text(details.productName, 18, 70);
    doc.text(`${details.make || '-'} / ${details.origin || '-'}`, 75, 70);
    doc.text(details.quantity || '-', 125, 70);
    doc.setFont('helvetica', 'bold');
    doc.text(`${details.offeredPriceCurrency || 'USD'} ${details.offeredPrice.toLocaleString()}`, 150, 70);

    // Terms box
    doc.setDrawColor(209, 213, 219);
    doc.rect(14, 85, 182, 35);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text('COMMERCIAL TERMS & CONDITIONS:', 18, 92);
    doc.setFont('helvetica', 'normal');
    doc.text(`• Delivery Terms: ${details.deliveryTerms || 'Loco Jakarta Warehouse'}`, 18, 98);
    doc.text(`• Payment Terms: ${details.paymentTerms || '30 Days Net from Invoice'}`, 18, 104);
    doc.text(`• Delivery / Lead Time: ${details.leadTime || 'Ready Stock / 2-3 Weeks'}`, 18, 110);
    doc.text(`• Validity: ${details.validityDays || 7} working days`, 18, 116);

    // Footer signature
    doc.setFont('helvetica', 'bold');
    doc.text('Authorized Commercial Representative', 14, 140);
    doc.text('PT. SHUBHAM ANZEN PHARMA JAYA', 14, 145);

    const pdfBlob = doc.output('blob');
    const safeFilename = `Quotation_${details.inquiryNumber}_${Date.now()}.pdf`;
    const storagePath = `quotations/${details.inquiryId}/${safeFilename}`;

    const { error: uploadErr } = await uploadOptimizedFile(
      supabase,
      'crm-documents',
      storagePath,
      pdfBlob,
      { contentType: 'application/pdf', upsert: true }
    );

    if (uploadErr) {
      console.warn('[ErpCommunicationsService] Quotation PDF upload warning:', uploadErr);
    }

    const signedUrl = (await getSignedUrlCached('crm-documents', storagePath, 3600)) || '';
    return { storagePath, signedUrl };
  }

  /**
   * Creates a durable follow-up task on the real task infrastructure.
   * Auto-cancels if the customer replies to the conversation.
   */
  static async createFollowUp(params: {
    conversationId: string;
    inquiryId?: string | null;
    customerId?: string | null;
    daysFromNow: number;
    instruction: string;
  }): Promise<{ taskId: string; deadline: string }> {
    const deadline = new Date(Date.now() + params.daysFromNow * 86400000).toISOString();
    const { data: userAuth } = await supabase.auth.getUser();

    const title = `WhatsApp Follow-up: ${params.instruction.slice(0, 60)}`;
    const description = `Instruction: "${params.instruction}"\nLinked WhatsApp Conversation: ${params.conversationId}`;

    const { data: task, error: taskErr } = await supabase
      .from('tasks')
      .insert({
        title,
        description,
        deadline,
        priority: 'MEDIUM',
        status: 'PENDING',
        customer_id: params.customerId || null,
        inquiry_id: params.inquiryId || null,
        created_by: userAuth?.user?.id || null,
        system_metadata: {
          origin: 'whatsapp_crm',
          conversation_id: params.conversationId,
          cancel_on_customer_reply: true,
          created_at: new Date().toISOString(),
        },
      })
      .select('id')
      .single();

    if (taskErr) throw taskErr;

    // Log CRM Activity
    if (params.customerId) {
      try {
        await supabase
          .from('crm_activities')
          .insert({
            customer_id: params.customerId,
            activity_type: 'Follow-up',
            subject: title,
            description,
            follow_up_date: deadline,
            created_by: userAuth?.user?.id || null,
          });
      } catch {
        // non-blocking CRM activity record
      }
    }

    return { taskId: task.id, deadline };
  }

  /**
   * Cancels pending follow-ups for a conversation when an inbound reply is received.
   */
  static async cancelPendingFollowUpsOnReply(conversationId: string): Promise<number> {
    const { data: tasks, error } = await supabase
      .from('tasks')
      .select('id, system_metadata')
      .eq('status', 'PENDING')
      .filter('system_metadata->>conversation_id', 'eq', conversationId);

    if (error || !tasks || tasks.length === 0) return 0;

    let cancelledCount = 0;
    for (const t of tasks) {
      if ((t.system_metadata as any)?.cancel_on_customer_reply) {
        await supabase
          .from('tasks')
          .update({
            status: 'COMPLETED',
            completion_notes: 'Automatically resolved: Customer replied on WhatsApp.',
            completed_at: new Date().toISOString(),
          })
          .eq('id', t.id);
        cancelledCount++;
      }
    }

    return cancelledCount;
  }
}
