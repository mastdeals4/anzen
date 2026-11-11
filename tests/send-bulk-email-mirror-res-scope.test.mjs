import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('send-bulk-email: mirrorRes is properly scoped outside try block and safe on mirror failure', () => {
  const code = readFileSync(resolve('supabase/functions/send-bulk-email/index.ts'), 'utf-8');

  // 1. Verify mirrorRes is declared with let outside the try block
  assert.ok(
    /let\s+mirrorRes\s*(:\s*any)?\s*=\s*null\s*;\s*try\s*\{/s.test(code),
    'mirrorRes must be declared outside the try block with let mirrorRes: any = null;'
  );

  // 2. Verify assignment inside try block
  assert.ok(
    /mirrorRes\s*=\s*await\s+mirrorOutboundEmail/s.test(code),
    'mirrorRes must be assigned inside the try block'
  );

  // 3. Verify conversationId in success response safely accesses mirrorRes?.conversationId
  assert.ok(
    code.includes('conversationId: mirrorRes?.conversationId || null'),
    'Success response must safely reference mirrorRes?.conversationId || null'
  );

  // 4. Verify that mirrorOutboundEmail failure is non-blocking (catch block does not rethrow)
  const mirrorCatchBlockMatch = code.match(/catch\s*\(\s*mirrorErr\s*\)\s*\{([^}]+)\}/);
  assert.ok(mirrorCatchBlockMatch, 'Must catch mirrorErr');
  assert.ok(
    !mirrorCatchBlockMatch[1].includes('throw'),
    'mirrorErr catch block must not rethrow so Gmail send remains successful'
  );
});

