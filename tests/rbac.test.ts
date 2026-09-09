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
  type Actor,
} from '@/lib/auth/rbac';

const admin: Actor = { id: 'admin', role: 'ADMIN', podIds: [] };
const leader: Actor = { id: 'leader', role: 'SALES_LEADER', podIds: ['pod-a'] };
const senior: Actor = { id: 'senior', role: 'SENIOR_FO', podIds: ['pod-a'] };
const junior: Actor = { id: 'junior', role: 'JUNIOR_FO', podIds: ['pod-a'] };

describe('rbac', () => {
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
    expect(visiblePodIds(senior)).toEqual(['pod-a']);
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
    expect(visiblePodIds(leader)).toEqual(['pod-a']);
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
    expect(visiblePodIds(junior)).toEqual(['pod-a']);
  });
});
