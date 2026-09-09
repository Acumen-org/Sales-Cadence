import { describe, expect, it } from 'vitest';
import { TwentyGraphqlClient } from '@/lib/twenty/graphql-client';
import { normalizeCompany, normalizePerson } from '@/lib/twenty/normalize';
import { mergeTwentySchema } from '@/lib/twenty/twenty-schema';

const rawPerson = { id: 'person-1', name: { firstName: 'Nina', lastName: 'Test' }, contactEmails: { primaryEmail: null, additionalEmails: ['secondary@example.com'] }, tags: ['ENRICHMENT_REQUIRED'], updatedAt: '2026-09-09T12:00:00Z' };
const rawCompany = { id: 'company-1', name: 'Example account', assets: { amountMicros: null, currencyCode: 'USD' }, updatedAt: '2026-09-09T12:00:00Z' };
type Call = { query: string; variables: Record<string, unknown> };

function client(options: { missing?: string[]; currencyCode?: string } = {}) {
  const schema = mergeTwentySchema({ person: { emails: 'contactEmails' }, company: { aum: 'assets' } });
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Call;
    calls.push(body);
    if (body.query.includes('__type')) {
      const names = body.variables.name === 'Person' ? ['id', 'name', 'contactEmails', 'phones', 'linkedinLink', 'jobTitle', 'city', 'tags', 'updatedAt'] : ['id', 'name', 'domainName', 'assets', 'industry', 'employees', 'address', 'linkedinLink', 'updatedAt'];
      return Response.json({ data: { __type: { fields: names.filter((name) => !options.missing?.includes(name)).map((name) => ({ name, type: name === 'assets' ? { kind: 'OBJECT', name: 'Currency' } : { kind: 'SCALAR', name: 'String' } })) } } });
    }
    if (body.query.includes('updatePerson(')) return Response.json({ data: { updatePerson: { ...rawPerson, ...(body.variables.data as object) } } });
    if (body.query.includes('updateCompany(')) return Response.json({ data: { updateCompany: { ...rawCompany, ...(body.variables.data as object) } } });
    throw new Error('Unexpected API operation');
  };
  return { instance: new TwentyGraphqlClient({ baseUrl: 'https://twenty.example', apiKey: 'test-key', schema, fetchImpl }), calls, schema };
}

describe('Twenty enrichment write contract', () => {
  it('uses mapped fields and preserves the email list and the unchanged name component', async () => {
    const { instance, calls, schema } = client();
    const updated = await instance.enrichPerson('person-1', { email: 'new@example.com', firstName: 'Nina-Marie' }, normalizePerson(rawPerson, schema));
    const mutation = calls.find((call) => call.query.includes('updatePerson('))!;
    expect(mutation.variables).toMatchObject({ id: 'person-1', data: { contactEmails: { primaryEmail: 'new@example.com', additionalEmails: ['secondary@example.com'] }, name: { firstName: 'Nina-Marie', lastName: 'Test' } } });
    expect(updated).toMatchObject({ email: 'new@example.com', firstName: 'Nina-Marie', lastName: 'Test', tags: ['ENRICHMENT_REQUIRED'] });
  });

  it('refuses missing mapped fields before sending a mutation', async () => {
    const { instance, calls, schema } = client({ missing: ['jobTitle'] });
    await expect(instance.enrichPerson('person-1', { jobTitle: 'Director' }, normalizePerson(rawPerson, schema))).rejects.toThrow(/missing mapped fields/);
    expect(calls.some((call) => call.query.includes('mutation'))).toBe(false);
  });

  it('writes exact USD currency micros and normalizes the returned AUM', async () => {
    const { instance, calls, schema } = client();
    const updated = await instance.enrichCompany('company-1', { aum: '1250000.25' }, normalizeCompany(rawCompany, schema));
    const mutation = calls.find((call) => call.query.includes('updateCompany('))!;
    expect(mutation.variables.data).toEqual({ assets: { amountMicros: '1250000250000', currencyCode: 'USD' } });
    expect(mutation.query).toContain('assets { amountMicros currencyCode }');
    expect(updated.aum).toBe('1250000.25');
  });

  it('does not overwrite a different currency or invent an AUM field', async () => {
    const { instance, calls, schema } = client();
    await expect(instance.enrichCompany('company-1', { aum: '250.00' }, normalizeCompany({ ...rawCompany, assets: { amountMicros: '100000000', currencyCode: 'EUR' } }, schema))).rejects.toThrow(/another currency/);
    expect(calls.some((call) => call.query.includes('mutation'))).toBe(false);
    const missing = client({ missing: ['assets'] });
    await expect(missing.instance.enrichCompany('company-1', { aum: '250.00' }, normalizeCompany(rawCompany, missing.schema))).rejects.toThrow(/Map company.aum/);
  });
});
