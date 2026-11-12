import { describe, test, expect } from 'bun:test';
import {
  DROP_ACTIVITY_MESSAGES_RANGE,
  DROP_ACTIVITY_WINDOW_MINUTES_RANGE,
  DROP_JACKPOT_CHANCE_CHOICES,
  DROP_JACKPOT_MULTIPLIER_CHOICES,
} from '@kotbo/shared';
import { ACTIVITY_DEFAULT_STEP, ACTIVITY_PRESETS, JACKPOT_PRESETS } from './dropPresets';

/**
 * Les crans du mode simple doivent tomber dans ce que l'API accepte : un cran hors bornes
 * serait ramené au défaut à l'enregistrement, et le curseur reviendrait ailleurs que là
 * où l'administrateur l'a posé.
 */
describe('crans des drops', () => {
  test('attente d\'activité : dans les bornes, exigence croissante', () => {
    for (const preset of ACTIVITY_PRESETS) {
      expect(preset.minMessages).toBeGreaterThanOrEqual(DROP_ACTIVITY_MESSAGES_RANGE.min);
      expect(preset.minMessages).toBeLessThanOrEqual(DROP_ACTIVITY_MESSAGES_RANGE.max);
      expect(preset.windowMinutes).toBeGreaterThanOrEqual(DROP_ACTIVITY_WINDOW_MINUTES_RANGE.min);
      expect(preset.windowMinutes).toBeLessThanOrEqual(DROP_ACTIVITY_WINDOW_MINUTES_RANGE.max);
    }
    const messages = ACTIVITY_PRESETS.map((preset) => preset.minMessages);
    expect(messages).toEqual([...messages].sort((a, b) => a - b));
    expect(ACTIVITY_PRESETS[ACTIVITY_DEFAULT_STEP - 1]).toBeDefined();
  });

  test('jackpot : uniquement des valeurs proposées, gain croissant vers la droite', () => {
    for (const preset of JACKPOT_PRESETS) {
      expect(DROP_JACKPOT_CHANCE_CHOICES as readonly number[]).toContain(preset.chance);
      expect(DROP_JACKPOT_MULTIPLIER_CHOICES as readonly number[]).toContain(preset.multiplier);
    }
    // Un curseur se lit « plus » vers la droite : ici, plus gros et plus rare.
    const multipliers = JACKPOT_PRESETS.map((preset) => preset.multiplier);
    expect(multipliers).toEqual([...multipliers].sort((a, b) => a - b));
    const chances = JACKPOT_PRESETS.map((preset) => preset.chance);
    expect(chances).toEqual([...chances].sort((a, b) => a - b));
  });
});
