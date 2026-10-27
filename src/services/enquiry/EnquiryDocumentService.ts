import { supabase } from '../../lib/supabase';
import { RequestValidationError } from './enquiryErrors';

export class EnquiryDocumentService {
  /**
   * Associate an existing crm_product_documents record with an enquiry request.
   * Does NOT touch storage bucket, duplicate files, or change existing metadata.
   */
  static async linkDocumentToRequest(params: {
    document_id: string;
    enquiry_request_id: string;
  }): Promise<void> {
    const { document_id, enquiry_request_id } = params;

    if (!document_id) throw new RequestValidationError('document_id', 'Document ID is required');
    if (!enquiry_request_id) throw new RequestValidationError('enquiry_request_id', 'Request ID is required');

    const { error } = await supabase
      .from('crm_product_documents')
      .update({ enquiry_request_id })
      .eq('id', document_id);

    if (error) throw error;
  }

  /**
   * Disassociate a document from an enquiry request.
   * Does NOT delete the document or affect other inquiry relationships.
   */
  static async unlinkDocumentFromRequest(params: {
    document_id: string;
    enquiry_request_id: string;
  }): Promise<void> {
    const { document_id, enquiry_request_id } = params;

    if (!document_id) throw new RequestValidationError('document_id', 'Document ID is required');

    const { error } = await supabase
      .from('crm_product_documents')
      .update({ enquiry_request_id: null })
      .eq('id', document_id)
      .eq('enquiry_request_id', enquiry_request_id);

    if (error) throw error;
  }

  /**
   * Get all documents linked to an enquiry request.
   */
  static async getDocumentsForRequest(enquiry_request_id: string): Promise<Array<{
    id: string;
    document_type: string;
    display_file_name: string | null;
    original_file_name: string | null;
    storage_path: string;
    created_at: string;
  }>> {
    const { data, error } = await supabase
      .from('crm_product_documents')
      .select('id, document_type, display_file_name, original_file_name, storage_path, created_at')
      .eq('enquiry_request_id', enquiry_request_id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }
}
