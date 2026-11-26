# Water Pact

An installable water tracker for two friends (up to eight) who keep each other
accountable. Each person logs their own drinks; everyone in the pact sees each
other's glass fill up, can send a nudge, and shares a team streak.

It is a web app that installs to the home screen on iPhone and Android. There is
nothing to download from an app store and nobody needs an account: a pact is
joined with an invite link.

## Put it online

You need two free things: a Supabase project (the shared database) and a static
host (GitHub Pages, Vercel, Netlify or similar).

1. **Database.** Create a project at supabase.com. Open **SQL Editor**, paste all
   of `supabase/schema.sql`, and run it.
2. **Connect the app.** In the project's **Settings → API**, copy the Project URL
   and the *publishable* key into `config.js`. That key is designed to ship
   inside apps. Never put a secret or service-role key there.
3. **Host it.** Publish this folder as a static site. Only these are needed:
   `index.html`, `styles.css`, `config.js`, `sw.js`, `manifest.webmanifest`,
   `js/` and `icons/`.
4. Open the site on your phone, add it to your home screen, start a pact and
   share the invite link.

Two things to check once:

- In Supabase **Settings → API → Exposed schemas**, `water_pact` must not be
  listed (it is not by default). The app only needs `public`.
- `index.html` carries a security policy that lets the app talk to
  `https://*.supabase.co` only. If your project uses a custom domain, add it to
  `connect-src` there.

### Releasing an update

Change `VERSION` at the top of `sw.js` (and `APP_VERSION` in
`js/ui/settings.js`). Phones then download the whole new version and switch to
it in one step the next time the app opens. Without that change, installed
phones keep running the files they already have.

## Develop

```bash
npm install
npm run dev     # http://localhost:4173, backed by an in-memory Postgres running the real schema
npm test        # logic, storage, sync, API client and database tests
npm run icons   # regenerate the icon PNGs
```

`npm run dev` needs no Supabase project. Its data resets on restart.

## How it works

- `supabase/schema.sql` keeps every table in a private schema the API does not
  expose. Phones call only the `wp_*` functions. Reading a pact needs its invite
  code; writing needs the device key issued on joining, stored only as a hash.
- `js/logic.js` and `js/model.js` are pure: units, time zones, pace, streaks and
  the view model. `js/api.js` talks to Supabase and validates every answer.
- `js/goal.js` powers "Work out my goal": about 35 ml per kg of body weight plus
  roughly a litre per hour of weekly exercise, spread over the week. The weight
  typed in is used for the sum only and never saved or sent.
- `js/sync.js` queues changes made offline and sends them when the connection
  returns. Drinks carry a phone-generated id, so a retry never double-logs.
- `sw.js` caches the app's own files so it opens without a connection.
- iPhones keep a home-screen app's storage separate from Safari's. Someone who
  joined in the browser and installed afterwards uses **Settings → Use on
  another device** to carry their log across with a one-time link code.

## Known limits

- No push notifications yet: a nudge shows the next time the friend opens the app.
- On Supabase's free plan, a project with too little activity for a week is
  paused and the app stops syncing. Nothing is lost: press **Restore** on the
  project in the Supabase dashboard. Daily use keeps it awake.
- Anyone holding the invite code can read the pact's water log, so share the
  link only with the people you want in it.
- There are no accounts and no rate limiting, so the database protects itself
  with ceilings instead: 8 people per pact, 60 drinks per person per day,
  drinks older than 120 days are pruned, and a pact nobody has written to for
  180 days is deleted (14 days if it never logged a drink).
- A device's key lives in that browser's storage. On GitHub Pages every site
  under the same account shares one address (`name.github.io`), so another
  site published from that account could read it. Use a custom domain if you
  host other pages there that you do not fully trust.
- Not yet tried on a physical iPhone or Android phone; tested in a
  phone-sized desktop browser.
