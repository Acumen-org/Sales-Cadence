# Directory and CRM content review - 14 September 2026

## Confirmed counting rule

An Accounts pod filter selects companies containing at least one live contact in that pod. The people total then counts **all live contacts at those matching accounts**, including other pods. Each company is counted once. Contacts without a company only contribute to People. This is the behavior the owner explicitly selected; the summary now says **People at matching accounts** and each row says **People at account**. Accounts intentionally does not have the same contact membership as a pod-filtered People list.

## Requested changes

- Accounts replaces Industry, City and Owner columns with PODs, FOs and Product. Associations are deduplicated across the complete account, including contacts outside the selected pod. FOs combine CRM ownership and active/paused enrollment assignments; administrative CRM owners are not presented as FOs.
- People uses **Tags in Twenty** and removes the Recent activity column and timeline. Tag chips use deterministic colours and apply filters. Tier, contact-type and product tags reuse their existing filter. Other CRM tags have a directory-wide dropdown; list categories have their own dropdown. Filter choices survive refresh and pagination. Clearing an FO stays cleared when paging.
- Every existing sort selector (Accounts, People and Enrichment) supports ascending and descending. Sorting occurs before pagination; exports retain the chosen order. People's update sort uses the CRM modification timestamp instead of the latest sync timestamp.
- CRM email queries now request the mapped body field, which was previously omitted. Email and note bodies open in full, with cursor navigation to older records. Emails separate From, To, Cc and Bcc, and sanitize HTML content before rendering. Notes retain their complete body and author. Missing source bodies and unavailable CRM responses remain explicitly identified.
- Sync feedback uses a dismissible, temporary portal toast. Its button keeps the same label and dimensions while running; completion feedback adds no content to the filter toolbar.

## Verification

- Production build, lint and type checking passed.
- 325 unit/integration tests passed, including full email/note query content, mixed-pod account counts, associations, both sort directions and enrichment ordering.
- The scale test exercised 20,000 contacts / 6,000 companies with 12 concurrent account-page reads; all pages contained the expected distinct records.
- 56 browser tests passed, including the sync button/search bounding-box check and automatic toast dismissal. Browser coverage includes tag click/reset/reload, account columns and numeric sort order, export direction, four simultaneous seats repeatedly visiting seven sections, and desktop/mobile layouts.
- Hosted read checks passed for the supplied Admin, POD Manager, Biz Ops and FO accounts across People, Accounts, Meetings and Enrichment: 16 successful routes, no browser errors. Those checks validate the deployed baseline; new behavior was verified against the local production build before pushing.

## Release boundary

The repository workflow builds and pushes an image to Harbor after checks pass. Its current configuration explicitly leaves deployment manual. A successful GitHub push or image build alone does not establish that the hosted site is running that commit.
