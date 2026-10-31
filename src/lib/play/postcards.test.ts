import { describe, it, expect } from 'vitest';
import {
  POSTCARD_END_GAP_M,
  POSTCARD_MAX,
  POSTCARD_MIN,
  POSTCARD_PICKUP_M,
  POSTCARD_START_GAP_M,
  collectedAt,
  metresToNext,
  placePostcards,
} from '@/lib/play/postcards';

describe('placePostcards', () => {
  it('spaces a 9.7 km route at roughly 0.8 km', () => {
    const cards = placePostcards(9709);
    expect(cards.length).toBe(12);
    expect(cards[0]).toEqual({ index: 1, distanceM: POSTCARD_START_GAP_M });
    expect(cards.at(-1)!.distanceM).toBe(9709 - POSTCARD_END_GAP_M);
    for (let i = 1; i < cards.length; i++) {
      expect(cards[i].distanceM).toBeGreaterThan(cards[i - 1].distanceM);
      expect(cards[i].index).toBe(i + 1);
    }
  });

  it('gives short routes the minimum and caps long ones', () => {
    expect(placePostcards(1200)).toHaveLength(POSTCARD_MIN);
    expect(placePostcards(120_000)).toHaveLength(POSTCARD_MAX);
  });

  it('places none on routes too short or invalid', () => {
    expect(placePostcards(400)).toEqual([]);
    expect(placePostcards(Number.NaN)).toEqual([]);
  });
});

describe('collecting', () => {
  const cards = placePostcards(5000);

  it('collects by riding past, within the pickup radius', () => {
    expect(collectedAt(cards, 0)).toBe(0);
    expect(collectedAt(cards, cards[0].distanceM - POSTCARD_PICKUP_M - 1)).toBe(0);
    expect(collectedAt(cards, cards[0].distanceM - POSTCARD_PICKUP_M)).toBe(1);
    expect(collectedAt(cards, cards[2].distanceM + 1)).toBe(3);
  });

  it('riding the whole route collects every postcard', () => {
    expect(collectedAt(cards, 5000)).toBe(cards.length);
    expect(metresToNext(cards, cards.length, 5000)).toBeNull();
  });

  it('reports metres to the next one', () => {
    expect(metresToNext(cards, 0, 100)).toBe(cards[0].distanceM - 100);
    expect(metresToNext(cards, 1, cards[1].distanceM + 3)).toBe(0);
  });
});
