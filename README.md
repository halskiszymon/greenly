# greenLy

**Your houseplants, watered on time. No guesswork.**

greenLy is a small, self-hosted web app (PWA) for looking after houseplants. Snap a photo, and it identifies the
species and builds a watering plan from the species *and* the spot the plant actually lives in: pot, light, dry air
and the time of year. A reminder lands on your phone on watering day. If the soil is still wet, one tap postpones it
and the plan quietly adapts.

It runs on a single Node.js process with SQLite, installs to the Home Screen like a native app, speaks Polish and
English, and is free and open source.

## Features

- **A photo instead of a field guide.** Identification through [Pl@ntNet](https://my.plantnet.org); type the name if
  you prefer. The species is matched to a care profile (species → genus → family → generic).
- **A plan for your conditions.** The interval follows the season on a smooth curve and is corrected for pot size and
  material, light and dry air. Each watering comes with an approximate amount in ml (orchids get "soak the pot").
- **Reminders on your phone.** Web push on watering day, one notification per person.
- **"Still wet" learns.** Postponing a watering is one tap. When it keeps happening, greenLy shrinks the portion and
  stretches the interval for that plant; calm cycles bring the defaults back.
- **Check-up and Doctor.** Send a photo to Claude for a condition rating, or describe a problem and get a diagnosis.
  The Doctor asks follow-up questions when something is missing. It can also write a species care profile.
- **Every plant's history.** Waterings, repotting, moving, feeding, pruning, division, notes and analyses on one
  timeline, with a lightbox for photos.
- **Accounts and invites.** Each person has their own plants, reminders and Claude key. Registration needs an invite
  code from the admin panel, where the admin also manages users and can share one Claude key with chosen people.
- **Feels like an app.** Installable PWA, instant paint from cache, works offline for reading, prompts for a refresh
  after each deploy.

## Use cases

- **You keep forgetting, or you overwater.** Most houseplants die from one or the other. greenLy tells you when, and
  the amount hint and "still wet" loop take care of the other half.
- **A plant looks off.** Photograph the yellow leaf, describe what changed, and let the Doctor narrow it down with
  questions instead of a generic checklist.
- **A shared home.** Everyone gets their own account and reminders on their own phone, invited by whoever hosts it.
- **Friends and family.** Host one instance, hand out invite codes, and optionally put everyone on your Claude key so
  they never need to set anything up.
- **Your own instance.** Fork it, change the care profiles in `care.json`, and run it on any Node host or Plesk.

## AI features and costs

Check-up, Doctor and species profiles use Claude through the Anthropic API. Every user brings their own API key (or the
admin assigns a shared one); greenLy adds nothing on top. One analysis with a photo usually costs 2–8 US cents,
depending on the model; the app shows the approximate cost under each result. Without a key everything else works.

## Quick start

Requirements: Node.js 22.13 or newer.

```bash
git clone https://github.com/halskiszymon/greenly.git
cd greenly
npm install
cp config.example.js config.js   # set at least `password`
npm start                        # http://localhost:8080
```

Log in with the login from `adminLogin` (default `admin`) and the `password` from `config.js`. Photo identification,
push reminders and Claude need keys; `GREENLY_FAKE_AI=1 npm start` swaps in canned analyses for trying the UI.

## Documentation

- [Installation and configuration](docs/INSTALL.md): config reference, API keys, push, cron, running in production,
  troubleshooting notifications, upgrading.
- [Deploying on Plesk](docs/DEPLOY-PLESK.md): step by step for Plesk's Node.js extension.
- [Architecture](docs/ARCHITECTURE.md): watering algorithm, care profiles, HTTP API, database, PWA, languages, Claude.
- [Security](SECURITY.md): security model, hardening checklist, how to report a vulnerability.

## Tech stack

Node.js with `node:http` and the built-in `node:sqlite`, no framework and no ORM. Plain HTML, CSS and ES modules on
the frontend, no bundler. Two runtime dependencies: [`web-push`](https://github.com/web-push-libs/web-push) and
[`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript). Tests use `node --test`.

## Contributing

Issues and pull requests are welcome. Keep the zero-build setup, run `npm test` before opening a PR, and add the
English translation for any new UI text in `public/i18n.js` (a test enforces it). Code, comments and docs are in
English.

## Contact

The reference instance is run by Szymon Halski — [greenly@freely.digital](mailto:greenly@freely.digital).
