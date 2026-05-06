# Spotify Top Songs

A browser-based app that shows your all-time top 50 most-played tracks on Spotify, with the option to save them as a private playlist on your account.

## Features

- Displays your top 50 tracks ranked by listening history
- Shows album art, track name, and artist for each song
- One-click save to a new private Spotify playlist

## Setup

**1. Create a Spotify app**

Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), log in, and create a new app. Copy your **Client ID**.

**2. Add your Client ID**

Open `app.js` and replace the placeholder on line 5:

```js
const CLIENT_ID = 'your-client-id-here';
```

**3. Register the redirect URI**

Serve the app over HTTP — OAuth won't work over `file://`:

```
npx serve .
```

When the page loads, it will display the redirect URI you need to register. Go back to your Spotify app's settings → **Redirect URIs** → add it → Save.

> **Note:** Spotify no longer accepts `http://localhost` as a redirect URI. Use `http://127.0.0.1:3000/` instead, and make sure to open the app at `http://127.0.0.1:3000` (not `localhost`) so the URIs match.

## Usage

1. Open the app in your browser at `http://127.0.0.1:3000`
2. Click **Connect with Spotify** and authorize the app
3. Your top 50 tracks will load automatically
4. Click **Save as Playlist on Spotify** to create a private playlist on your account

## How it works

Authentication uses the [OAuth 2.0 PKCE flow](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow) — no client secret is required or exposed in the browser. Tokens are stored in `sessionStorage` and automatically refreshed before they expire.

Track data is fetched from the [Spotify Web API](https://developer.spotify.com/documentation/web-api) using `time_range=long_term`, which reflects several years of listening history.

> **Limitation:** Spotify's `long_term` time range is described as "several years of data" that is a rolling window. Therefore `long_term` is not an accurate message of the complete history from when your account was created. Spotify uses a rolling window of several years and weights recent listening more heavily, so it is an approximation of your all-time preferences rather than a true lifetime record.
