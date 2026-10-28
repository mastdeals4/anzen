import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

test('DCMultiSelect Portal & Overflow Clipping Prevention Architecture', () => {
  const content = fs.readFileSync('src/components/DCMultiSelect.tsx', 'utf8');

  // 1. Verify createPortal is imported and used to escape modal clipping ancestors
  assert.ok(content.includes("import { createPortal } from 'react-dom';"), 'Must import createPortal from react-dom');
  assert.ok(content.includes('createPortal('), 'Must render dropdown panel using createPortal');
  assert.ok(content.includes('document.body'), 'Must attach portal directly to document.body to escape modal overflow clipping');

  // 2. Verify fixed positioning and dynamic bounding rect calculation
  assert.ok(content.includes("position: 'fixed'"), 'Must use fixed positioning for the portalled panel');
  assert.ok(content.includes('getBoundingClientRect()'), "Must use trigger element's getBoundingClientRect() for placement");

  // 3. Verify capture-phase scroll listener for modal scrolling
  assert.ok(content.includes("window.addEventListener('scroll', updateDropdownPosition, true);"), 'Must use capture phase scroll listener to catch modal container scrolling');
  assert.ok(content.includes("window.addEventListener('resize', updateDropdownPosition);"), 'Must listen for window resize');

  // 4. Verify outside click and Escape key dismissal
  assert.ok(content.includes("event.key === 'Escape'"), 'Must close dropdown on Escape key');
  assert.ok(content.includes('handleClickOutside'), 'Must handle outside clicks to close');

  // 5. Verify zIndex and viewport boundary clamping
  assert.ok(content.includes('zIndex: 99999'), 'Must have high z-index to stay above modal backdrop and content');
  assert.ok(content.includes('Math.min(minWidth, maxViewportWidth)'), 'Must clamp width within viewport for mobile/small screen responsiveness');

  // 6. Verify multi-select, select-all, and search features are preserved
  assert.ok(content.includes('toggleSelectAll'), 'Must preserve toggleSelectAll logic');
  assert.ok(content.includes('toggleDC'), 'Must preserve toggleDC logic');
  assert.ok(content.includes('searchTerm'), 'Must preserve search filter functionality');
});
