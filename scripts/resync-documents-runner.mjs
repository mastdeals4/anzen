// Automated Document Recovery Runner
// Loops through sapj-gmail-agent resync batches until all historical attachments are recovered and verified.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://dkrtsqienlhpouohmfki.supabase.co';
const CRON_SECRET = 'sapj-internal-cron-trigger';

async function runResync() {
  console.log('Starting automated document re-sync across historical Gmail attachments...');
  let offset = 0;
  let hasMore = true;
  let batchNum = 1;
  let finalReport = null;

  while (hasMore) {
    console.log(`\n--- Running Batch ${batchNum} (offset: ${offset}) ---`);
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/sapj-gmail-agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Secret': CRON_SECRET,
      },
      body: JSON.stringify({
        resyncDocuments: true,
        reviewOffset: offset,
        reviewLimit: 2,
        maxDownloads: 3,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`Batch ${batchNum} HTTP error (${resp.status}):`, errText);
      break;
    }

    const data = await resp.json();
    console.log(`Batch ${batchNum} completed:`, {
      has_more: data.has_more,
      next_offset: data.next_offset,
      stored_so_far: data.documents_actually_stored,
      linked_so_far: data.documents_successfully_linked,
      needing_resync: data.documents_needing_resync,
      unavailable: data.documents_unavailable,
      failures: data.storage_verification_failures,
    });

    finalReport = data;
    if (data.has_more && data.documents_needing_resync > 0) {
      offset = data.next_offset;
      hasMore = true;
      batchNum += 1;
      // Brief pause to be respectful of Gmail API rate limits
      await new Promise(r => setTimeout(r, 600));
    } else {
      hasMore = false;
    }
  }

  console.log('\n======================================================');
  console.log('FINAL RECONCILIATION SUMMARY:');
  console.log('======================================================');
  console.log('Documents detected:              ', finalReport?.documents_detected ?? 'N/A');
  console.log('Documents actually stored:       ', finalReport?.documents_actually_stored ?? 'N/A');
  console.log('Documents successfully linked:   ', finalReport?.documents_successfully_linked ?? 'N/A');
  console.log('Documents needing re-sync:       ', finalReport?.documents_needing_resync ?? 'N/A');
  console.log('Documents unavailable:           ', finalReport?.documents_unavailable ?? 'N/A');
  console.log('Storage verification failures:   ', finalReport?.storage_verification_failures ?? 0);
  console.log('======================================================\n');
}

runResync().catch(console.error);
