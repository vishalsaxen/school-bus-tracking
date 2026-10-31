# School Bus Tracking

Two apps for one school bus route, plus an Android app for the Bus Captain's phone:

| Folder         | App              | Who uses it | What it does |
|----------------|------------------|-------------|--------------|
| `bus-captain/` | **Bus Captain**  | The person on the bus | Signs in by OTP, sets up the route (school, route name, bus number, monthly fee, UPI ID), adds stops and students with their guardians' mobiles, shares the bus's live GPS, honks, sees "Child not going" alerts and confirms fee payments. |
| `guardians/`   | **Guardians**    | Parents and guardians | Sign in by OTP with the number the Bus Captain added, see the bus live with an ETA to their stop, tick the months and pay the transport fee by UPI, and tap **Not Going** to alert the Bus Captain. |
| `shared/`      | Shared code      | Both apps | Theme, Firebase config and helpers. |

Live sites (GitHub Pages from `main`):

- Bus Captain: https://vishalsaxen.github.io/school-bus-tracking/bus-captain/
- Guardians: https://vishalsaxen.github.io/school-bus-tracking/guardians/

## How a route works

1. The Bus Captain opens Bus Captain, signs in with their mobile (OTP), and fills in **Route, fees and UPI**. Fees are per route, so each Bus Captain sets their own route's monthly fee.
2. On the **Stops** tab they add each stop while standing at it (or add it and drag it on the map).
3. On the **Students** tab they add each child with a stop and one or two guardian mobiles.
4. Each guardian opens Guardians and signs in by OTP with that mobile. Only numbers the Bus Captain added can open the route.
5. While the Bus Captain shares, guardians see the bus on the map, the next stop and minutes to their own stop. **Honk** sends guardians an alert.
6. **Fees:** the guardian ticks one or more months, the **Pay fee** button turns on with the total (months × the route's fee) and opens their UPI app (Google Pay, PhonePe, Paytm, BHIM) to the route's UPI ID. Back in the app they confirm it went through (with the UPI reference if they like). The Bus Captain sees it under **Alerts** and marks it **Received** or **Not received**. There is no payment gateway, so the app records what the guardian reports and the Bus Captain confirms it.
7. **Not Going:** the guardian picks the child, the day (today, tomorrow or a date) and pickup, drop or both. The Bus Captain gets it under **Alerts**, and the child is tagged "Not going today".

## Guardians Android app (lock-screen alerts)

- Download: https://github.com/vishalsaxen/school-bus-tracking/releases/latest/download/guardians.apk
- It shows the Guardians page and runs a background watcher. While the bus is sharing it checks every ~20 seconds and keeps a notification up to date ("Bus 1.2 km from Sunrise Valley · about 4 min"). With the phone locked it alerts once per trip when the bus is about 5 minutes from the child's stop, and whenever the Bus Captain presses Honk. When the bus is not sharing it checks every ~2 minutes to save battery.
- It reads the same `routes/{captain}` document as the website, signed in as the guardian, so it needs no server and no rule changes.

## Android app (`android/`) for the Bus Captain

- Download: https://github.com/vishalsaxen/school-bus-tracking/releases/latest/download/bus-captain.apk
- It shows the Bus Captain page and runs a background service that keeps sending the bus location every ~15 seconds with the screen locked. A phone browser stops GPS when the screen locks, so the Bus Captain should use the app.
- Both apps are built from `android/` as two product flavors (`captain` and `guardian`) by GitHub Actions (`.github/workflows/android.yml`); pushes to `main` publish a new release with both APKs. `android/app/beacon-go.keystore` signs every build with the same key, so new versions install over old ones.

## Data (Cloud Firestore)

- `routes/{Bus Captain's +91 number}`: school, route name, bus number, fee, UPI ID, stops, trip, live location, and `guardians` (who may open the route).
- `routes/{…}/students/{id}`: child's name, stop and `family` (their guardians' mobiles).
- `routes/{…}/notices/{id}`: "Child not going" alerts.
- `routes/{…}/payments/{id}`: fee payments reported by guardians, with the Bus Captain's received / not received.

[`firestore.rules`](firestore.rules) lets the Bus Captain manage their route, lets a guardian see the route and only their own child, notices and payments, and keeps everyone else out.

## One-time Firebase setup

Project `school-bus-tracking-9a46e` (config in `shared/firebase-config.js`):

- Authentication > Sign-in method > **Phone** enabled; `vishalsaxen.github.io` in Authorized domains; Blaze plan for real SMS.
- **Firestore Database** created (location `asia-south1`, Mumbai).
- The rules in [`firestore.rules`](firestore.rules) published under Firestore Database > Rules. **Publish them again whenever this file changes.**

## Run locally

Plain HTML, CSS and JavaScript with no build step:

```sh
npx serve .
```

then open `/bus-captain/` and `/guardians/`. To test without real SMS, run the Firebase emulators (`firebase emulators:start --only auth,firestore`) and open the pages on `localhost` with `?emulator`.
