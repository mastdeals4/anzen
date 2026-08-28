import { SearchableSelect } from '../SearchableSelect';
import type { ExpenseCategoryDef } from './useExpenseCategories';

/**
 * The single category control for every expense-facing module.  The options
 * come directly from the Finance Category Master hook, including its parent
 * group, so selection behaviour cannot diverge between Expenses and Petty Cash.
 */
interface ExpenseCategorySelectProps {
  value: string;
  onChange: (value: string) => void;
  categories: ExpenseCategoryDef[];
  disabled?: boolean;
  required?: boolean;
  className?: string;
}

/**
 * Canonical active-posting category presentation for native Finance filters.
 * Categories still come exclusively from useExpenseCategories; this merely
 * keeps children under one parent heading for controls that require optgroups.
 */
export function groupExpenseCategories(categories: ExpenseCategoryDef[]): Array<[string, ExpenseCategoryDef[]]> {
  const grouped = new Map<string, ExpenseCategoryDef[]>();
  for (const category of categories) {
    const entries = grouped.get(category.group) || [];
    entries.push(category);
    grouped.set(category.group, entries);
  }
  return [...grouped.entries()].map(([group, entries]) => [
    group,
    [...entries].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)),
  ]);
}

export function ExpenseCategorySelect({
  value,
  onChange,
  categories,
  disabled,
  required,
  className,
}: ExpenseCategorySelectProps) {
  // Keep each parent together before SearchableSelect renders group headers.
  // The source remains the canonical master hook; this is presentation-only
  // ordering so a sort-order change cannot repeat a parent heading.
  const orderedCategories = groupExpenseCategories(categories).flatMap(([, entries]) => entries);
  // Historical expenses can retain the archived `utilities` key. Keep that
  // current value visible while editing without reintroducing it as a choice
  // for a new expense; the database preserves it only for unchanged history.
  const visibleCategories = value === 'utilities' && !orderedCategories.some((category) => category.value === value)
    ? [...orderedCategories, {
      id: 'legacy-utilities',
      value,
      label: 'Utilities (legacy)',
      type: 'operations' as const,
      taxBehavior: 'standard',
      description: 'Historical category retained for existing expenses.',
      requiresContainer: false,
      allowsAccountOverride: false,
      group: 'Historical',
      parentId: null,
      coaAccountId: '',
      sortOrder: Number.MAX_SAFE_INTEGER,
    }]
    : orderedCategories;

  return (
    <SearchableSelect
      value={value}
      onChange={onChange}
      options={visibleCategories.map((category) => ({
        value: category.value,
        label: category.label,
        group: category.group,
      }))}
      placeholder="Select category"
      disabled={disabled}
      required={required}
      className={className}
    />
  );
}
