import { firstNameOf } from '../names';
import type { StepAction } from './steps';

/**
 * The words a sequence author may write in copy, filled in per person the moment a task is
 * created. The task itself never shows a token: what the FO reads is what the person gets.
 */
export const TEMPLATE_TOKENS = [
  { token: 'firstName', means: 'the person\'s first name ("there" if unknown)' },
  { token: 'lastName', means: 'their last name' },
  { token: 'fullName', means: 'their full name' },
  { token: 'company', means: 'their company ("your firm" if unknown)' },
  { token: 'jobTitle', means: 'their job title' },
  { token: 'city', means: 'their city' },
  { token: 'foFirstName', means: 'your first name' },
  { token: 'foName', means: 'your name' },
] as const;

export type PersonalizeContext = {
  person: { firstName: string; lastName: string; companyName: string | null; jobTitle: string | null; city: string | null };
  fo: { name: string };
};

const TOKEN = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;

export function personalize(text: string, ctx: PersonalizeContext): string {
  const full = [ctx.person.firstName, ctx.person.lastName].filter(Boolean).join(' ').trim();
  const values: Record<string, string> = {
    firstname: ctx.person.firstName?.trim() || 'there',
    lastname: ctx.person.lastName?.trim() ?? '',
    fullname: full || 'there',
    company: ctx.person.companyName?.trim() || 'your firm',
    jobtitle: ctx.person.jobTitle?.trim() ?? '',
    city: ctx.person.city?.trim() ?? '',
    fofirstname: firstNameOf(ctx.fo.name),
    foname: ctx.fo.name.trim(),
  };
  return text.replace(TOKEN, (_, name: string) => values[name.toLowerCase()] ?? '');
}

/** The module as the task will carry it: every token resolved for this person and this FO. */
export function personalizeAction(action: StepAction, ctx: PersonalizeContext): StepAction {
  return {
    ...action,
    ...(action.subject !== undefined ? { subject: personalize(action.subject, ctx) } : {}),
    ...(action.template !== undefined ? { template: personalize(action.template, ctx) } : {}),
    ...(action.bodyHtml !== undefined ? { bodyHtml: personalize(action.bodyHtml, ctx) } : {}),
  };
}

/** True when copy still carries a token nobody will fill - used to warn in the editor. */
export function hasUnknownToken(text: string): string | null {
  const known = new Set(TEMPLATE_TOKENS.map((t) => t.token.toLowerCase()));
  for (const m of text.matchAll(TOKEN)) if (!known.has(m[1].toLowerCase())) return m[1];
  return null;
}
