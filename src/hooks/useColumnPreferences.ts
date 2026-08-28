import { useCallback, useEffect, useMemo, useState } from 'react';

export interface TableColumn {
  key: string;
  label: string;
  width: number;
  minWidth?: number;
  required?: boolean;
  visible?: boolean;
}

export function useColumnPreferences(storageKey: string, columns: TableColumn[]) {
  const widthKey = `${storageKey}_widths`;
  const visibilityKey = `${storageKey}_visibility`;

  const defaultWidths = useMemo(
    () => Object.fromEntries(columns.map(column => [column.key, column.width])),
    [columns],
  );
  const defaultVisibility = useMemo(
    () => Object.fromEntries(columns.map(column => [column.key, column.visible !== false])),
    [columns],
  );

  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try {
      return { ...defaultWidths, ...JSON.parse(localStorage.getItem(widthKey) || '{}') };
    } catch {
      return defaultWidths;
    }
  });

  const [visibility, setVisibility] = useState<Record<string, boolean>>(() => {
    try {
      return { ...defaultVisibility, ...JSON.parse(localStorage.getItem(visibilityKey) || '{}') };
    } catch {
      return defaultVisibility;
    }
  });

  const [resizing, setResizing] = useState<{ key: string; startX: number; startWidth: number; minWidth: number } | null>(null);

  useEffect(() => {
    localStorage.setItem(widthKey, JSON.stringify(widths));
  }, [widthKey, widths]);

  useEffect(() => {
    localStorage.setItem(visibilityKey, JSON.stringify(visibility));
  }, [visibilityKey, visibility]);

  useEffect(() => {
    if (!resizing) return;

    const onMove = (event: MouseEvent) => {
      const nextWidth = Math.max(resizing.minWidth, resizing.startWidth + event.clientX - resizing.startX);
      setWidths(current => ({ ...current, [resizing.key]: nextWidth }));
    };
    const onUp = () => setResizing(null);

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [resizing]);

  const visibleColumns = useMemo(
    () => columns.filter(column => visibility[column.key] !== false || column.required),
    [columns, visibility],
  );

  const isVisible = useCallback((key: string) => visibility[key] !== false || columns.find(column => column.key === key)?.required, [columns, visibility]);

  const toggleColumn = useCallback((key: string) => {
    const column = columns.find(item => item.key === key);
    if (column?.required) return;
    setVisibility(current => ({ ...current, [key]: !(current[key] !== false) }));
  }, [columns]);

  const reset = useCallback(() => {
    setWidths(defaultWidths);
    setVisibility(defaultVisibility);
  }, [defaultVisibility, defaultWidths]);

  const getCellStyle = useCallback((key: string) => {
    const width = widths[key] ?? defaultWidths[key] ?? 120;
    return { width, minWidth: width };
  }, [defaultWidths, widths]);

  const startResize = useCallback((key: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const column = columns.find(item => item.key === key);
    setResizing({
      key,
      startX: event.clientX,
      startWidth: widths[key] ?? column?.width ?? 120,
      minWidth: column?.minWidth ?? 70,
    });
  }, [columns, widths]);

  return {
    columns,
    visibleColumns,
    visibility,
    widths,
    isVisible,
    toggleColumn,
    reset,
    getCellStyle,
    startResize,
  };
}
