# Spotify Glass Widget

A minimal, glassmorphic Spotify Now Playing widget built with vanilla HTML, CSS, and JavaScript using Spotify's OAuth 2.0 PKCE flow.

## Features
- **Serverless Authentication:** Uses PKCE so no backend server or exposed Client Secret is required.
- **Sideways Queue Peek:** Hovering over the **Next** button smoothly expands a frosted drawer showing the next two upcoming album covers and the title of the next track.
- **Previous Track Peek:** Hovering over the **Previous** button reveals the last played song.
- **Interactive Controls:** Play/pause, skip, seek along the progress bar, save/unsave tracks to Liked Songs, and copy track links.

## Setup

1. **Create a Spotify App**
   - Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and click **Create app**.
   - Under **Redirect URIs**, add your local or hosted URL (e.g., `http://127.0.0.1:5500/index.html` or `https://<your-username>.github.io/<repo-name>/`).
   - Check **Web API** and save.

2. **Configure Client ID**
   - Copy your **Client ID** from the app settings.
   - Paste it into `app.js`:
     ```javascript
     const CLIENT_ID = "your_client_id_here";
     ```

3. **Run**
   - Serve the folder using VS Code **Live Server** (on `127.0.0.1`) or deploy directly via **GitHub Pages**.

## Requirements
- Spotify Premium is required by the Spotify Web API for playback controls (`play`, `pause`, `next`, `previous`, `seek`).