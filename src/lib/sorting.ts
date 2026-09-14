export type SortDirection = 'asc' | 'desc';
export function sortDirection(value: string | null | undefined, fallback: SortDirection = 'asc'): SortDirection { return value === 'asc' || value === 'desc' ? value : fallback; }
