-- Migration 1 of 2: add the ARCHIVED lifecycle status.
--
-- Kept as its own migration on purpose: Postgres does not allow a newly
-- added enum value to be USED in the same transaction that adds it, and
-- migration 2 backfills rows to ARCHIVED.

ALTER TYPE "TemplateLifecycleStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';
