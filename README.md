# Skyblush ✈️☁️

Skyblush is a flight and turbulence tracking web application that estimates wind shear and flight turbulence along actual flight routes using real-time aviation and meteorological data.

🚀 **Live Demo:** [https://skyblush.papulazad-a.workers.dev](https://skyblush.papulazad-a.workers.dev)

---

## 🌟 Features

* **Flight Tracking:** Fetch route details, schedules, and airport coordinates via AeroDataBox API.
* **Turbulence Forecasting:** Calculate altitude-aware wind shear using Open-Meteo atmospheric pressure data across 14 route sampling points.
* **Serverless Architecture:** Fully optimized for high performance and low latency on Cloudflare Workers.

---

## 🛠️ Tech Stack

* **Frontend:** HTML5, CSS3, JavaScript (Vanilla)
* **Backend Runtime:** Cloudflare Workers (Native Web Fetch API)
* **APIs Used:**
  * AeroDataBox (RapidAPI) – Flight route metadata
  * Open-Meteo – Historical & real-time weather/wind shear forecasts

---

## 🚀 Local Development

1. **Clone the repository:**
   ```bash
   git clone git@github.com:papulaza/skyblush.git
   cd skyblush