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

The page has to stay open on the child's phone (it keeps the screen awake while live); phones stop GPS for web pages in the background.

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
