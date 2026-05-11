const TRAVELTIME_BASE = 'https://api.traveltimeapp.com/v4';

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Application-Id': process.env.TRAVELTIME_APP_ID,
    'X-Api-Key': process.env.TRAVELTIME_API_KEY
  };
}

/**
 * Isochrone-Polygon (Einsatzradius) per TravelTime time-map abfragen.
 * Liefert ein Array von Shapes: [{ shell: [{lat,lng}], holes: [[{lat,lng}]] }]
 */
async function getIsochrone({ lat, lng, maxMinutes, mode = 'driving' }) {
  if (!process.env.TRAVELTIME_APP_ID || !process.env.TRAVELTIME_API_KEY) {
    throw new Error('TravelTime API nicht konfiguriert');
  }

  const departure = new Date();
  departure.setHours(departure.getHours() + 1, 0, 0, 0);

  const body = {
    departure_searches: [
      {
        id: 'iso',
        coords: { lat, lng },
        departure_time: departure.toISOString(),
        travel_time: Math.round(maxMinutes * 60),
        transportation: { type: mode },
        level_of_detail: { scale_type: 'simple', level: 'medium' }
      }
    ]
  };

  const res = await fetch(`${TRAVELTIME_BASE}/time-map`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`time-map failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const result = data.results?.[0];
  return result?.shapes || [];
}

module.exports = { getIsochrone };
