# What to do?

One button. One idea for what to do **right now**, matched to:

- **Your interests**: picked once on setup
- **The weather**: live from [Open-Meteo](https://open-meteo.com) (temperature, rain, clear skies, air quality)
- **The time of day**: no hiking at midnight, no clubbing at 10am
- **What you liked before**: 👍 and 🔄 teach the app over time
- **Your friends**: 👥 Invite shares a link; when a friend opens it, ideas favour what you have in common

Live: https://aleksandrenko.github.io/what-to-do/

## How it works

Everything runs in the browser. There is no server and no account, and your profile stays in your browser's local storage.

- `activities.js`: the "world": ~65 activities tagged with interests, indoor/outdoor, temperature range, daylight, time of day, price and group size
- `app.js`: matching. It **filters** out what doesn't fit right now (rain, cold, dark, closed, over budget), **scores** the rest (interests, friends' overlap, weather fit, past feedback, novelty), then picks one of the top few with a bit of randomness and explains why.
- "Let's go" opens Google Maps with a search for that activity near you.

## Not in this version (needs a server)

- Connecting Spotify / YouTube / social-media exports to build the interest profile automatically
- A scraped database of real local events
- Sponsored deals
- Meeting new people around activities

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.
