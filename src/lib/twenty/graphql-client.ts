import type { TwentyClient } from './client';
import type { TwentySchema } from './twenty-schema';

export type TwentyGraphqlClientOptions = {
  baseUrl: string;
  apiKey: string;
  schema: TwentySchema;
};

/**
 * Placeholder until phase 6 delivers the real GraphQL client. Constructing it
 * throws so nobody accidentally runs against a workspace before it exists.
 */
export const TwentyGraphqlClient: new (opts: TwentyGraphqlClientOptions) => TwentyClient = class {
  constructor(_opts: TwentyGraphqlClientOptions) {
    throw new Error('TwentyGraphqlClient is delivered in phase 6. Use TWENTY_MODE=mock for now.');
  }
} as unknown as new (opts: TwentyGraphqlClientOptions) => TwentyClient;
