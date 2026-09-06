/** Deep links into the Twenty UI. Twenty serves its app and API from the same origin. */
export function twentyPersonUrl(baseUrl: string | null | undefined, personId: string): string | null {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, '')}/object/person/${personId}`;
}

export function twentyCompanyUrl(baseUrl: string | null | undefined, companyId: string): string | null {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, '')}/object/company/${companyId}`;
}

export function twentyOpportunityUrl(baseUrl: string | null | undefined, opportunityId: string): string | null {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, '')}/object/opportunity/${opportunityId}`;
}
