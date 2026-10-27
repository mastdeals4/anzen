/**
 * Helper to safely batch PostgREST / Supabase `.in()` filter queries.
 * PostgREST serializes `.in('col', [uuid, ...])` into URL query string parameters.
 * When the list exceeds ~60-75 UUIDs, the request URL exceeds the 8KB limit of
 * Cloudflare/PostgREST/reverse-proxies, resulting in HTTP 400 Bad Request.
 *
 * This utility divides large ID arrays into concurrent batches using Promise.all.
 */
export const DEFAULT_POSTGREST_BATCH_SIZE = 60;

export async function fetchInBatches<T>(
  ids: Array<string | null | undefined>,
  queryBatch: (batchIds: string[]) => PromiseLike<{ data: T[] | null; error: any }>,
  batchSize: number = DEFAULT_POSTGREST_BATCH_SIZE,
): Promise<T[]> {
  const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (uniqueIds.length === 0) return [];

  const batches: string[][] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += batchSize) {
    batches.push(uniqueIds.slice(offset, offset + batchSize));
  }

  const results = await Promise.all(batches.map(batch => queryBatch(batch)));
  const rows: T[] = [];
  for (const { data, error } of results) {
    if (error) throw error;
    if (data) rows.push(...data);
  }
  return rows;
}
