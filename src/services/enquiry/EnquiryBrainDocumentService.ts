import { supabase } from '../../lib/supabase';
import { DocumentAiExtraction } from '../../types/enquiry';

export interface ProcessDocumentResult {
  success: boolean;
  document_id?: string;
  cached?: boolean;
  ai_extraction?: DocumentAiExtraction;
  error?: string;
  retryable?: boolean;
}

export class EnquiryBrainDocumentService {
  /**
   * Triggers or retrieves Document Intelligence extraction for a document.
   * Calls edge function `enquiry-brain-document`.
   * Non-authoritative: produces extraction proposal only.
   */
  static async processDocument(
    documentId: string,
    options?: { force?: boolean }
  ): Promise<ProcessDocumentResult> {
    try {
      const { data, error } = await supabase.functions.invoke('enquiry-brain-document', {
        body: {
          document_id: documentId,
          force_reprocess: !!options?.force,
        },
      });

      if (error) {
        return {
          success: false,
          error: error.message || 'Failed to invoke document intelligence',
          retryable: true,
        };
      }

      return data as ProcessDocumentResult;
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Unexpected error processing document',
        retryable: true,
      };
    }
  }

  /**
   * Retrieves current AI extraction for a document.
   */
  static async getExtraction(documentId: string): Promise<DocumentAiExtraction | null> {
    const { data, error } = await supabase
      .from('crm_product_documents')
      .select('ai_extraction')
      .eq('id', documentId)
      .maybeSingle();

    if (error || !data) return null;
    return (data.ai_extraction as DocumentAiExtraction) || null;
  }

  /**
   * Accepts an AI document extraction proposal atomically.
   */
  static async acceptExtraction(
    documentId: string,
    applyToRequestId?: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const authResp = await supabase.auth.getUser();
      const user = authResp.data.user;
      if (!user) throw new Error('Unauthenticated: you must be logged in to accept an extraction');

      const { error } = await supabase.rpc('accept_document_extraction_atomic', {
        p_document_id: documentId,
        p_actor_id: user.id,
        p_apply_to_request_id: applyToRequestId || null,
      });

      if (error) {
        if (error.message?.includes('DOCUMENT_ALREADY_PROCESSED')) {
          return { success: false, error: 'Document extraction has already been reviewed.' };
        }
        throw error;
      }

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to accept document extraction' };
    }
  }

  /**
   * Applies human-edited values to a document extraction proposal atomically.
   * Preserves original AI extraction.
   */
  static async editExtraction(
    documentId: string,
    editedValues: Record<string, unknown>
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const authResp = await supabase.auth.getUser();
      const user = authResp.data.user;
      if (!user) throw new Error('Unauthenticated: you must be logged in to edit an extraction');

      const { error } = await supabase.rpc('edit_document_extraction_atomic', {
        p_document_id: documentId,
        p_actor_id: user.id,
        p_edited_values: editedValues,
      });

      if (error) {
        if (error.message?.includes('DOCUMENT_ALREADY_PROCESSED')) {
          return { success: false, error: 'Document extraction has already been reviewed.' };
        }
        throw error;
      }

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to apply edited document extraction' };
    }
  }

  /**
   * Dismisses a document extraction proposal atomically without mutating business state.
   */
  static async dismissExtraction(documentId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const authResp = await supabase.auth.getUser();
      const user = authResp.data.user;

      const { error } = await supabase.rpc('dismiss_document_extraction_atomic', {
        p_document_id: documentId,
        p_actor_id: user?.id || null,
      });

      if (error) {
        if (error.message?.includes('DOCUMENT_ALREADY_PROCESSED')) {
          return { success: false, error: 'Document extraction has already been reviewed.' };
        }
        throw error;
      }

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to dismiss document extraction' };
    }
  }
}
