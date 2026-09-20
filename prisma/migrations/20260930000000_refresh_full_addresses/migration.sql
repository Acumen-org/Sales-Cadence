-- Re-read unchanged CRM records after adding full postal-address fields to company reads.
UPDATE "Setting" SET "value" = "value"::jsonb - 'lastFullRefresh'
WHERE "key" = 'continuousSync';
