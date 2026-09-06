import { describe, expect, it } from 'vitest';
import {
  canActOnTask,
  canEditSequences,
  canEnroll,
  canManageEnrollment,
  canManagePod,
  canManageSettings,
  canSnoozeFreely,
  visiblePodIds,
  type Actor,
} from '@/lib/auth/rbac';

const admin: Actor = { id: 'admin', role: 'ADMIN', podIds: [] };
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
    expect(canEditSequences(senior)).toBe(false);
    expect(canManageSettings(senior)).toBe(false);
    expect(visiblePodIds(senior)).toEqual(['pod-a']);
  });

  it('junior FO only works own tasks', () => {
    expect(canActOnTask(junior, { foUserId: 'junior', podId: 'pod-a' })).toBe(true);
    expect(canActOnTask(junior, { foUserId: 'senior', podId: 'pod-a' })).toBe(false);
    expect(canManagePod(junior, 'pod-a')).toBe(false);
    expect(canEnroll(junior, 'pod-a')).toBe(false);
    expect(canManageEnrollment(junior, { foUserId: 'junior', podId: 'pod-a' })).toBe(false);
    expect(canSnoozeFreely(junior)).toBe(false);
    expect(canSnoozeFreely(senior)).toBe(true);
    expect(visiblePodIds(junior)).toEqual(['pod-a']);
  });
});
