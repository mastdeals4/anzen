import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

test('1. SpeechToTextButton component exists and uses Web Speech Recognition API', () => {
  const componentPath = path.join(process.cwd(), 'src/components/crm/SpeechToTextButton.tsx');
  assert.ok(fs.existsSync(componentPath), 'SpeechToTextButton.tsx must exist');
  const src = fs.readFileSync(componentPath, 'utf-8');

  assert.match(src, /SpeechRecognition|webkitSpeechRecognition/, 'Must support standard SpeechRecognition API');
  assert.match(src, /onTranscript/, 'Must provide onTranscript callback');
  assert.match(src, /isListening/, 'Must handle listening state');
});

test('2. Speech-to-text dictation is integrated into Customer and Inquiry note logging', () => {
  const custDrawer = fs.readFileSync(path.join(process.cwd(), 'src/components/crm/customers/CrmCustomerDrawer.tsx'), 'utf-8');
  const inqDrawer = fs.readFileSync(path.join(process.cwd(), 'src/components/crm/inquiries/CrmInquiryDrawer.tsx'), 'utf-8');

  assert.match(custDrawer, /SpeechToTextButton/, 'Customer drawer must integrate SpeechToTextButton');
  assert.match(inqDrawer, /SpeechToTextButton/, 'Inquiry drawer must integrate SpeechToTextButton');
});

