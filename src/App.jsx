import { useEffect, useMemo, useState } from "react";
import "./styles.css";

/* ---------- Helpers ---------- */
const WMO_TO_EMOJI = (code) => {
  if (code === 0) return "☀️";
  if (code === 1) return "🌤️";
  if (code === 2) return "⛅";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌦️";
  if ((code >= 61 && code <= 65) || (code >= 80 && code <= 82)) return "🌧️";
  if (code === 66 || code === 67) return "🌧️🧊";
  if ((code >= 71 && code <= 75) || code === 77) return "❄️";
  if (code === 85 || code === 86) return "🌨️";
  if (code === 95) return "⛈️";
  if (code === 96 || code === 99) return "⛈️🧊";
  return "·";
};

const toYMD = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const lastDayOfMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0);

function monthMatrix(viewDate) {
  const first = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay()); // Sunday start
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const row = [];
    for (let d = 0; d < 7; d++) {
      const cell = new Date(start);
      cell.setDate(start.getDate() + w * 7 + d);
      row.push(cell);
    }
    weeks.push(row);
  }
  return weeks;
}

const mmToIn = (mm) => (mm == null ? null : (mm / 25.4).toFixed(2));

/* Hour label: "2025-08-14T13:00" -> "1p" */
const hourLabel = (iso) => {
  const d = new Date(iso);
  let h = d.getHours();
  const suff = h >= 12 ? "p" : "a";
  h = h % 12; if (h === 0) h = 12;
  return `${h}${suff}`;
};

/* ---------- Hooks ---------- */

// Geocode by city name (press Search to update)
function useGeocode(city) {
  const [geo, setGeo] = useState(null);
  const [status, setStatus] = useState("idle");

  useEffect(() => {
    if (!city) return;
    let cancelled = false;

    async function go() {
      setStatus("loading");
      try {
        const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
        url.search = new URLSearchParams({
          name: city,
          count: "1",
          language: "en",
          format: "json",
        }).toString();

        const res = await fetch(url.toString());
        if (!res.ok) throw new Error("geocode failed");
        const json = await res.json();
        const first = json?.results?.[0];
        if (!first) {
          if (!cancelled) {
            setGeo(null);
            setStatus("empty");
          }
          return;
        }
        if (!cancelled) {
          setGeo({
            lat: first.latitude,
            lon: first.longitude,
            label: `${first.name}, ${first.admin1 ?? first.country_code ?? ""}`.trim(),
          });
          setStatus("ready");
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setGeo(null);
          setStatus("error");
        }
      }
    }
    go();
    return () => { cancelled = true; };
  }, [city]);

  return { geo, status };
}

// Forecast for the current month but clamped to ~15-day horizon
function useForecast(lat, lon, viewDate) {
  const [data, setData] = useState({});
  const [status, setStatus] = useState("idle");

  const monthStart = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
  const monthEnd = lastDayOfMonth(viewDate);

  const today = new Date();
  const horizonStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const horizonEnd = new Date(horizonStart);
  horizonEnd.setDate(horizonEnd.getDate() + 15);

  const reqStart = monthStart > horizonStart ? monthStart : horizonStart;
  const reqEnd = monthEnd < horizonEnd ? monthEnd : horizonEnd;

  useEffect(() => {
    let cancelled = false;

    if (lat == null || lon == null) {
      setData({});
      setStatus("idle");
      return;
    }

    if (reqStart > reqEnd) {
      setData({});
      setStatus("ready");
      return;
    }

    async function go() {
      setStatus("loading");
      try {
        const url = new URL("https://api.open-meteo.com/v1/forecast");
        url.search = new URLSearchParams({
          latitude: String(lat),
          longitude: String(lon),
          daily: "weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum",
          timezone: "auto",
          start_date: toYMD(reqStart),
          end_date: toYMD(reqEnd),
        }).toString();

        const res = await fetch(url.toString());
        if (!res.ok) {
          console.warn("forecast not ok", await res.text());
          setData({});
          setStatus("ready");
          return;
        }
        const json = await res.json();
        if (!json.daily || !json.daily.time) {
          setData({});
          setStatus("ready");
          return;
        }
        const byDate = {};
        json.daily.time.forEach((iso, i) => {
          byDate[iso] = {
            date: iso,
            code: json.daily.weathercode[i],
            tMax: json.daily.temperature_2m_max[i],
            tMin: json.daily.temperature_2m_min[i],
            precipMM: json.daily.precipitation_sum[i],
          };
        });
        if (!cancelled) {
          setData(byDate);
          setStatus("ready");
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setData({});
          setStatus("ready");
        }
      }
    }
    go();
    return () => { cancelled = true; };
  }, [lat, lon, viewDate]); // eslint-disable-line

  return { data, status, reqStart, reqEnd };
}

// Hourly for a specific local date (used by the Day Sheet)
function useHourly(lat, lon, isoDate) {
  const [hours, setHours] = useState([]);
  const [status, setStatus] = useState("idle");

  useEffect(() => {
    let cancelled = false;
    if (!lat || !lon || !isoDate) { setHours([]); setStatus("idle"); return; }

    (async () => {
      setStatus("loading");
      try {
        const url = new URL("https://api.open-meteo.com/v1/forecast");
        url.search = new URLSearchParams({
          latitude: String(lat),
          longitude: String(lon),
          timezone: "auto",
          start_date: isoDate,
          end_date: isoDate,
          hourly: "weathercode,temperature_2m,precipitation_probability,wind_speed_10m",
        }).toString();

        const res = await fetch(url.toString());
        if (!res.ok) { setHours([]); setStatus("ready"); return; }
        const json = await res.json();
        const h = json?.hourly;
        if (!h?.time) { setHours([]); setStatus("ready"); return; }

        const rows = h.time.map((t, i) => ({
          time: t,
          code: h.weathercode?.[i],
          temp: h.temperature_2m?.[i],
          pop: h.precipitation_probability?.[i],
          wind: h.wind_speed_10m?.[i],
        }));
        if (!cancelled) { setHours(rows); setStatus("ready"); }
      } catch (e) {
        console.error(e);
        if (!cancelled) { setHours([]); setStatus("ready"); }
      }
    })();

    return () => { cancelled = true; };
  }, [lat, lon, isoDate]);

  return { hours, status };
}

/* ---------- Day Sheet (modal) ---------- */
function DaySheet({ isoDate, cityLabel, lat, lon, onClose }) {
  const { hours, status } = useHourly(lat, lon, isoDate);

  return (
    <div className="modal" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div>
            <div className="sheet-title">
              {new Date(isoDate).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
            </div>
            <div className="sheet-sub">{cityLabel}</div>
          </div>
          <button className="close" onClick={onClose}>✕</button>
        </div>

        {status === "loading" && <div className="hint">Loading hourly…</div>}
        {status === "ready" && hours.length === 0 && <div className="hint">No hourly data.</div>}

        {hours.length > 0 && (
          <div className="hour-row">
            {hours.map((h) => (
              <div key={h.time} className="hour-card">
                <div className="hour">{hourLabel(h.time)}</div>
                <div className="big-emoji">{WMO_TO_EMOJI(h.code)}</div>
                <div className="temp">{Math.round(h.temp)}°</div>
                <div className="meta">💧 {h.pop ?? 0}%</div>
                <div className="meta">💨 {Math.round(h.wind ?? 0)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- App ---------- */
export default function App() {
  // UI: city search box + a committed "currentCity"
  const [cityInput, setCityInput] = useState("New York");
  const [currentCity, setCurrentCity] = useState("New York");

  // Month being viewed
  const [viewDate, setViewDate] = useState(new Date());

  // For hourly modal
  const [selectedISO, setSelectedISO] = useState(null);

  // Geocode + forecast
  const { geo, status: geoStatus } = useGeocode(currentCity);
  const { data, status: wxStatus, reqStart, reqEnd } = useForecast(
    geo?.lat ?? null,
    geo?.lon ?? null,
    viewDate
  );

  const weeks = useMemo(() => monthMatrix(viewDate), [viewDate]);

  const changeMonth = (delta) => {
    const d = new Date(viewDate);
    d.setMonth(d.getMonth() + delta);
    setViewDate(d);
  };

  const monthLabel = viewDate.toLocaleString(undefined, { month: "long", year: "numeric" });
  const noForecast = wxStatus === "ready" && Object.keys(data).length === 0;

  return (
    <div className="app">
      <header className="toolbar">
        <h1>Emoji Weather Calendar</h1>
        <div className="controls">
          <button onClick={() => changeMonth(-1)}>◀︎</button>
          <div className="month">{monthLabel}</div>
          <button onClick={() => changeMonth(1)}>▶︎</button>
        </div>
        <form
          className="loc"
          onSubmit={(e) => {
            e.preventDefault();
            setCurrentCity(cityInput.trim());
          }}
        >
          <input
            placeholder="Search city…"
            value={cityInput}
            onChange={(e) => setCityInput(e.target.value)}
          />
          <button type="submit">Search</button>
        </form>
      </header>

      <div className="legend">
        ☀️ Clear • 🌤️ Mostly clear • ⛅ Partly • ☁️ Cloudy • 🌧️ Rain • 🌦️ Showers • ⛈️ Storm • ❄️ Snow • 🌫️ Fog
      </div>

      {geoStatus === "loading" && <p className="hint">Finding “{currentCity}”…</p>}
      {geoStatus === "empty" && <p className="error">City not found. Try another name.</p>}
      {geoStatus === "error" && <p className="error">Geocoding failed. Check your connection.</p>}
      {wxStatus === "loading" && <p className="hint">Loading forecast…</p>}
      {noForecast && (
        <p className="hint">
          No forecast available for the full month (free API covers ~16 days).
          Try the current/next two weeks or navigate months.
        </p>
      )}

      {geo && (
        <p className="hint">
          📍 {geo.label} • Request window: {toYMD(reqStart)} → {toYMD(reqEnd)}
        </p>
      )}

      <section className="grid">
        {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => (
          <div key={d} className="dow">{d}</div>
        ))}
        {weeks.flat().map((d) => {
          const iso = toYMD(d);
          const inMonth = d.getMonth() === viewDate.getMonth();
          const day = data[iso];
          const emoji = day ? WMO_TO_EMOJI(day.code) : "·";
          return (
            <div
              key={iso}
              className={`cell ${inMonth ? "" : "dim"}`}
              onClick={() => day && setSelectedISO(iso)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => (e.key === "Enter" && day ? setSelectedISO(iso) : null)}
            >
              <div className="cell-head">
                <span className="date">{d.getDate()}</span>
                <span className="emoji" aria-label="weather">{emoji}</span>
              </div>
              {day ? (
                <div className="stats">
                  <div className="temps">
                    <span className="hi">{Math.round(day.tMax)}°</span>
                    <span className="lo">{Math.round(day.tMin)}°</span>
                  </div>
                  <div className="precip">💧 {mmToIn(day.precipMM)} in</div>
                </div>
              ) : (
                <div className="stats muted">No data</div>
              )}
            </div>
          );
        })}
      </section>

      {selectedISO && geo && (
        <DaySheet
          isoDate={selectedISO}
          cityLabel={geo.label}
          lat={geo.lat}
          lon={geo.lon}
          onClose={() => setSelectedISO(null)}
        />
      )}
    </div>
  );
}
