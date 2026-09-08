import { describe, expect, it } from 'vitest';
import { buildOrgTree, type AccountPerson } from '@/lib/accounts-query';

function person(id: string, reportsToId: string | null, name = id): AccountPerson {
  return {
    id,
    name,
    jobTitle: null,
    email: null,
    reportsToId,
    accountRole: 'UNKNOWN',
    relationshipNote: null,
    dnd: false,
    optedOut: false,
    podOwner: null,
    ownerName: null,
    tier: null,
    contactType: [],
    listCategory: null,
    nextAction: null,
    nextActionDueDate: null,
    enrollment: null,
    lastTouchAt: null,
    touches: 0,
  };
}

const ids = (nodes: Array<{ person: AccountPerson }>) => nodes.map((n) => n.person.id);

describe('buildOrgTree', () => {
  it('nests reports under their manager', () => {
    const { roots, orphans } = buildOrgTree([person('ceo', null), person('vp', 'ceo'), person('mgr', 'vp')]);
    expect(ids(roots)).toEqual(['ceo']);
    expect(ids(roots[0].children)).toEqual(['vp']);
    expect(ids(roots[0].children[0].children)).toEqual(['mgr']);
    expect(orphans).toEqual([]);
  });

  it('keeps several roots when an account has parallel chains', () => {
    const { roots } = buildOrgTree([person('a', null), person('a2', 'a'), person('b', null), person('b2', 'b')]);
    expect(ids(roots)).toEqual(['a', 'b']);
  });

  it('separates people with no manager and no reports as unplaced', () => {
    const { roots, orphans } = buildOrgTree([person('ceo', null), person('vp', 'ceo'), person('lonely', null)]);
    expect(ids(roots)).toEqual(['ceo']);
    expect(orphans.map((p) => p.id)).toEqual(['lonely']);
  });

  it('treats a manager outside this account as no manager', () => {
    const { roots, orphans } = buildOrgTree([person('x', 'somebody-at-another-firm')]);
    expect(roots).toEqual([]);
    expect(orphans.map((p) => p.id)).toEqual(['x']);
  });

  it('does not hang or lose people on a cycle', () => {
    const { roots, orphans } = buildOrgTree([person('a', 'b'), person('b', 'c'), person('c', 'a')]);
    const flat: string[] = [];
    const walk = (list: typeof roots) => list.forEach((n) => (flat.push(n.person.id), walk(n.children)));
    walk(roots);
    expect([...flat, ...orphans.map((p) => p.id)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('ignores someone set as their own manager', () => {
    const { roots, orphans } = buildOrgTree([person('self', 'self'), person('kid', 'self')]);
    expect(ids(roots)).toEqual(['self']);
    expect(ids(roots[0].children)).toEqual(['kid']);
    expect(orphans).toEqual([]);
  });

  it('orders the widest branch first, then by name', () => {
    const { roots } = buildOrgTree([
      person('one', null, 'One'),
      person('two', null, 'Two'),
      person('kid-a', 'two'),
      person('kid-b', 'two'),
      person('only', 'one'),
    ]);
    expect(ids(roots)).toEqual(['two', 'one']);
  });

  it('handles an empty account', () => {
    expect(buildOrgTree([])).toEqual({ roots: [], orphans: [] });
  });
});
