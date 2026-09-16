// ---- TURBULENCE HELPER FUNCTIONS & CONSTANTS ----
const TURB_POINTS = 14;
const MAX_SHEAR_KMH = 60;

function toUtcDate(isoLike) {
    return new Date(isoLike.replace(' ', 'T'));
}

// Helper for JSON responses
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    });
}

// ---- ROUTE HANDLERS ----
async function handleFlight(url, env) {
    const flightNumber = url.searchParams.get('flight');
    const date = url.searchParams.get('date');

    if (!flightNumber || !date) {
        return jsonResponse({ error: 'Missing flight number or date' }, 400);
    }

    const apiUrl = `https://aerodatabox.p.rapidapi.com/flights/number/${flightNumber}/${date}?withAircraftImage=false&withLocation=false`;

    try {
        const response = await fetch(apiUrl, {
            headers: {
                'x-rapidapi-host': 'aerodatabox.p.rapidapi.com',
                'x-rapidapi-key': env.AERODATABOX_KEY || process.env.AERODATABOX_KEY
            }
        });

        const data = await response.json();

        if (!Array.isArray(data) || data.length === 0) {
            return jsonResponse({ error: 'No flight found for that number and date' }, 404);
        }

        const flight = data[0];
        const result = {
            flightNumber: flight.number,
            date: date,
            origin: {
                code: flight.departure.airport.iata,
                name: flight.departure.airport.name,
                lat: flight.departure.airport.location.lat,
                lon: flight.departure.airport.location.lon
            },
            destination: {
                code: flight.arrival.airport.iata,
                name: flight.arrival.airport.name,
                lat: flight.arrival.airport.location.lat,
                lon: flight.arrival.airport.location.lon
            },
            departureUtc: flight.departure.scheduledTime.utc,
            arrivalUtc: flight.arrival.scheduledTime.utc,
            aircraft: flight.aircraft ? flight.aircraft.model : null
        };

        return jsonResponse(result);
    } catch (err) {
        return jsonResponse({ error: 'Failed to fetch flight data' }, 500);
    }
}

// ---- turbulence: reverted to the simpler fixed 300hPa/250hPa comparison ----
async function handleTurbulence(url) {
    const originLat = url.searchParams.get('originLat');
    const originLon = url.searchParams.get('originLon');
    const destLat = url.searchParams.get('destLat');
    const destLon = url.searchParams.get('destLon');
    const departureUtc = url.searchParams.get('departureUtc');
    const arrivalUtc = url.searchParams.get('arrivalUtc');

    if (!originLat || !originLon || !destLat || !destLon || !departureUtc || !arrivalUtc) {
        return jsonResponse({ error: 'Missing route or time parameters' }, 400);
    }

    const oLat = parseFloat(originLat), oLon = parseFloat(originLon);
    const dLat = parseFloat(destLat), dLon = parseFloat(destLon);
    const depTime = toUtcDate(departureUtc);
    const arrTime = toUtcDate(arrivalUtc);

    if (isNaN(depTime.getTime()) || isNaN(arrTime.getTime())) {
        return jsonResponse({ error: 'Could not parse flight times' }, 400);
    }

    const points = [];
    for (let i = 0; i < TURB_POINTS; i++) {
        const t = i / (TURB_POINTS - 1);
        const lat = oLat + (dLat - oLat) * t;
        const lon = oLon + (dLon - oLon) * t;
        const timeMs = depTime.getTime() + (arrTime.getTime() - depTime.getTime()) * t;
        points.push({ t, lat, lon, time: new Date(timeMs) });
    }

    const lats = points.map(p => p.lat.toFixed(4)).join(',');
    const lons = points.map(p => p.lon.toFixed(4)).join(',');
    const startDate = depTime.toISOString().slice(0, 10);
    const endDate = arrTime.toISOString().slice(0, 10);

    const weatherUrl = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&start_date=${startDate}&end_date=${endDate}&hourly=wind_speed_300hPa,wind_speed_250hPa&timezone=UTC`;

    try {
        const response = await fetch(weatherUrl);
        const raw = await response.json();
        const locations = Array.isArray(raw) ? raw : [raw];

        if (locations.length !== points.length) {
            return jsonResponse({ error: 'Unexpected response shape from weather data' }, 502);
        }

        const result = points.map((p, i) => {
            const loc = locations[i];
            if (!loc || !loc.hourly || !loc.hourly.time) {
                return { t: p.t, lat: p.lat, lon: p.lon, v: 0, note: 'no data' };
            }

            const targetHourIso = new Date(p.time).toISOString().slice(0, 13) + ':00';
            let idx = loc.hourly.time.findIndex(ts => ts === targetHourIso);
            if (idx === -1) idx = 0;

            const w300 = loc.hourly.wind_speed_300hPa ? loc.hourly.wind_speed_300hPa[idx] : null;
            const w250 = loc.hourly.wind_speed_250hPa ? loc.hourly.wind_speed_250hPa[idx] : null;

            let v = 0;
            let shear = null;
            if (w300 != null && w250 != null) {
                shear = Math.abs(w300 - w250);
                v = Math.min(Math.max(shear / MAX_SHEAR_KMH, 0), 1);
            }

            return { t: p.t, lat: p.lat, lon: p.lon, v, shearKmh: shear };
        });

        return jsonResponse({ points: result });
    } catch (err) {
        return jsonResponse({ error: 'Failed to fetch turbulence data' }, 500);
    }
}

// ---- MAIN WORKER EXPORT ----
export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/api/flight') {
            return handleFlight(url, env);
        }
        if (url.pathname === '/api/turbulence') {
            return handleTurbulence(url);
        }

        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return jsonResponse({ error: 'Not Found' }, 404);
    }
};