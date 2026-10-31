/**
 * Where the household rides from. The family lives in Perugia; Federico grew
 * up in Lugano, so the Ticino rides stay in the library as "hometown".
 *
 * Use HOME for anything that needs a default place before a route is picked
 * (map centre, a weather fallback). Scenic routes tagged 'near-home' start
 * within an easy drive of it (checked in scenicRoutes.test.ts).
 */

export interface HomePlace {
  name: string;
  lat: number;
  lon: number;
}

export const HOME: HomePlace = { name: 'Perugia', lat: 43.1107, lon: 12.3908 };

export const HOMETOWN: HomePlace = { name: 'Lugano', lat: 46.0037, lon: 8.9511 };
