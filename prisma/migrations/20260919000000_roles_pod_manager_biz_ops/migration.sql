-- Two roles: a Pod Manager runs a pod (every pod-level write, none of the admin ones) and
-- Biz Ops reads every pod without writing to any of them.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'POD_MANAGER';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'BIZ_OPS';
