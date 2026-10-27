/**
 * uiTokens.ts — single source of truth for Finance module density.
 *
 * Every screen (Purchase, Payment, Receipt, Contra, Expenses, Petty Cash,
 * Journal, Ledger, Bank Ledger, Party Ledger, Bank Reconciliation, Reports)
 * should compose UI from these tokens so spacing, font size, row height,
 * badge size and icon spacing all match.
 *
 * DO NOT tune these numbers per-screen — if a page needs a different look,
 * fix the token here so every other page picks it up.
 *
 * All classes are Tailwind utility strings and are safe to concatenate.
 */

// ═══════════════════════════════════════════════════════════════════════════
// FINANCE TYPOGRAPHY — exactly four levels. No screen may introduce its own.
// ═══════════════════════════════════════════════════════════════════════════
//
// 1. TITLE  — the page title / KPI header row title.
// 2. HEAD   — section headers inside a card or above a table.
// 3. LABEL  — field labels, KPI captions, subtle secondary text.
// 4. VALUE  — the actual data, whether text or numbers.
//
// Numbers ALWAYS use TYPE_NUM (font-mono, right-aligned, no locale weirdness).
// Keep these levels stable across Finance. Individual pages may arrange them
// differently, but must not invent competing control or status geometry.
export const TYPE_TITLE = 'text-lg font-semibold text-gray-900';
export const TYPE_HEAD  = 'text-sm font-semibold text-gray-700';
export const TYPE_LABEL = 'text-xs font-medium text-gray-600';
export const TYPE_VALUE = 'text-sm text-gray-800';
export const TYPE_NUM   = 'text-sm font-mono text-right text-gray-900 tabular-nums';
export const TYPE_MUTED = 'text-xs text-gray-500';

// Shared geometry. These are exported separately so components can compose
// them without re-declaring subtly different heights, radii, and focus rings.
export const CONTROL_HEIGHT = 'h-9';
export const BUTTON_HEIGHT = 'h-9';
export const CONTROL_RADIUS = 'rounded-md';
export const CONTROL_FOCUS = 'focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500';

// ─── Page shell ────────────────────────────────────────────────────────────
export const PAGE_SPACE = 'space-y-4';

/**
 * @deprecated Use TYPE_HEAD instead.
 * Kept temporarily so existing imports continue to compile.
 */
export const SECTION_HEADER = TYPE_HEAD;
/**
 * @deprecated Use TYPE_TITLE instead.
 */
export const SECTION_TITLE = TYPE_TITLE;

// ─── Toolbar ───────────────────────────────────────────────────────────────
export const TOOLBAR = 'flex flex-wrap items-center gap-2';
export const TOOLBAR_INPUT = `${BUTTON_HEIGHT} px-3 text-sm border border-gray-300 ${CONTROL_RADIUS} bg-white ${CONTROL_FOCUS}`;
export const TOOLBAR_SELECT = TOOLBAR_INPUT;

// ─── Buttons (minimum 38px in the Finance module) ──────────────────────────
export const BTN_BASE = `inline-flex shrink-0 items-center justify-center gap-2 ${BUTTON_HEIGHT} min-h-[38px] px-4 text-sm font-medium leading-none ${CONTROL_RADIUS} border transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed`;
export const BTN_PRIMARY = `${BTN_BASE} bg-blue-600 border-blue-600 text-white hover:bg-blue-700`;
export const BTN_SECONDARY = `${BTN_BASE} bg-white border-gray-300 text-gray-700 hover:bg-gray-50`;
export const BTN_DANGER = `${BTN_BASE} bg-white border-red-300 text-red-700 hover:bg-red-50`;
export const BTN_SUCCESS = `${BTN_BASE} bg-white border-green-300 text-green-700 hover:bg-green-50`;
export const BTN_GHOST = `${BTN_BASE} border-transparent text-gray-700 hover:bg-gray-100`;

// Icon-only variant (view/edit/delete in action columns)
export const ICON_BTN = 'inline-flex shrink-0 items-center justify-center w-9 h-9 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 transition-colors';
export const ICON_BTN_DANGER = 'inline-flex shrink-0 items-center justify-center w-9 h-9 rounded-md text-red-500 hover:bg-red-50 hover:text-red-700 transition-colors';
export const ICON_BTN_SUCCESS = 'inline-flex shrink-0 items-center justify-center w-9 h-9 rounded-md text-green-600 hover:bg-green-50 hover:text-green-800 transition-colors';
export const ICON_BTN_INFO = 'inline-flex shrink-0 items-center justify-center w-9 h-9 rounded-md text-blue-600 hover:bg-blue-50 hover:text-blue-800 transition-colors';
export const ICON_SIZE = 'w-4 h-4';
export const ICON_ROW_GAP = 'gap-1';

// ─── Table (ONE readable style everywhere) ─────────────────────────────────
export const TABLE = 'w-full text-sm border-collapse';
export const THEAD = 'bg-gray-50 border-b border-gray-200';
export const TH = 'h-11 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 px-3 py-2 whitespace-nowrap';
export const TH_RIGHT = 'h-11 text-right text-xs font-semibold uppercase tracking-wide text-gray-600 px-3 py-2 whitespace-nowrap';
export const TR = 'border-b border-gray-100 hover:bg-blue-50/40 transition-colors';
export const TR_SELECTED = 'border-b border-gray-100 bg-blue-50 hover:bg-blue-100';
export const TD = 'px-3 py-2 text-gray-800';
export const TD_RIGHT = 'px-3 py-2 text-right font-mono text-gray-800';
export const TD_NUM = 'px-3 py-2 text-right font-mono text-gray-900 whitespace-nowrap';
export const TD_DATE = 'px-3 py-2 text-gray-600 whitespace-nowrap';
export const TD_ACTIONS = 'px-2 py-1 whitespace-nowrap';

// ─── Badges — one size / palette ───────────────────────────────────────────
export const BADGE = 'inline-flex h-6 shrink-0 items-center gap-1 px-2.5 text-xs font-semibold leading-none rounded-full whitespace-nowrap';
export const BADGE_POSTED = `${BADGE} bg-green-100 text-green-700`;
export const BADGE_PENDING = `${BADGE} bg-gray-100 text-gray-600`;
export const BADGE_PARTIAL = `${BADGE} bg-yellow-100 text-yellow-800`;
export const BADGE_APPROVED = `${BADGE} bg-blue-100 text-blue-700`;
export const BADGE_REJECTED = `${BADGE} bg-red-100 text-red-700`;
export const BADGE_LINKED = `${BADGE} bg-green-100 text-green-700`;
export const BADGE_UNLINKED = `${BADGE} bg-orange-100 text-orange-700`;
export const BADGE_INFO = `${BADGE} bg-blue-100 text-blue-700`;
export const BADGE_NEUTRAL = `${BADGE} bg-gray-100 text-gray-600`;
export const BADGE_PAID = `${BADGE} bg-green-100 text-green-700`;
export const BADGE_UNPAID = `${BADGE} bg-red-100 text-red-700`;
export const BADGE_RECONCILED = `${BADGE} bg-teal-100 text-teal-700`;
export const BADGE_DRAFT = `${BADGE} bg-gray-100 text-gray-600`;

// ─── Forms & inputs (identical height everywhere) ──────────────────────────
export const FORM_LABEL = 'block text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-0.5';
export const FORM_HINT = 'text-xs text-gray-500 mt-1';
export const INPUT = `w-full ${CONTROL_HEIGHT} px-2.5 text-[13px] border border-gray-300 ${CONTROL_RADIUS} bg-white ${CONTROL_FOCUS}`;
export const INPUT_MONEY = `${INPUT} text-right font-mono tabular-nums`;
export const SELECT = INPUT;
export const TEXTAREA = `w-full px-3 py-2 text-sm border border-gray-300 ${CONTROL_RADIUS} bg-white ${CONTROL_FOCUS} resize-none`;
export const CHECKBOX = `h-4 w-4 rounded border-gray-300 text-blue-600 ${CONTROL_FOCUS}`;
export const RADIO = `h-4 w-4 border-gray-300 text-blue-600 ${CONTROL_FOCUS}`;

// ─── Summary / total cards ─────────────────────────────────────────────────
export const CARD = 'border border-gray-200 rounded-lg bg-white';
export const CARD_HEADER = 'px-4 py-3 border-b border-gray-100 flex items-center justify-between';
export const CARD_BODY = 'p-4';
export const KPI_LABEL = 'text-xs font-medium text-gray-500';
export const KPI_VALUE = 'text-xl font-mono font-semibold text-gray-900';
