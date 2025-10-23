# Discord Crash Game Bot

This is a Discord bot that runs a "Crash" game within a channel using embeds. The game board is rendered as an image server-side and updated frequently.

## Setup Instructions

1) Create a Node.js Repl (or a local project with Node.js v18+).

2) Add the files from this project:
   - `bot.js`
   - `package.json`
   - `assets/rocket.svg` (and optionally `assets/background.png`)

3) Create a `.env` file by copying `.env.example`.

4) In your `.env` file (or in Replit Secrets), set your environment variables:
   - `DISCORD_TOKEN`: Your new Discord bot token.
   - `PUBLIC_URL`: (Optional but recommended) If running on a service like Replit, set this to your public URL (e.g., `https://<your-repl>.<your-username>.repl.co`). This helps ensure the embed image loads correctly.

5) In your shell/terminal, install dependencies and start the bot:
   ```bash
   npm install
   npm start
   ```

## How to Play

1) In your Discord server, run the setup command in the desired channel:
   `/setup start_balance:1000`

2) To verify the image rendering is working, run:
   `/crash testimage`
   This should post an embed with a static test image.

3) Start the game rounds:
   `/crash start`

The bot will now start running rounds (Countdown → Flying → Crash).

## Troubleshooting

If the image inside the embed is blank or not loading:
- Run the `/crash diag` command. It will show you the `PUBLIC_URL` the bot is using, the full URL for the embed frame, and whether assets have been loaded correctly.
- Ensure your `PUBLIC_URL` is set correctly and is accessible from the internet.