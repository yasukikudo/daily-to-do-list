# Our Daily List

A small web app for planning each day as a to-do list. Two people each get their own column on the same page, and changes appear on both screens in real time.

## Features

- **One page per day.** Two columns side by side (stacked on phones). You can edit only your own column; the other is read-only.
- **Quick status.** Tap a task's circle to cycle through done, missed, carry over, partly done, and missed + carry over.
- **Stamps.** Mark a task as done with one of about 60 emoji.
- **Carry over.** Bring yesterday's unfinished tasks into today with one tap.
- **Daily routines.** Tasks you do every day are added to each new day automatically.
- **Notes.** A short note for the day above each column, and an optional note on any task.
- **Week and month views.** A week strip and a month calendar show how much of each day's list got done.
- **Simple sign-in.** Enter your email once per device, then just a 6-digit PIN.
- **Works like an app.** Light and dark mode, and it can be installed to the home screen or dock (PWA).

## How it's built

- Plain HTML, CSS and JavaScript (ES modules). No framework and no build step.
- Hosted on **GitHub Pages**.
- **Firebase Authentication** for sign-in and **Cloud Firestore** for the lists, with real-time sync.
- Firestore security rules let only registered accounts read the lists, and let each person write only their own column.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page shell; shows load errors on screen |
| `app.js` | The app: sign-in, rendering, saving, calendar, settings |
| `style.css` | Layout, light / dark themes, mobile styles |
| `config.js` | Firebase web config (public by design) and app options |
| `manifest.webmanifest`, `icon-*.png` | Install info and icons |
