// SPDX-License-Identifier: AGPL-3.0-only
// Local offline reverse geocoder for the Library location filter: GPS → "city, country" (GeoNames, CC BY 4.0).
type Place = { name: string; country: string; lat: number; lon: number };
let places: Promise<Place[]> | undefined;
function load(): Promise<Place[]> {
  return places ??= import('./places.json').then(({ default: bundle }) => bundle.places.split('\n').map(row => {
    const [name, cc, lat, lon] = row.split('|');
    return { name, country: (bundle.countries as Record<string, string>)[cc] ?? cc, lat: Number(lat) / bundle.scale, lon: Number(lon) / bundle.scale };
  }));
}
const RADIUS_KM = 6371, toRad = Math.PI / 180;
export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * toRad, dLon = (bLon - aLon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** Nearest place within 100 km (stated assumption), as "City, Country"; null farther away or without coordinates. */
export async function placeName(latitude: number | null, longitude: number | null): Promise<string | null> {
  if (latitude === null || longitude === null || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  let best: Place | undefined, bestKm = Infinity;
  for (const p of await load()) {
    if (Math.abs(p.lat - latitude) > 1.5) continue;
    const km = distanceKm(latitude, longitude, p.lat, p.lon);
    if (km < bestKm) { bestKm = km; best = p; }
  }
  return best && bestKm <= 100 ? `${best.name}, ${best.country}` : null;
}
