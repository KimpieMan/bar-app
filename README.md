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

## Deployen op Netlify (gratis)

1. Push `Bar-App` naar GitHub.
2. In Netlify: **Add new site** -> **Import an existing project**.
3. Selecteer je repo en gebruik deze settings:
   - Build command: `npm run build`
   - Publish directory: `dist`
4. Voeg in Netlify bij **Site configuration -> Environment variables** toe:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
5. Deploy de site.

`netlify.toml` staat al in dit project met:
- juiste build settings
- SPA redirect (`/* -> /index.html`) zodat routes blijven werken

## Supabase opmerkingen

- De SQL activeert realtime op `persons` en `transactions`.
- RLS policies staan open (`using true`) zodat commissieleden via groepscode direct kunnen werken.
- Voor productie kun je later auth + strengere policies toevoegen.

## Datamodel

- `groups`: groep metadata + unieke code
- `persons`: commissie/deelnemers binnen een groep
- `transactions`: alle streepjes en betalingen
