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
async function checkReachabilityFrom(customerLat, customerLng, shop, maxMinutes) {
  const maxSeconds = (maxMinutes || zones.maxTravelTimeMinutes) * 60;

  // Use one_to_many: shop departs, check if customer is reachable
  const body = {
    locations: [
      { id: 'shop', coords: { lat: shop.lat, lng: shop.lng } },
      { id: 'customer', coords: { lat: customerLat, lng: customerLng } }
    ],
    arrival_searches: {
      one_to_many: [
        {
          id: 'reachability-check',
          departure_location_id: 'shop',
          arrival_location_ids: ['customer'],
          arrival_time_period: 'weekday_morning',
          travel_time: maxSeconds,
          transportation: { type: 'driving' },
          properties: ['travel_time']
        }
      ]
    }
  };

  const res = await fetch(`${TRAVELTIME_BASE}/time-filter/fast`, {
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
