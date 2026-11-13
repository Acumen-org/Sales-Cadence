/**
 * Mail a machine sent to many people: newsletters, product notifications, receipts, no-reply
 * senders (owner, 13 Nov 2026: these made "Reply to their email" tasks). Never an answer to us,
 * whoever it came from. An out-of-office is `isAutomaticReply`'s; this is the rest.
 */
const SENDER = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|notify|alerts?|news(letters?)?|marketing|mailer|mailer-daemon|postmaster|bounces?|updates?|digest|announce(ments)?|promo(tions)?|offers?|deals|events?|webinars?|community|automated|system|account(s)?|billing|receipts?|invoices?|security|verify|confirm(ation)?)([-_.+].*)?@/i;
/** Bulk senders' own domains, and the subdomains firms use for them ("mail.", "news.", "email."...). */
const BULK_DOMAIN = /(^|\.)(mailchimp|mcsv|mcdlv|list-manage|sendgrid|sendinblue|brevo|hubspot(email)?|hs-?send|mailgun|mandrill|mandrillapp|amazonses|sparkpost(mail)?|postmarkapp|constantcontact|campaign-?monitor|createsend|klaviyo|mailjet|memberclicks(-mail)?|exacttarget|marketo|mktomail|pardot|intercom(-mail)?|customeriomail|substack|beehiiv|convertkit|ccsend)\./i;
const BULK_SUBDOMAIN = /@(e|em|email|mail|mailer|mailing|news|newsletter|info|updates?|marketing|notify|notifications?|go|engage|reply)\.[a-z0-9-]+\.[a-z.]+$/i;
const BULK_TEXT = /\bunsubscribe\b|manage (your )?(email )?(preferences|subscription)|view (this email )?in (your )?browser|you('re| are) receiving this (email|message)|opt[- ]out of (these|future) emails|update your (email )?preferences/i;

export function isAutomatedMail(m: { from?: string | null; subject?: string | null; text?: string | null }): boolean {
  const from = (m.from ?? '').trim().toLowerCase();
  if (from && (SENDER.test(from) || BULK_SUBDOMAIN.test(from) || BULK_DOMAIN.test(from.split('@')[1] ?? ''))) return true;
  return BULK_TEXT.test(m.text ?? '');
}
