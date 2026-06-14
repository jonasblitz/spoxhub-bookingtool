const zones = require('../data/zones.json');

const TRAVELTIME_BASE = 'https://api.traveltimeapp.com/v4';

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Application-Id': process.env.TRAVELTIME_APP_ID,
    'X-Api-Key': process.env.TRAVELTIME_API_KEY
  };
}

/**
 * Geocode an address using TravelTime Geocoding API
 * Returns { lat, lng } or null
 */
async function geocodeAddress(address) {
  const url = `${TRAVELTIME_BASE}/geocoding/search?query=${encodeURIComponent(address)}&limit=1`;

  const res = await fetch(url, { headers: { ...getHeaders(), 'Accept-Language': 'de-DE' } });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Geocoding failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const feature = data.features?.[0];

  if (!feature) return null;

  const [lng, lat] = feature.geometry.coordinates;
  return { lat, lng, label: feature.properties?.label || address };
}

/**
 * Check if a customer location is reachable from a given starting point.
 * Used by api-geo to evaluate each active mobile calendar.
 *
 *   customerLat, customerLng — customer's address (geocoded)
 *   shop                    — { lat, lng } of the calendar's start point
 *   maxMinutes              — radius in minutes for this calendar
 *
 * Returns { reachable, travelTimeMinutes }.
 */
/**
 * Returns a Date set to the next Monday–Friday at the given hour, in
 * Europe/Berlin time. Used as a stable departure_time so traffic-aware
 * reachability checks aren't sensitive to the moment the customer types.
 */
function nextWorkdayAt(hour = 10) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

async function checkReachabilityFrom(customerLat, customerLng, shop, maxMinutes) {
  // Grace-Buffer: TravelTime filtert sekundengenau, die UI rundet auf Minuten.
  // Ohne Buffer wird eine Adresse mit echten 18:10 Min bei maxMin=18 abgelehnt,
  // obwohl der User sie als "18 Min" wahrnimmt. Default 90s — überschreibbar via
  // TRAVELTIME_GRACE_SECONDS env.
  const graceSec = Number.isFinite(+process.env.TRAVELTIME_GRACE_SECONDS)
    ? Math.max(0, +process.env.TRAVELTIME_GRACE_SECONDS)
    : 90;
  const limitMinutes = maxMinutes || zones.maxTravelTimeMinutes;
  const maxSeconds = limitMinutes * 60 + graceSec;

  // Use /time-filter (regular, departure-based) with a CONSTANT neutral
  // departure_time (next workday 10:00 local). Reason: TravelTime's
  // /time-filter respects live traffic, so `now + 1h` gives different
  // results depending on when the customer types the address (rush hour
  // vs night). We want a deterministic check that reflects the typical
  // service-window traffic, not the moment of typing.
  const departure = nextWorkdayAt(10);
  const body = {
    locations: [
      { id: 'shop', coords: { lat: shop.lat, lng: shop.lng } },
      { id: 'customer', coords: { lat: customerLat, lng: customerLng } }
    ],
    departure_searches: [
      {
        id: 'reachability-check',
        departure_location_id: 'shop',
        arrival_location_ids: ['customer'],
        departure_time: departure.toISOString(),
        travel_time: maxSeconds,
        transportation: { type: 'driving' },
        properties: ['travel_time']
      }
    ]
  };

  const res = await fetch(`${TRAVELTIME_BASE}/time-filter`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TravelTime filter failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const result = data.results?.[0];

  if (!result) {
    return { reachable: false, travelTimeMinutes: null };
  }

  const customerResult = (result.locations || []).find(l => l.id === 'customer');
  if (!customerResult) {
    return { reachable: false, travelTimeMinutes: null };
  }

  const props = customerResult.properties;
  const travelTimeSec = Array.isArray(props) ? props[0].travel_time : props.travel_time;
  const travelTimeMinutes = Math.round(travelTimeSec / 60);

  return { reachable: true, travelTimeMinutes };
}

module.exports = { geocodeAddress, checkReachabilityFrom };
