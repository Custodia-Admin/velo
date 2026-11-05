/**
 * Pace partners (Home → Build your own ride → Pace partners): which AI
 * riders come along, as pure functions over rideStore.paceBots. The store is
 * the only source of the selection; the picker renders what this returns.
 */
import { BOT_PRESETS, createPaceBot, type PaceBot, type Personality } from '@/lib/paceBots';
import type { Route } from '@/types';

/** How many partners can ride along at once. */
export const MAX_PARTNERS = 3;

interface Partner {
  /** Stable roster id (`pace-<personality>`); also the bot's id in the store. */
  id: string;
  name: string;
  personality: Personality;
  /** One word for how they ride. */
  style: string;
  /** One sentence for what riding with them is like (lib/paceBots behaviour). */
  blurb: string;
  preset: (typeof BOT_PRESETS)[number];
}

const STYLE: Record<Personality, { style: string; blurb: string }> = {
  steady: { style: 'Pacer', blurb: 'Holds an even pace close to you.' },
  climber: { style: 'Climber', blurb: 'Easy on the flat, strong up every hill.' },
  sprinter: { style: 'Sprinter', blurb: 'Cruises easy, then sprints hard on the flat.' },
  attacker: { style: 'Attacker', blurb: 'Sits just ahead of you and keeps attacking.' },
};

export const PARTNERS: readonly Partner[] = BOT_PRESETS.map((preset) => ({
  id: `pace-${preset.personality}`,
  name: preset.name,
  personality: preset.personality,
  ...STYLE[preset.personality],
  preset,
}));

/** Ids of the partners riding along. */
export function pickedPartnerIds(bots: readonly PaceBot[]): ReadonlySet<string> {
  return new Set(bots.map((b) => b.id));
}

/**
 * The roster after tapping a partner: added (as a real PaceBot, standing on
 * `route`'s start line when one is loaded) or removed. Adding past
 * MAX_PARTNERS changes nothing. Riders already picked keep their order and
 * state.
 */
export function togglePartner(bots: readonly PaceBot[], id: string, route?: Route | null): PaceBot[] {
  if (bots.some((b) => b.id === id)) return bots.filter((b) => b.id !== id);
  const partner = PARTNERS.find((p) => p.id === id);
  if (!partner || bots.length >= MAX_PARTNERS) return [...bots];
  return [...bots, createPaceBot(partner.id, partner.preset, route)];
}

/** The line under the picker: how many ride along, and why the rest are off at the cap. */
export function partnersStatus(count: number): string {
  if (count === 0) return 'Riding alone';
  const line = `${count} of ${MAX_PARTNERS} riding with you`;
  return count >= MAX_PARTNERS ? `${line}. Remove one to pick another.` : line;
}
