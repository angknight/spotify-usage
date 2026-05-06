// ── Configuration ────────────────────────────────────────────────────────────
// 1. Create an app at https://developer.spotify.com/dashboard and copy your Client ID.
// 2. Paste it below.
// 3. In your Spotify app settings → Redirect URIs, add the URL shown on screen when you open the app.
const CLIENT_ID = 'YOUR_CLIENT_ID_HERE';

// Serve the folder over HTTP (OAuth requires it — file:// won't work):
//   npx serve .
//
// How it works:
// - Auth:        OAuth 2.0 PKCE — no client secret exposed in the browser
// - Tracks:      up to 50 tracks via time_range=long_term (several years of listening history)
// - Playlist:    creates a private playlist on your account with all 50 tracks
// - Tokens:      stored in sessionStorage, auto-refreshed 60s before expiry
// - Rate limits: exponential backoff + respects Retry-After on 429s

const CONFIG = {
    clientId: CLIENT_ID,
    // Computed so it works on any port (127.0.0.1 required for local dev)
    redirectUri: window.location.origin + window.location.pathname,
    scopes: ['user-top-read', 'playlist-modify-private'],
    authEndpoint: 'https://accounts.spotify.com/authorize',
    tokenEndpoint: 'https://accounts.spotify.com/api/token',
    apiBase: 'https://api.spotify.com/v1',
};

// ── Token storage (sessionStorage — cleared when tab closes) ─────────────────
const storage = {
    set: (key, val) => sessionStorage.setItem(`sp_${key}`, val),
    get: (key) => sessionStorage.getItem(`sp_${key}`),
    remove: (key) => sessionStorage.removeItem(`sp_${key}`),
    clear: () => ['access_token', 'refresh_token', 'expires_at', 'code_verifier']
        .forEach(k => sessionStorage.removeItem(`sp_${k}`)),
};

// ── PKCE helpers ──────────────────────────────────────────────────────────────
function base64urlEncode(buffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generateCodeVerifier() {
    return base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

async function generateCodeChallenge(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return base64urlEncode(digest);
}

// ── Authorization Code + PKCE flow ────────────────────────────────────────────
async function login() {
    const verifier = await generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    storage.set('code_verifier', verifier);

    const params = new URLSearchParams({
        client_id: CONFIG.clientId,
        response_type: 'code',
        redirect_uri: CONFIG.redirectUri,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        scope: CONFIG.scopes.join(' '),
    });

    window.location.href = `${CONFIG.authEndpoint}?${params}`;
}

async function exchangeCodeForToken(code) {
    const verifier = storage.get('code_verifier');
    storage.remove('code_verifier');

    const res = await fetch(CONFIG.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: CONFIG.redirectUri,
            client_id: CONFIG.clientId,
            code_verifier: verifier,
        }),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error_description || 'Authorization failed');
    }

    storeTokens(await res.json());
}

async function refreshAccessToken() {
    const refreshToken = storage.get('refresh_token');
    if (!refreshToken) {
        storage.clear();
        throw new Error('Session expired — please log in again');
    }

    const res = await fetch(CONFIG.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: CONFIG.clientId,
        }),
    });

    if (!res.ok) {
        storage.clear();
        throw new Error('Session expired — please log in again');
    }

    storeTokens(await res.json());
}

function storeTokens({ access_token, refresh_token, expires_in }) {
    storage.set('access_token', access_token);
    if (refresh_token) storage.set('refresh_token', refresh_token);
    storage.set('expires_at', Date.now() + expires_in * 1000);
}

async function getAccessToken() {
    const expiresAt = parseInt(storage.get('expires_at') || '0', 10);
    // Refresh 60 seconds before expiry
    if (Date.now() > expiresAt - 60_000) {
        await refreshAccessToken();
    }
    return storage.get('access_token');
}

// ── API fetch with exponential backoff on 429 ─────────────────────────────────
async function apiFetch(path, options = {}, attempt = 0) {
    const token = await getAccessToken();

    const res = await fetch(`${CONFIG.apiBase}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...options.headers,
        },
    });

    if (res.status === 429 && attempt < 4) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '1', 10);
        const delay = Math.max(retryAfter * 1000, Math.pow(2, attempt) * 1000);
        await new Promise(r => setTimeout(r, delay));
        return apiFetch(path, options, attempt + 1);
    }

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message || `Spotify error ${res.status}`);
    }

    return res.status === 204 ? null : res.json();
}

// ── Spotify API calls ─────────────────────────────────────────────────────────
async function getTopTracks() {
    // long_term = several years of data (best available "all-time" approximation)
    const data = await apiFetch('/me/top/tracks?time_range=long_term&limit=50');
    return data.items;
}

async function getCurrentUser() {
    return apiFetch('/me');
}

async function createPlaylist(userId) {
    return apiFetch(`/users/${userId}/playlists`, {
        method: 'POST',
        body: JSON.stringify({
            name: 'My All-Time Top Songs',
            description: 'My most-played tracks on Spotify. Content provided by Spotify.',
            public: false,
        }),
    });
}

async function addTracksToPlaylist(playlistId, uris) {
    // API max is 100 URIs per request
    for (let i = 0; i < uris.length; i += 100) {
        await apiFetch(`/playlists/${playlistId}/items`, {
            method: 'POST',
            body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
        });
    }
}

// ── URL safety guard ──────────────────────────────────────────────────────────
function isSafeHttpsUrl(url) {
    try {
        return new URL(url).protocol === 'https:';
    } catch {
        return false;
    }
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setStatus(text, isError = false, link = null) {
    const el = document.getElementById('status');
    el.textContent = text;
    el.className = isError ? 'error' : '';

    if (link && isSafeHttpsUrl(link.url)) {
        el.textContent = text + ' ';
        const a = document.createElement('a');
        a.href = link.url;
        a.textContent = link.label;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        el.appendChild(a);
    }
}

function renderTracks(tracks) {
    const list = document.getElementById('tracks-list');
    list.innerHTML = '';

    tracks.forEach((track, i) => {
        const item = document.createElement('div');
        item.className = 'track-item';

        const rank = document.createElement('span');
        rank.className = 'rank';
        rank.textContent = i + 1;

        // Prefer smallest image (index 2 = 64px), fall back to largest
        const imgData = track.album.images[2] ?? track.album.images[0];
        if (imgData && isSafeHttpsUrl(imgData.url)) {
            const img = document.createElement('img');
            img.src = imgData.url;
            img.alt = '';
            img.width = 40;
            img.height = 40;
            item.appendChild(rank);
            item.appendChild(img);
        } else {
            const placeholder = document.createElement('div');
            placeholder.className = 'img-placeholder';
            item.appendChild(rank);
            item.appendChild(placeholder);
        }

        const info = document.createElement('div');
        info.className = 'track-info';

        const name = document.createElement('span');
        name.className = 'track-name';
        name.textContent = track.name;

        const artist = document.createElement('span');
        artist.className = 'track-artist';
        artist.textContent = track.artists.map(a => a.name).join(', ');

        info.appendChild(name);
        info.appendChild(artist);
        item.appendChild(info);
        list.appendChild(item);
    });
}

async function handleCreatePlaylist(tracks) {
    const btn = document.getElementById('create-playlist-btn');
    btn.disabled = true;
    setStatus('Creating playlist on your Spotify account…');

    try {
        const user = await getCurrentUser();
        const playlist = await createPlaylist(user.id);
        await addTracksToPlaylist(playlist.id, tracks.map(t => t.uri));

        const spotifyUrl = playlist.external_urls?.spotify;
        setStatus(
            `Playlist created! Open it in Spotify:`,
            false,
            spotifyUrl ? { url: spotifyUrl, label: 'My All-Time Top Songs →' } : null
        );
        btn.textContent = 'Playlist Created ✓';
    } catch (err) {
        setStatus(err.message, true);
        btn.disabled = false;
    }
}

// ── App init ──────────────────────────────────────────────────────────────────
async function init() {
    // Show the redirect URI the user needs to register in their Spotify app
    if (CLIENT_ID === 'YOUR_CLIENT_ID_HERE') {
        const note = document.getElementById('redirect-uri-note');
        const link = document.createElement('a');
        link.href = 'https://developer.spotify.com/dashboard';
        link.textContent = 'Spotify Developer Dashboard';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        note.append('Setup: add this Redirect URI to your ', link, ` → ${CONFIG.redirectUri}`);
    }

    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const error = params.get('error');

    // Clean the ?code= from the address bar before anything else
    if (code || error) {
        window.history.replaceState({}, '', window.location.pathname);
    }

    if (error) {
        setStatus(`Authorization denied: ${error}`, true);
        return;
    }

    if (code) {
        try {
            await exchangeCodeForToken(code);
        } catch (err) {
            setStatus(err.message, true);
            return;
        }
    }

    const token = storage.get('access_token');

    if (!token) {
        document.getElementById('login-btn').addEventListener('click', login);
        return;
    }

    document.getElementById('auth-section').hidden = true;
    document.getElementById('tracks-section').hidden = false;
    setStatus('Loading your all-time top tracks…');

    let tracks;
    try {
        tracks = await getTopTracks();
    } catch (err) {
        setStatus(err.message, true);
        return;
    }

    renderTracks(tracks);
    setStatus('');

    document.getElementById('create-playlist-btn')
        .addEventListener('click', () => handleCreatePlaylist(tracks));
}

init();
