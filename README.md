# Bar App - Scouting Schuldbeheer

Browser app voor commissieleden om streepjes en betalingen bij te houden per groep, met realtime synchronisatie via Supabase.

## Features

- Groep aanmaken en joinen met unieke code
- Realtime sync tussen gebruikers in dezelfde groep
- Bulk personen toevoegen, bewerken, verwijderen en zoeken (max 60)
- Streepjes per vrijdag registreren (vrijdag datum instelbaar)
- Meerdere streepjes op dezelfde dag worden automatisch opgeteld
- Betalingen registreren met notificatie
- Historische invoer aanpassen of verwijderen
- Maand- en jaarrapportage + Excel export
- Lijst met personen die nog moeten betalen
- Responsive UI (mobiel en desktop), wit met denim blue accenten

## Technologie

- React + TypeScript + Vite
- Supabase (Postgres + Realtime)
- `xlsx` voor export

## Lokale setup

1. Installeer dependencies:
   - `npm install`
2. Maak `.env` bestand op basis van `.env.example`.
3. Vul in:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Voer `supabase/schema.sql` uit in de Supabase SQL editor.
5. Start app:
   - `npm run dev`

## Deployen op Cloudflare Pages (gratis)

1. Push `Bar-App` naar GitHub.
2. Log in op [Cloudflare](https://dash.cloudflare.com) en ga naar **Pages**.
3. Klik **Create a project** -> **Connect to Git** en selecteer je repo.
4. Configureer de build settings:
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Node version: `22` (of hoger)
5. Voeg environment variables toe:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
6. Deploy!

`_redirects` staat in de `public/` folder voor SPA routing (`/* -> /index.html`)

## Supabase opmerkingen

- De SQL activeert realtime op `persons` en `transactions`.
- RLS policies staan open (`using true`) zodat commissieleden via groepscode direct kunnen werken.
- Voor productie kun je later auth + strengere policies toevoegen.

## Datamodel

- `groups`: groep metadata + unieke code
- `persons`: commissie/deelnemers binnen een groep
- `transactions`: alle streepjes en betalingen
