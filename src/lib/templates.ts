/**
 * Template rendering for step actions.
 * Supported variables: {{firstName}} {{lastName}} {{fullName}} {{company}} {{jobTitle}}
 * {{city}} {{leadSource}} {{product}} {{foFirstName}} {{foName}}.
 * Unknown variables render as empty strings.
 *
 * {{leadSource}} and {{product}} come from Twenty and are already humanised by the caller
 * (twenty/labels.ts), so a template never prints FPA_WISCONSIN_JULY_2026 at a prospect.
 */
export type TemplateVars = {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  jobTitle?: string | null;
  city?: string | null;
  leadSource?: string | null;
  product?: string | null;
  foFirstName?: string | null;
  foName?: string | null;
};

export const TEMPLATE_VARIABLES = [
  'firstName',
  'lastName',
  'fullName',
  'company',
  'jobTitle',
  'city',
  'leadSource',
  'product',
  'foFirstName',
  'foName',
] as const;

const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function renderTemplate(template: string | null | undefined, vars: TemplateVars): string {
  if (!template) return '';
  const fullName = [vars.firstName, vars.lastName].filter(Boolean).join(' ').trim();
  const table: Record<string, string> = {
    firstName: vars.firstName ?? '',
    lastName: vars.lastName ?? '',
    fullName,
    company: vars.company ?? '',
    jobTitle: vars.jobTitle ?? '',
    city: vars.city ?? '',
    leadSource: vars.leadSource ?? '',
    product: vars.product ?? '',
    foFirstName: vars.foFirstName ?? firstNameOf(vars.foName),
    foName: vars.foName ?? '',
  };
  return template.replace(VAR_RE, (_m, name: string) => table[name] ?? '');
}

/** Variables referenced by a template that we do not know. */
export function unknownVariables(template: string): string[] {
  const known = new Set<string>(TEMPLATE_VARIABLES);
  const out = new Set<string>();
  for (const m of template.matchAll(VAR_RE)) {
    if (!known.has(m[1])) out.add(m[1]);
  }
  return [...out];
}

export function firstNameOf(name: string | null | undefined): string {
  if (!name) return '';
  return name.trim().split(/\s+/)[0] ?? '';
}
