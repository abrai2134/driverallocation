# Driver Allocation

A small website that **automatically decides which driver serves which unit each day**, fairly.

- **Equal duty** – the drivers with the fewest duties so far always get the next ones.
- **Rotation** – each driver is sent to the units they have visited least, so everyone covers every unit.
- **No back-to-back repeats** – a driver avoids the same unit two working days in a row.
- **Vehicle needs per driver** – each unit lists the drivers it needs in priority order. Every driver slot has a **1st choice** vehicle (2W/3W/4W/any) and a **2nd choice** used when no 1st-choice driver is free (another type, any other vehicle, or none). Must-have slots (e.g. 1 = 2W, 2 = 4W) are filled with the right vehicle before less important ones.
- **Shortage handling** – if there are more slots than drivers, only the least important slot (the last one in a unit's list) is left empty, and that shortage rotates between units.
- **Emergency driver** – a unit can ask for one more driver for today (or up to 6 days ahead). Only free drivers are offered; once taken, that driver is reserved for that unit, and the other units, the driver and the admin all see it.
- **Leave** – mark a driver absent; today only their slot is filled with a free driver, and the following days are re-balanced.
- **New units / drivers** – add them any time. A new driver starts level with the others, so they don't get extra days to "catch up".
- Plans **14 days ahead** automatically (changeable), skips weekly off days and holidays.

## Three logins

| Login | Who | What they see |
|-------|-----|---------------|
| **Admin** | You | Today's plan, full schedule (change any slot by tapping it), add/edit units and drivers, leave, fairness report, settings, backup |
| **Unit** | Each unit's person | Today's driver with a **Call** button, vehicle no., and the next 6 days |
| **Driver** | Each driver | Which unit to go to today (address, contact, **Call** and **Map** buttons) and the next 6 days |

The admin creates the login ID and password for every unit and driver (driver login ID defaults to their phone number).

## Try it on your computer

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm run demo     # optional: adds 7 sample units and 8 sample drivers
npm start        # open http://localhost:3000
```

First login: **admin / admin123**. Change it straight away in *Settings*.

Demo logins (only if you ran `npm run demo`): units `unit1`/`unit1` … `unit7`/`unit7`, drivers `9930000001`/`1234` … `9930000008`/`1234`.

## Put it online

The app saves everything in one file, `db.json`, inside the data folder (`DATA_DIR`). Online, that folder **must be on a persistent disk**, or the data is lost when the server restarts.

### Option A – Render (easiest)
1. Create an account at [render.com](https://render.com) and connect your GitHub.
2. *New → Blueprint* → pick this repository. Render reads `render.yaml` (web service + 1 GB disk; the disk needs the paid *Starter* plan, about $7/month).
3. Set `ADMIN_PASSWORD` when asked. Deploy.
4. Share the `https://….onrender.com` link with your team.

### Option B – Railway
1. [railway.app](https://railway.app) → *New project → Deploy from GitHub repo*.
2. Add a **Volume** mounted at `/data`, and the variable `DATA_DIR=/data`.
3. Set `ADMIN_PASSWORD`. Under *Settings → Networking* click *Generate domain* and share the link.

### Option C – Any VPS / your own server (Docker)
```bash
docker build -t driver-allocation .
docker run -d -p 80:3000 -v driver-data:/data -e ADMIN_PASSWORD=choose-a-strong-one driver-allocation
```

### Settings (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | Web port |
| `DATA_DIR` | `./data` | Folder where `db.json` is saved |
| `ADMIN_USERNAME` | `admin` | First admin username (only used on first start) |
| `ADMIN_PASSWORD` | `admin123` | First admin password (only used on first start) |

**Backups:** *Settings → Download backup* saves everything to a file; *Restore from file* loads it back (for example after moving to a new host).

## How the allocation works

Every working day each active unit gets as many slots as its *drivers needed per day*. All free drivers are matched to the slots with the Hungarian algorithm (the optimal assignment), using a score that, in order of importance:

1. prefers drivers with the fewest total duties,
2. prefers the unit the driver has served least,
3. avoids the same unit as the previous working day,
4. prefers the driver who has rested longest.

With 7 units and 8 drivers this gives a clean rotation: over 56 working days every driver does exactly 49 duties and serves each unit exactly 7 times (see `test/scheduler.test.js`).
If there are more slots than drivers, the shortage rotates between units too.

Past days are never changed. Admin changes are marked ✎ and kept when the schedule is re-balanced.

## Development

```bash
npm test
```

Code layout: `server.js` (web server and API), `lib/scheduler.js` (allocation), `lib/store.js` (JSON file storage), `lib/auth.js` (passwords and login sessions), `public/` (the web pages).
