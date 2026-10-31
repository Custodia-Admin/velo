import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TRAINER_DIFFICULTY,
  TRAINER_GRADE_MAX,
  TRAINER_GRADE_MIN,
  clampDifficulty,
  difficultyLabel,
  scaleGradeForTrainer,
} from '@/lib/trainerComfort';
import { DEFAULT_SETTINGS } from '@/stores/settingsStore';

describe('trainerComfort', () => {
  it('defaults to an easy 30–40 % with ERG off', () => {
    expect(DEFAULT_TRAINER_DIFFICULTY).toBeGreaterThanOrEqual(0.3);
    expect(DEFAULT_TRAINER_DIFFICULTY).toBeLessThanOrEqual(0.4);
    expect(DEFAULT_SETTINGS.trainerDifficulty).toBe(DEFAULT_TRAINER_DIFFICULTY);
    expect(DEFAULT_SETTINGS.ergEnabled).toBe(false);
  });

  it('scales climbs and descents by the difficulty', () => {
    expect(scaleGradeForTrainer(6, 0.35)).toBeCloseTo(2.1, 5);
    expect(scaleGradeForTrainer(-6, 0.35)).toBeCloseTo(-2.1, 5);
    expect(scaleGradeForTrainer(6, 1)).toBe(6);
    expect(scaleGradeForTrainer(6, 0)).toBe(0);
  });

  it('never returns -0, NaN, or values outside the trainer limits', () => {
    expect(Object.is(scaleGradeForTrainer(-0.001, 0.35), -0)).toBe(false);
    expect(scaleGradeForTrainer(Number.NaN, 0.35)).toBe(0);
    expect(scaleGradeForTrainer(40, 1)).toBe(TRAINER_GRADE_MAX);
    expect(scaleGradeForTrainer(-40, 1)).toBe(TRAINER_GRADE_MIN);
  });

  it('rounds to FTMS 0.01 % resolution', () => {
    expect(scaleGradeForTrainer(3.333, 0.35)).toBe(1.17);
  });

  it('clamps stored difficulty', () => {
    expect(clampDifficulty(2)).toBe(1);
    expect(clampDifficulty(-1)).toBe(0);
    expect(clampDifficulty(Number.NaN)).toBe(DEFAULT_TRAINER_DIFFICULTY);
  });

  it('labels difficulty in plain words', () => {
    expect(difficultyLabel(0.1)).toBe('very easy');
    expect(difficultyLabel(0.35)).toBe('easy');
    expect(difficultyLabel(0.6)).toBe('moderate');
    expect(difficultyLabel(1)).toBe('real');
  });
});
