# Venue Tours

A shared tracker for wedding venue tours. Two people can both edit it from their phones, and changes sync live. Each venue has:

- status, tour date, location and a website link
- each person's own 1–5 rating
- photos taken during the tour, plus PDFs and other files the venue sends
- a checklist of questions to ask, with space for their answers
- available dates, each marked open, on hold or a favorite
- costs (site fee, food and drink per guest, F&B minimum, service charge, tax) rolled into an all-in estimate compared with your budget
- what they offer, plus tagged feedback notes

The main page shows every venue as a card, a compare table, and a roll-up of open dates across venues. **Download notes** saves everything as a readable Markdown file. **Download backup** saves the raw data as JSON.

It's a static site (`index.html` + `app.js`) hosted on GitHub Pages, backed by a Firebase Realtime Database.

## Privacy: the access code

All data is stored under `venuetracker/<ACCESS CODE>/` in the database. The code is not in this repo. The database rules refuse to list which codes exist, so only people who know the code can read or change the tracker. Treat the code like a password: share it only with your partner. Anyone who has it can see and edit everything.

Codes must be at least 16 characters, like `VENUE-XXXX-XXXX-XXXX`. When you enter a code nobody has used yet, the app offers to start a new, empty tracker with it.

## Setup (one time, about 10 minutes)

1. **Create a Firebase project.** At https://console.firebase.google.com click *Add project*. Google Analytics isn't needed.
2. **Create the database.** In the project, go to *Build → Realtime Database → Create database*. Pick a location and start in **locked mode**.
3. **Publish the rules.** On the database's *Rules* tab, replace everything with the contents of [`database.rules.json`](database.rules.json) and click *Publish*.
4. **Register a web app.** Go to *Project settings → General → Your apps → Web (`</>`)*, give it any nickname (skip Firebase Hosting), and copy the `firebaseConfig` values into [`firebase-config.js`](firebase-config.js). Check that `databaseURL` is included; if it's missing, copy it from the top of the Realtime Database page.
5. **Turn on GitHub Pages.** In this repo, go to *Settings → Pages → Build and deployment*, choose *Deploy from a branch*, then `main` and `/ (root)`. After a minute the app is live at `https://<your-username>.github.io/<repo-name>/`.
6. Open the site, enter your access code and first name, and start the tracker.

The free Firebase (Spark) plan is enough: 1 GB of storage and 10 GB of downloads a month. Photos are resized to about 1800px (roughly 300 KB each) and stored in the database itself, so you don't need Cloud Storage or a billing account. Files can be up to 10 MB each.

## Running locally

```
node serve.js
```

Then open http://localhost:8765.
