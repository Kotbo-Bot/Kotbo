import { describe, expect, test } from 'bun:test';
import {
  ONBOARDING_FUNNEL_STEPS,
  ONBOARDING_MERGED_STEPS,
  funnelStepOf,
  isOnboardingBacktrack,
} from '@kotbo/contracts';

describe('entonnoir du parcours', () => {
  test('les écrans fusionnés ne sont plus listés, leurs repreneurs si', () => {
    for (const [merged, into] of Object.entries(ONBOARDING_MERGED_STEPS)) {
      expect(ONBOARDING_FUNNEL_STEPS).not.toContain(merged);
      expect(ONBOARDING_FUNNEL_STEPS).toContain(into!);
      expect(funnelStepOf(merged)).toBe(into!);
    }
    expect(funnelStepOf('rules')).toBe('rules');
  });

  test('la reprise précède le choix des modules', () => {
    expect(ONBOARDING_FUNNEL_STEPS.slice(0, 4)).toEqual(['kind', 'migration-bots', 'migration-findings', 'tracks']);
    expect(isOnboardingBacktrack('kind', 'migration-bots')).toBe(false);
    expect(isOnboardingBacktrack('tracks', 'migration-findings')).toBe(true);
  });
});
