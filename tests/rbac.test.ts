import { describe, expect, it } from 'vitest';
import {
  canActOnTask,
  canApproveCampaign,
  canEditSequences,
  canEnroll,
  canManageEnrollment,
  canManagePod,
  canManageSettings,
  canManageUsers,
  canSnoozeFreely,
  canViewReports,
  visiblePodIds,
  canSeeAllPods,
  defaultFilters,
  needsPod,
  type Actor,
} from '@/lib/auth/rbac';

const admin: Actor = { id: 'admin', role: 'ADMIN', podIds: [] };
const leader: Actor = { id: 'leader', role: 'SALES_LEADER', podIds: ['pod-a'] };
const senior: Actor = { id: 'senior', role: 'SENIOR_FO', podIds: ['pod-a'] };
const junior: Actor = { id: 'junior', role: 'JUNIOR_FO', podIds: ['pod-a'] };
const manager: Actor = { id: 'manager', role: 'POD_MANAGER', podIds: ['pod-a'] };
const ops: Actor = { id: 'ops', role: 'BIZ_OPS', podIds: [] };

describe('rbac', () => {
  it('a Pod Manager runs their own pod like a Sales Leader, and no other', () => {
    expect(canManagePod(manager, 'pod-a')).toBe(true);
    expect(canManagePod(manager, 'pod-z')).toBe(false);
    expect(canEnroll(manager, 'pod-a')).toBe(true);
    expect(canApproveCampaign(manager, 'pod-a')).toBe(true);
    expect(canApproveCampaign(manager, 'pod-z')).toBe(false);
    expect(canEditSequences(manager)).toBe(true);
    expect(canViewReports(manager)).toBe(true);
    expect(canManageSettings(manager)).toBe(false);
    expect(canManageUsers(manager)).toBe(false);
    expect(visiblePodIds(manager)).toBeNull(); // reads every pod; runs only pod-a
    expect(needsPod('POD_MANAGER')).toBe(true);
  });
  it('Biz Ops reads every pod and writes to none', () => {
    expect(canSeeAllPods(ops)).toBe(true);
    expect(visiblePodIds(ops)).toBeNull();
    expect(canViewReports(ops)).toBe(true);
    expect(canManagePod(ops, 'pod-a')).toBe(false);
    expect(canEnroll(ops)).toBe(false);
    expect(canEditSequences(ops)).toBe(false);
    expect(canApproveCampaign(ops, 'pod-a')).toBe(false);
    expect(canActOnTask(ops, { foUserId: 'someone', podId: 'pod-a' })).toBe(false);
    expect(canManageSettings(ops)).toBe(false);
    expect(needsPod('BIZ_OPS')).toBe(false);
    expect(defaultFilters(ops)).toEqual({ pod: false, self: false });
    expect(defaultFilters(junior)).toEqual({ pod: true, self: true });
    expect(defaultFilters(senior)).toEqual({ pod: true, self: false });
    expect(defaultFilters(leader)).toEqual({ pod: true, self: false });
  });
  it('admin can do everything', () => {
    expect(canManagePod(admin, 'pod-z')).toBe(true);
    expect(canEditSequences(admin)).toBe(true);
    expect(canManageSettings(admin)).toBe(true);
    expect(canEnroll(admin)).toBe(true);
    expect(visiblePodIds(admin)).toBeNull();
    expect(canActOnTask(admin, { foUserId: 'someone', podId: 'pod-z' })).toBe(true);
  });

  it('senior FO is scoped to own pods', () => {
    expect(canManagePod(senior, 'pod-a')).toBe(true);
    expect(canManagePod(senior, 'pod-b')).toBe(false);
    expect(canEnroll(senior, 'pod-a')).toBe(true);
    expect(canEnroll(senior, 'pod-b')).toBe(false);
    expect(canManageEnrollment(senior, { foUserId: 'junior', podId: 'pod-a' })).toBe(true);
    expect(canManageEnrollment(senior, { foUserId: 'other', podId: 'pod-b' })).toBe(false);
    expect(canActOnTask(senior, { foUserId: 'junior', podId: 'pod-a' })).toBe(true);
    expect(canActOnTask(senior, { foUserId: 'other', podId: 'pod-b' })).toBe(false);
    // A Senior FO runs the outreach for their pod, so they build the sequences it uses.
    // Settings, users and campaign approval stay above them.
    expect(canEditSequences(senior)).toBe(true);
    expect(canViewReports(senior)).toBe(true);
    expect(canManageSettings(senior)).toBe(false);
    expect(canManageUsers(senior)).toBe(false);
    expect(canApproveCampaign(senior, 'pod-a')).toBe(false);
    expect(visiblePodIds(senior)).toBeNull();
  });

  it('a Sales Leader leads their own pods and is the only non-admin who approves a campaign', () => {
    expect(canManagePod(leader, 'pod-a')).toBe(true);
    expect(canManagePod(leader, 'pod-b')).toBe(false);
    expect(canEnroll(leader, 'pod-a')).toBe(true);
    expect(canEditSequences(leader)).toBe(true);
    expect(canViewReports(leader)).toBe(true);
    // Approval is what separates a Sales Leader from a Senior FO.
    expect(canApproveCampaign(leader, 'pod-a')).toBe(true);
    expect(canApproveCampaign(leader, 'pod-b')).toBe(false);
    expect(canApproveCampaign(admin, 'pod-b')).toBe(true);
    // Still not an administrator.
    expect(canManageSettings(leader)).toBe(false);
    expect(canManageUsers(leader)).toBe(false);
    expect(visiblePodIds(leader)).toBeNull();
  });

  it('junior FO only works own tasks', () => {
    expect(canActOnTask(junior, { foUserId: 'junior', podId: 'pod-a' })).toBe(true);
    expect(canActOnTask(junior, { foUserId: 'senior', podId: 'pod-a' })).toBe(false);
    expect(canManagePod(junior, 'pod-a')).toBe(false);
    expect(canEnroll(junior, 'pod-a')).toBe(false);
    expect(canEditSequences(junior)).toBe(false);
    expect(canViewReports(junior)).toBe(false);
    expect(canManageEnrollment(junior, { foUserId: 'junior', podId: 'pod-a' })).toBe(false);
    expect(canSnoozeFreely(junior)).toBe(false);
    expect(canSnoozeFreely(senior)).toBe(true);
    expect(visiblePodIds(junior)).toBeNull(); // reads everything; works only their own tasks
  });
});
