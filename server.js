require('dotenv').config();
const express = require('express');
const app = express();
const PORT = 3000;

app.use(express.static('public'));

// ---- flight lookup (AeroDataBox) ----
app.get('/api/flight', async (req, res) => {
    const flightNumber = req.query.flight;
    const date = req.query.date;

    if (!flightNumber || !date) {
        return res.status(400).json({ error: 'Missing flight number or date' });
    }

    const url = `https://aerodatabox.p.rapidapi.com/flights/number/${flightNumber}/${date}?withAircraftImage=false&withLocation=false`;

    try {
        const response = await fetch(url, {
            headers: {
                'x-rapidapi-host': 'aerodatabox.p.rapidapi.com',
                'x-rapidapi-key': process.env.AERODATABOX_KEY
            }
        });

        const data = await response.json();

        if (!Array.isArray(data) || data.length === 0) {
            console.log(`[flight] no result for ${flightNumber} on ${date}`);
            return res.status(404).json({ error: 'No flight found for that number and date' });
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

        console.log(`[flight] ${result.flightNumber}: ${result.origin.code} (${result.departureUtc}) -> ${result.destination.code} (${result.arrivalUtc})`);

        res.json(result);

    } catch (err) {
        console.error('[flight] error:', err);
        res.status(500).json({ error: 'Failed to fetch flight data' });
    }
});

// ---- turbulence lookup (Open-Meteo, altitude-aware wind shear) ----
const TURB_POINTS = 14;
const MAX_SHEAR_KMH = 60;

// pressure levels we can query, each with its approximate altitude in meters
const LEVELS = [
    { hpa: 850, m: 1500 },
    { hpa: 700, m: 3000 },
    { hpa: 600, m: 4200 },
    { hpa: 500, m: 5600 },
    { hpa: 400, m: 7200 },
    { hpa: 300, m: 9200 },
    { hpa: 250, m: 10400 },
    { hpa: 200, m: 11800 }
];

// mirrors the climb/cruise/descent shape used on the frontend
function altitudeFtAt(t) {
    const CRUISE_FT = 34000;
    if (t < 0.15) return CRUISE_FT * (t / 0.15);
    if (t > 0.85) return CRUISE_FT * (1 - (t - 0.85) / 0.15);
    return CRUISE_FT;
}

// given an altitude in meters, find the two adjacent pressure levels
// that bracket it, so shear is measured at the *relevant* band for that point
function bracketLevels(altM) {
    if (altM <= LEVELS[0].m) return [LEVELS[0], LEVELS[1]];
    if (altM >= LEVELS[LEVELS.length - 1].m) return [LEVELS[LEVELS.length - 2], LEVELS[LEVELS.length - 1]];
    for (let i = 0; i < LEVELS.length - 1; i++) {
        if (altM >= LEVELS[i].m && altM <= LEVELS[i + 1].m) return [LEVELS[i], LEVELS[i + 1]];
    }
    return [LEVELS[LEVELS.length - 2], LEVELS[LEVELS.length - 1]];
}

function toUtcDate(isoLike) {
    return new Date(isoLike.replace(' ', 'T'));
}

app.get('/api/turbulence', async (req, res) => {
    const { originLat, originLon, destLat, destLon, departureUtc, arrivalUtc } = req.query;

    if (!originLat || !originLon || !destLat || !destLon || !departureUtc || !arrivalUtc) {
        return res.status(400).json({ error: 'Missing route or time parameters' });
    }

    const oLat = parseFloat(originLat), oLon = parseFloat(originLon);
    const dLat = parseFloat(destLat), dLon = parseFloat(destLon);
    const depTime = toUtcDate(departureUtc);
    const arrTime = toUtcDate(arrivalUtc);

    console.log(`[turbulence] request: ${departureUtc} -> ${arrivalUtc}`);

    if (isNaN(depTime.getTime()) || isNaN(arrTime.getTime())) {
        return res.status(400).json({ error: 'Could not parse flight times' });
    }

    const points = [];
    for (let i = 0; i < TURB_POINTS; i++) {
        const t = i / (TURB_POINTS - 1);
        const lat = oLat + (dLat - oLat) * t;
        const lon = oLon + (dLon - oLon) * t;
        const timeMs = depTime.getTime() + (arrTime.getTime() - depTime.getTime()) * t;
        const altFt = altitudeFtAt(t);
        const altM = altFt * 0.3048;
        const [lower, upper] = bracketLevels(altM);
        points.push({ t, lat, lon, time: new Date(timeMs), altFt, lower, upper });
    }

    const lats = points.map(p => p.lat.toFixed(4)).join(',');
    const lons = points.map(p => p.lon.toFixed(4)).join(',');

    const startDate = depTime.toISOString().slice(0, 10);
    const endDate = arrTime.toISOString().slice(0, 10);

    const hourlyVars = LEVELS.map(l => `wind_speed_${l.hpa}hPa`).join(',');

    const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&start_date=${startDate}&end_date=${endDate}&hourly=${hourlyVars}&timezone=UTC`;

    try {
        const response = await fetch(url);
        const raw = await response.json();

        const locations = Array.isArray(raw) ? raw : [raw];

        if (locations.length !== points.length) {
            console.log('[turbulence] unexpected shape:', JSON.stringify(raw).slice(0, 300));
            return res.status(502).json({ error: 'Unexpected response shape from weather data' });
        }

        const result = points.map((p, i) => {
            const loc = locations[i];
            if (!loc || !loc.hourly || !loc.hourly.time) {
                return { t: p.t, lat: p.lat, lon: p.lon, v: 0, altFt: Math.round(p.altFt), note: 'no data' };
            }

            const targetHourIso = new Date(p.time).toISOString().slice(0, 13) + ':00';
            let idx = loc.hourly.time.findIndex(ts => ts === targetHourIso);
            if (idx === -1) idx = 0;

            const lowerKey = `wind_speed_${p.lower.hpa}hPa`;
            const upperKey = `wind_speed_${p.upper.hpa}hPa`;
            const wLower = loc.hourly[lowerKey] ? loc.hourly[lowerKey][idx] : null;
            const wUpper = loc.hourly[upperKey] ? loc.hourly[upperKey][idx] : null;

            let v = 0;
            let shear = null;
            if (wLower != null && wUpper != null) {
                shear = Math.abs(wLower - wUpper);
                v = Math.min(Math.max(shear / MAX_SHEAR_KMH, 0), 1);
            }

            return {
                t: p.t,
                lat: p.lat,
                lon: p.lon,
                v,
                shearKmh: shear,
                altFt: Math.round(p.altFt),
                levelsUsed: `${p.lower.hpa}hPa/${p.upper.hpa}hPa`
            };
        });

        console.log('[turbulence] points:', result.map(r => `t=${r.t.toFixed(2)} alt=${r.altFt}ft levels=${r.levelsUsed} shear=${r.shearKmh}`));

        res.json({ points: result });

    } catch (err) {
        console.error('[turbulence] error:', err);
        res.status(500).json({ error: 'Failed to fetch turbulence data' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});