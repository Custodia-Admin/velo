/**
 * Comfort controls for the smart trainer.
 *
 * Velo riders want easy rides. "Trainer difficulty" (the same idea other
 * trainer apps use) scales the gradient sent to the trainer in SIM mode while
 * the 3D world, physics and recorded elevation stay real.
 */

/** Default share of the real gradient the trainer simulates. Easy. */
export const DEFAULT_TRAINER_DIFFICULTY = 0.35;

/** Hard limits for what we ever ask the trainer to simulate, percent. */
export const TRAINER_GRADE_MIN = -10;
export const TRAINER_GRADE_MAX = 20;

/** Clamp a stored difficulty to the valid 0..1 range (NaN → default). */
export function clampDifficulty(difficulty: number): number {
  if (!Number.isFinite(difficulty)) return DEFAULT_TRAINER_DIFFICULTY;
  return Math.min(1, Math.max(0, difficulty));
}

/**
 * Gradient to send to the trainer for a real route gradient.
 *
 * Climbs and descents are both scaled, so a 6 % climb at 35 % feels like
 * 2.1 % and a descent asks for a little pedalling instead of spinning out.
 * Rounded to the FTMS resolution (0.01 %).
 */
export function scaleGradeForTrainer(gradePct: number, difficulty: number): number {
  if (!Number.isFinite(gradePct)) return 0;
  const scaled = gradePct * clampDifficulty(difficulty);
  const clamped = Math.min(TRAINER_GRADE_MAX, Math.max(TRAINER_GRADE_MIN, scaled));
  // Normalise -0 to 0 so callers can compare with ===.
  return Math.round(clamped * 100) / 100 || 0;
}

/** Plain-language label for a difficulty, used next to the slider. */
export function difficultyLabel(difficulty: number): 'very easy' | 'easy' | 'moderate' | 'real' {
  const d = clampDifficulty(difficulty);
  if (d <= 0.2) return 'very easy';
  if (d <= 0.45) return 'easy';
  if (d < 0.9) return 'moderate';
  return 'real';
}
