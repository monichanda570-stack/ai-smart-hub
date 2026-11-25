# AI Smart Hub V2 — Public Free AI Platform (Windows 10)

## Included
- Public registration, login and logout
- OpenAI Responses API and Google Gemini Interactions API provider selector
- AI Chat, Writer, Coding, Study and Summarizer modes
- OpenAI image generation
- Per-user chat history stored in local JSON database
- Free daily usage limits (configurable)
- Basic admin overview
- HttpOnly session cookie, bcrypt password hashes, rate limiting
- Bangla/English UI switch

## Requirements
- Windows 10
- Node.js LTS (install from https://nodejs.org/)
- At least one AI API key:
  - OpenAI: https://platform.openai.com/api-keys
  - Gemini: https://aistudio.google.com/apikey

API usage is not automatically free. "Free platform" means this starter does not charge your users. The owner pays the providers' API charges. Set strict provider-side budget alerts/limits. Provider free tiers and availability can change.

## Install on Windows 10
1. Extract `AI-Smart-Hub-V2.zip`.
2. Open the `ai-smart-hub-v2` folder in File Explorer.
3. Click the address bar, type `cmd`, press Enter.
4. Run `npm install`.
5. Copy `.env.example` and rename the copy to `.env`.
6. Open `.env` in Notepad and configure:
   - `JWT_SECRET`: replace with a random secret of at least 32 characters.
   - `OPENAI_API_KEY`: optional, but needed for OpenAI chat and image generation.
   - `GEMINI_API_KEY`: optional, but needed for Gemini chat.
   - `ADMIN_EMAIL`: set to your own email before registering.
   - `ADMIN_SETUP_TOKEN`: set a second long private code. During registration, enter this code only for your own admin account.
7. Save `.env`.
8. Run `npm start`.
9. Open `http://localhost:3000` in Chrome or Edge.
10. Register with the exact `ADMIN_EMAIL` value to receive the admin role.

To stop the server, focus the Command Prompt window and press `Ctrl + C`.

## Important provider configuration
- You can configure OpenAI only, Gemini only, or both.
- Chat model defaults are examples: `gpt-5.5` and `gemini-3.8-flash`. Change these in `.env` if your API account does not have access to the configured model.
- Image generation currently uses OpenAI Images API and requires an image-capable model available to your project.
- OpenAI and Gemini API keys stay on the server in `.env`; do not put them in `public/` files or share them.
- ChatGPT subscriptions and API billing are separate. API requests can cost money.

## Free usage limits
Default limits:
- 25 chat requests per user per UTC day
- 2 image generations per user per UTC day

Change `DAILY_CHAT_LIMIT` and `DAILY_IMAGE_LIMIT` in `.env`. Set image limit to `0` to disable image generation for all users.

## Admin
Set both `ADMIN_EMAIL` and `ADMIN_SETUP_TOKEN` before you register. During registration, use the matching email and the private admin setup code to receive the `admin` role. Admin overview is available from the left sidebar. Never share the admin setup code. This is a bootstrap convenience for the local MVP; production needs verified email and a hardened admin invitation flow.

## Data and backups
User and conversation data are stored in `data/db.json`. Back up this file regularly. This JSON-file database is suitable only for a small local MVP. For a real public launch, migrate to PostgreSQL or another managed database before allowing significant traffic.

## Public hosting — important
This code is designed to run locally on Windows 10 first. Do not expose this development server directly to the public internet. Before launch, implement:
- PostgreSQL/managed database and automated backups
- Email verification, password reset, account deletion and privacy policy
- CSRF protection and secure production cookie/domain configuration
- Stronger abuse detection, moderation, per-user and per-IP quotas
- Provider cost controls, logs and monitoring
- HTTPS, secure deployment, secret management and admin audit logs
- Terms of service and data retention controls

The current admin overview is read-only. This starter has no payment system and does not charge users.

## Official API docs
OpenAI Responses API: https://developers.openai.com/api/docs/guides/migrate-to-responses
OpenAI API key security: https://developers.openai.com/api/reference/overview
Gemini API getting started: https://ai.google.dev/gemini-api/docs/get-started
Gemini Interactions API: https://ai.google.dev/api/interactions-api
