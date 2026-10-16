# School Bus Tracking

Two apps live in this repo as separate code sections:

| Folder    | App                        | What it does |
|-----------|----------------------------|--------------|
| `child/`  | **Beacon Go** (child app)  | Runs on the child's phone. Shares live GPS, keeps Child Details (bus, child's mobile, both parents' mobiles verified by OTP). |
| `parent/` | **Beacon** (parent app)    | Parents sign in with their mobile (OTP) and see their child moving on a live map. |

Live sites (GitHub Pages from `main`):

- Child: https://vishalsaxen.github.io/school-bus-tracking/child/
- Parent: https://vishalsaxen.github.io/school-bus-tracking/parent/

## How live location reaches parents

1. In Beacon Go > Child Details, add the child with **the child's own mobile** and both parents' mobiles.
2. On the child's phone, tap **Link phone** on the Tracker tab, pick the child and enter the OTP sent to the child's mobile.
3. From then on the phone saves its location to Firebase (Cloud Firestore) about every 10 seconds while sharing is on, at `children/{child's +91 number}`.
4. Either parent opens Beacon, signs in with their own mobile, and sees the child live on the map.
5. When the child taps **Send**, the location goes out at once and parents get a "sent you their location" alert in Beacon (a phone notification too if they turn on alerts and the page is in the background).

In a phone browser the page has to stay open, because phones stop GPS for web pages once the screen locks. For real use, install the **Beacon Go Android app** on the child's phone: it shows the same child page, and a background service keeps sending the location every ~15 seconds with the screen locked (a "Sharing location with parents" notification shows while it runs).

## Android app (`android/`)

- Download: https://github.com/vishalsaxen/school-bus-tracking/releases/latest/download/beacon-go.apk (open on the child's phone, allow installing from this source).
- Built by GitHub Actions (`.github/workflows/android.yml`) on every change to `android/`; pushes to `main` publish a new release.
- The app is a WebView of `child/` plus a foreground location service. The page hands the signed-in child's Firebase session to the service through `window.BeaconAndroid`, and the service writes the same `children/{number}` document through the Firestore REST API, so the parent app and `firestore.rules` need no changes.
- `android/app/beacon-go.keystore` signs every build with the same key so new versions install over old ones.

## One-time Firebase setup

Project `school-bus-tracking-9a46e` (config in `child/firebase-config.js` and `parent/firebase-config.js`):

- Authentication > Sign-in method > **Phone** enabled; `vishalsaxen.github.io` in Authorized domains; Blaze plan for real SMS.
- **Firestore Database** created (location `asia-south1`, Mumbai).
- The rules in [`firestore.rules`](firestore.rules) published under Firestore Database > Rules.

## Run locally

Plain HTML, CSS and JavaScript with no build step:

```sh
npx serve .
```

then open `/child/` and `/parent/`.
