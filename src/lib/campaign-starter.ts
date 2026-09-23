import { CAMPAIGN_DEFAULT_STEPS } from './sequences/campaign-default';

/** The channel pattern is a recipe, not a saved or fixed-length sequence. `fitCampaign` picks its length and spacing. */
export function outreachRecipe(count: number, gap = 1) {
  return Array.from({ length: count }, (_, i) => {
    const source = i === 0 ? 0 : count >= 4 && i === count - 1 ? 7 : 1 + (i - 1) % 6;
    const step = structuredClone(CAMPAIGN_DEFAULT_STEPS[source]);
    return { ...step, id: `starter-${i}`, day: 1 + i * gap, actions: step.actions.map((a, j) => ({ ...a, id: `starter-${i}-${j}` })) };
  });
}
