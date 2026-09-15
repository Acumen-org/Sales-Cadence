-- Name sorting must follow the first-name-first label shown in the directory.
UPDATE "PersonCache" SET "sortName" = NULLIF(lower(regexp_replace(trim(both from "firstName" || ' ' || "lastName"), '\s+', ' ', 'g')), '');
