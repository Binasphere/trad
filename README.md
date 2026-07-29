# Venti payments backend

The two money-moving HTTP endpoints from the main Venti app, split into
their own service so the payment secrets and the publicly reachable PayHero
callback live on one small host. Everything else — accounts, balances,
withdrawals, the admin panel — stays in Supabase and the main app.

**Keep this repository private.** It holds no secrets itself (those live in
Render's environment), but there is no reason to publish it.

| Route | Who calls it | What it does |
| --- | --- | --- |
| `POST /api/auth/register` | The sign-up form (anonymous, rate-limited) | Creates the Supabase user pre-confirmed via the service role |
| `POST /api/payments/deposit` | The signed-in customer (Bearer token) | Books a PENDING cash event via `deposit_start`, raises the M-Pesa STK push |
| `POST /api/payments/payhero/callback` | PayHero (HMAC-signed URL) | Settles the event via `deposit_settle`, which credits the balance |
| `/api/admin/session`, `/api/admin/users`, `/api/admin/withdrawals` | The admin console (Bearer token from the passcode exchange) | User list, tier changes, the M-Pesa demo handset (PIN + opening balance), and the manual withdrawal queue |
| `/api/mpesa/*` | The M-Pesa clone app, and VIP customers' terminals | The VIP demo rail — see below |
| `GET /health` | Render / you | Reports which of Supabase / PayHero is configured |

## The VIP demo rail

VIP accounts settle against the companion M-Pesa clone app instead of PayHero,
so a deposit can be shown landing on a handset in the room. Standard accounts
are untouched and remain the only path real money takes.

Each VIP has their own wallet in Supabase (`supabase/mpesa-demo.sql` in the main
repo — run it in the SQL editor). An admin assigns a four-digit PIN and an
opening balance from the console; the customer types that PIN into the phone
once, and the phone keeps the `device_token` it gets back.

| Route | Who calls it | Auth |
| --- | --- | --- |
| `POST /api/mpesa/link` | An unlinked handset | The PIN itself |
| `GET /api/mpesa/account` | The handset, polling | Device token |
| `POST /api/mpesa/agent-withdraw` | The handset | Device token |
| `POST /api/mpesa/reset` | You, between rehearsals | Device token |
| `POST /api/mpesa/deposit` | A VIP's terminal | Supabase access token, tier checked server-side |
| `POST /api/mpesa/withdraw` | A VIP's terminal | Supabase access token, tier checked server-side |

The same routes exist in the main app under `src/app/api/mpesa/*`, over the same
wallets: those serve a laptop running `npm run dev`, these serve the deployed
terminal and the handset. The browser picks between them in `src/lib/backend.ts`.

Because the callback lands here and settles straight into Supabase, deposits
work end-to-end even while the main app runs on `localhost` — the frontend
polls Supabase for the settled row, not this service.

## Deploy on Render

1. Push this folder to a **private** GitHub repo.
2. Render → **New +** → **Web Service** → connect the repo.
   Build command `npm install`, start command `npm start`, health check path
   `/health`. (Or use **New +** → **Blueprint**, which reads `render.yaml`.)
3. In the service's **Environment** tab, set:
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase dashboard → Settings → API
   - `AUTH_SECRET` — the **same value** as the main app's `AUTH_SECRET`
   - `ADMIN_PASSCODE` — the admin console's door; unset = admin API off
   - `PAYHERO_USERNAME`, `PAYHERO_PASSWORD` — PayHero dashboard → API Keys
   - `PAYHERO_CHANNEL_ID` — PayHero dashboard → Payment Channels (numeric id)
4. Deploy. Open `https://<service>.onrender.com/health` — it must answer
   `{"ok":true,"supabase":true,"payhero":true}`.
5. Point the main app at this origin: set `NEXT_PUBLIC_PAYMENTS_URL` at build
   time (or paste the origin into `FALLBACK_PAYMENTS_ORIGIN` in
   `src/lib/wallet.ts` — the URL is public information, like the Supabase URL).

No callback configuration is needed anywhere: the callback URL is built
per-deposit from Render's own `RENDER_EXTERNAL_URL` and signed with
`AUTH_SECRET`.

### Free plan caveat

Render's free plan spins the service down after ~15 idle minutes; the next
request waits out a cold start that can approach a minute. The customer's
deposit request survives that (the app polls for two minutes), but PayHero's
callback hitting a cold service is a retry you don't control. The **starter**
plan keeps the service warm and is the right choice for real money.

## Run locally

```
cp .env.example .env   # fill it in
npm install
npm run dev
```

On localhost the STK push goes out but PayHero cannot reach the callback, so
a local deposit will sit pending — full end-to-end needs the Render deploy.
