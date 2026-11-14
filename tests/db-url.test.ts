import { describe, expect, it } from 'vitest';
import { pooledDatabaseUrl } from '@/lib/db';

describe('T20: the pool settings are added to the database address', () => {
  it('uses ? or & as the stored address needs, and never overrides its own settings', () => {
    expect(pooledDatabaseUrl('postgresql://u:p@db:5432/cadence', '6', '20')).toBe('postgresql://u:p@db:5432/cadence?connection_limit=6&pool_timeout=20');
    expect(pooledDatabaseUrl('postgresql://u:p@db:5432/cadence?sslmode=require', '4', '20')).toBe('postgresql://u:p@db:5432/cadence?sslmode=require&connection_limit=4&pool_timeout=20');
    expect(pooledDatabaseUrl('postgresql://u:p@db/c?connection_limit=9', '4', undefined)).toBe('postgresql://u:p@db/c?connection_limit=9');
    expect(pooledDatabaseUrl('postgresql://u:p@db/c', undefined, undefined)).toBe('postgresql://u:p@db/c');
    expect(pooledDatabaseUrl(undefined, '6', '20')).toBeUndefined();
  });
});
