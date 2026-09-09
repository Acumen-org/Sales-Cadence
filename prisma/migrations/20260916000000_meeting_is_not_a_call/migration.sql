-- A meeting Twenty reports (an opportunity booked against a contact) was recorded as a CALL, so
-- the person's timeline showed "Opportunity created" behind a telephone icon and the call channel
-- counted touches nobody made. It gets its own value, and the rows already written are moved.
ALTER TYPE "Channel" ADD VALUE IF NOT EXISTS 'MEETING';

-- Committed separately: Postgres refuses a new enum value in the same transaction that uses it.
