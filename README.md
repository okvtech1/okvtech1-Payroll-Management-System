# OKV Nigeria Payroll & HR Management System — Online ("Subscribe") App
Public marketing site + sales funnel + multi-tenant app, backed by Google Sheets + Apps Script.

## File structure

```
okv-payroll-online/
├── index.html            Sales/landing page — the first page any visitor lands on
├── demo.html              Read-only live demo (dummy data, CRUD disabled, "Get Started" popup)
├── pricing.html            Monthly / Bi-Annual / Yearly plans, 2 tiers each → "Start for Free"
├── signup.html              Sign-up form (plan pre-selected from pricing) → starts 7-day trial
├── privacy-policy.html      Privacy Policy (NDPA 2023 / NDPR-aligned)
├── terms-of-service.html    Terms of Service
├── refund-policy.html       Refund & Cancellation Policy (matches the 30-day guarantee on pricing.html)
├── app/config.js            THE ONE PLACE to set your Apps Script URL (API_URL)
├── app/okv-auth.js          Shared helper: API calls, SHA-256 hashing, session storage (single copy)
├── icons/                     Favicon-sized app icons used by the marketing pages
├── app/
│   ├── install.html            Install-only screen (the link Admins share with staff)
│   ├── index.html                Login (Admin + User + Super Admin, same form) + "Forgot password?" + offline handling
│   ├── reset-password.html         Token-based password reset (linked from the reset email)
│   ├── app.html                     The org application — dashboard, payroll, HR, Users & Access, My Portal, Announcements, Messages, Upgrade & Subscription, User Manual
│   ├── superadmin.html               Platform-level dashboard — Organizations, Announcements, Branding, Payments, Communications, Pricing, My Account
│   ├── manuals/                       Downloadable PDF user manuals (Full Manual + Self-Service Quick Guide)
│   ├── manifest.json                 PWA manifest (this is the installable part of the product)
│   ├── sw.js                          Service worker — caches the app shell for offline use
│   └── icons/
├── Code.gs                     Google Apps Script backend (paste into the Apps Script editor)
└── README.md
```

**Only `app/` is the installable PWA.** `index.html`, `demo.html`, `pricing.html`, and `signup.html` are ordinary marketing pages meant to be browsed, not installed — that's why the manifest and service worker live inside `app/` and are scoped to it.

## The funnel

```
index.html (sales page)
  ├─ "View Live Demo"          → demo.html (dummy data, read-only, popup → pricing.html)
  └─ "Start 7-Day Free Trial"  → pricing.html
                                     └─ pick a tier → "Start for Free" → signup.html?plan=X&billing=Y
                                                                              └─ Create Account
                                                                                   → app/install.html (install instructions)
                                                                                        → app/index.html (log in)
                                                                                             → app/app.html (dashboard, 7-day trial running, Upgrade button visible)
```

Every "Start Free Trial" / "Get Started" / "Start for Free" button across the site ends at the same place: `pricing.html`, so the visitor always picks a tier before creating an account. Existing users skip all of this via **Log In** links straight to `app/index.html`.

## Multi-tenant architecture (per-org spreadsheets)

As of this update, each organization gets its **own dedicated Google Spreadsheet** instead of
sharing one giant spreadsheet with every other tenant. This removes the old single-file
10,000,000-cell ceiling from being a shared, unpredictable budget across all customers — now
each org has its own 10M-cell budget, monitored individually.

**New files** (add these as additional script files in the same Apps Script project, alongside `Code.gs`):

| File | Purpose |
|---|---|

**What lives where now:**
- **Master spreadsheet** (the one the Apps Script project stays bound to): `Registry`, `UserIndex`,
  `SessionIndex`, `ResetIndex`, `SuperAdmins`, `CapacityLog`, plus the existing `PlatformSettings`,
  `UpgradeRequests`, and a new `PlatformMessages` log for Super Admin broadcasts. No payroll/HR
  transactional data is stored here.
- **Each tenant spreadsheet** (one per org, created automatically at signup): `Users`, `Data`,
  `Messages`, `Chats` — exactly the four sheets that were already filtered by `orgId` before.

**Setup order for a brand-new install:**
1. Create a Google Sheet — this becomes the **Master**.
2. Extensions → Apps Script → paste in the single file `Code.gs`.
3. Run `setupSheets` (creates `PlatformSettings`/`UpgradeRequests`/etc. in the Master).
4. Run `setupMasterRegistry` (creates `Registry`/`UserIndex`/`SessionIndex`/`ResetIndex`/`SuperAdmins`/`CapacityLog`).
5. Run `setupSuperAdmin`, `installUpgradeApprovalTrigger`, `installReminderTrigger` as before.
6. Run `installCapacityTrigger` — enables the daily cell-capacity check (see below).
7. Deploy as a Web App as before. New orgs signing up now each get their own spreadsheet automatically (`signupOrg` → `createTenantSpreadsheet_`).

**Migrating an existing install that already has live data** in the old single-spreadsheet layout:
1. Complete steps 2–4 above on that same spreadsheet (it becomes the Master).
2. Run `migrateToPerTenant()` (in `Code.gs`). For every org found in the old `Users` tab, it creates
   a new tenant spreadsheet, copies that org's rows out of the old `Users`/`Data`/`Messages`/`Chats` tabs,
   and writes a `Registry` row with the new spreadsheet ID.
3. Open a couple of the new tenant spreadsheets and spot-check the data.
4. Run `cleanupOldTenantSheets()` to clear the now-redundant data out of the Master (manual, not automatic).
5. Run `installCapacityTrigger`, then redeploy.

### Cell-capacity monitoring
`checkAllTenantsCapacity()` runs once daily (installed via `installCapacityTrigger`, not on every
page load). For each tenant it sums the **actual used range** of every tab (not the full default
grid), logs a snapshot to `CapacityLog`, and — once at least one prior snapshot exists — projects
months remaining until ~90% full from the recent growth rate. Results are written to `Registry`
and shown only on the Super Admin Dashboard → **Storage & Capacity**: org name, cells used, %
of the 10,000,000 limit, estimated time remaining, a status flag (`Healthy` < 70%, `Monitor` ≥ 70%,
`Action Needed` ≥ 85%), and a recommended next step (archive older records into a separate
spreadsheet, or split the tenant further). Crossing into `Action Needed` also emails the Super
Admin once (re-arms if usage drops back to `Healthy`). Org Admins and Users never see this data.

## Deployment

### 1. Create the Google Sheet backend
1. Create a new Google Sheet.
2. Extensions → Apps Script. Delete any starter code and paste in the entire contents of **`Code.gs`** — the whole backend is now this one file (earlier versions split it into four; do not add the others). Save.
3. Select **`checkSetup`** and click **Run** first. It lists anything still missing. Then select the `setupSheets` function from the function dropdown and click **Run**. Grant the permissions it asks for. This creates and writes the correct header row into the Master-side tabs: `PlatformSettings`, `UpgradeRequests` — check the sheet to confirm.
3b. Select **`setupMasterRegistry`** and click **Run** — creates `Registry`, `UserIndex`, `SessionIndex`, `ResetIndex`, `SuperAdmins`, `CapacityLog`.
4. Select **`setupSuperAdmin`** from the function dropdown and click **Run**. This creates your platform-level login: `technologyokv@gmail.com` / `OKV557`. **Change this password immediately** after your first login (Super Admin Dashboard → My Account) — it's a known default.
5. Select **`installUpgradeApprovalTrigger`** and click **Run** — enables the "mark Confirmed/Rejected in the sheet → customer gets emailed and upgraded automatically" flow.
6. Select **`installReminderTrigger`** and click **Run** — enables the twice-monthly trial/subscription reminder emails (runs daily at ~8am, but only actually emails an org on the schedule described below).
6b. Select **`installCapacityTrigger`** and click **Run** — enables the daily per-tenant cell-capacity check.
7. Deploy → **New deployment** → type **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
8. Copy the Web App URL (ends in `/exec`) — this is your `API_URL`.
9. Whenever you edit `Code.gs`, you must **redeploy** (Manage deployments → edit → new version) for changes to reach the live URL. The `Run` steps above are one-time only and survive redeployment.

### 2. Point the front-end at your backend (one place only)

Open **`app/config.js`** and replace `YOUR_DEPLOYMENT_ID` in `API_URL` with your Web App URL from step 8:

```js
window.OKV_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec'
};
```

That is the only place the URL is set. Every page — the marketing site (`index`, `pricing`, `signup`, `demo`) and the app in `app/` — loads `app/config.js` and then `app/okv-auth.js`. There is no second copy of either file to keep in step. (The old root-level `okv-auth.js` has been removed.)

### 3. Set the password-reset link destination
Back in `Code.gs`, set:
```js
const RESET_PAGE_URL = 'https://YOUR-DOMAIN-HERE/app/reset-password.html';
```
to wherever you host `app/reset-password.html`, then redeploy. This is what password-reset emails link to.

### 4. Host the front-end
Upload the whole folder (minus `Code.gs`) to your static host, keeping the `app/` subfolder intact — the relative links between pages (`../signup.html`, `../pricing.html`, etc.) depend on that structure. Make sure `app/install.html` is reachable at a stable URL — that's the link Admins share with their staff from inside the app.

### 5. Log in as Super Admin and set things up
Open `app/index.html` and log in with `technologyokv@gmail.com` / `OKV557` — the same login form everyone else uses; it detects the Super Admin account and routes you to `app/superadmin.html` automatically instead of the regular org dashboard. From there:
1. **My Account** — change your password immediately.
2. **Branding & Info** — set your logo URL and brand colors (optional; sensible defaults are used until you do), and confirm/edit the company email/phone/website shown everywhere.
3. **Payment Methods** — the OPay bank details are pre-loaded as the default manual method; add more manual methods or fill in Paystack/Remita/Flutterwave keys if you have them (gateway checkout itself isn't built yet — see "What's not wired up yet" below).
4. **Pricing & Plans** — adjust Essential/Enterprise prices and their "suitable for" copy; this immediately affects `pricing.html`, the org Upgrade & Subscription form, and the amount logged on new upgrade requests.

## Exact Sheet headers

### `Users` tab
```
orgId | orgName | userId | fullName | username | email | phone | passwordHash | isAdmin | roles |
plan | billingCycle | status | subscriptionStatus | subscriptionStartDate | subscriptionExpiry | trialEndsAt |
resetToken | resetTokenExpiry | sessionToken | sessionTokenExpiry | employeeId | createdAt | updatedAt |
isSuperAdmin | lastReminderSentAt
```
- **orgId** — one per organization; every signup creates a new one. All rows for an org share this value; this is what keeps orgs isolated from each other. Blank for the Super Admin row, which isn't tied to any organization.
- **isAdmin** — `TRUE` for the org owner created via `signup.html` (there's exactly one per org). Everyone else is `FALSE`.
- **isSuperAdmin** — `TRUE` only for the one platform-level row created by `setupSuperAdmin()`. Checked at login to route to `superadmin.html` instead of the regular org dashboard, and skips all the org/subscription checks below.
- **roles** — comma-separated list drawn from the 7 role options (see below). A `FALSE` `isAdmin` row can hold zero, one, or several roles.
- **plan** / **billingCycle** — the tier and billing period chosen on the pricing page (e.g. `Essential` / `monthly`), carried through signup.
- **status** — `Active` or `Suspended`. Suspended users (or entire orgs, suspended from the Super Admin Dashboard) are signed out immediately and can't log back in until reactivated.
- **subscriptionStatus** — `trialing` for the first 7 days, then `active` once upgraded and confirmed. Checked on every login **and** on every API call, so a trial expiring mid-session is caught immediately.
- **subscriptionStartDate** / **subscriptionExpiry** — set automatically when an upgrade request is confirmed (or manually by the Super Admin from Organizations). Drives the "Active Plan" card and countdown on the dashboard.
- **trialEndsAt** — set to signup time + 7 days automatically. This drives the trial countdown on the dashboard.
- **resetToken** / **resetTokenExpiry** — only ever populated for Admin rows, by the "Forgot password" flow. Single-use, expires after 60 minutes.
- **sessionToken** / **sessionTokenExpiry** — the current login session's bearer token, valid 30 days, checked on every API call.
- **employeeId** — optional link from a User account to a row in the `Data` tab's `employees` records, used to scope the self-service "My Portal" view to that person's own data.
- **lastReminderSentAt** — internal bookkeeping for the twice-monthly reminder emails (see below) — don't edit this by hand.

### `Data` tab
```
orgId | entityType | recordId | jsonData | updatedAt | updatedBy
```
- **entityType** — one of `employees`, `payrollInputs`, `leaveRegister`, `loanRegister`, `bioData`, `settings`.
- **recordId** — the record's key within that entity type (Employee ID, Leave ID, etc.; `"main"` for the single `settings` record).
- Sync is a **whole-entity-type replace**: whenever a device syncs, it sends its complete current list for each entity type and the server replaces that org's rows for that type wholesale. Simple and reliable, at the cost of fine-grained per-record merge — if the same entity type is edited offline on two devices before either syncs, the one that syncs last wins for that type.

### `Messages`, `Chats`, `UpgradeRequests` tabs
Written automatically by the app — you generally don't need to edit these by hand, except `UpgradeRequests.status` (see "Upgrade & Subscription" below).
```
Messages:        orgId | messageId | fromUserId | fromName | toScope | toLabel | channel | messageType | subject | body | recipientCount | sentAt
Chats:            orgId | chatId | fromUserId | toUserId | body | sentAt | readAt
UpgradeRequests:   orgId | requestId | userId | orgName | fullName | email | phone | planRequested | billingCycle | amount | screenshotUrl | status | submittedAt | decidedAt | subscriptionStartDate | subscriptionEndDate
```

### `PlatformSettings` tab
A simple `key` / `value` sheet with one row (`key = "config"`) holding all Super Admin-configured settings as JSON — branding colors/logo, contact info, manual payment methods, gateway credentials, comms provider credentials, and plan pricing. Edit this through the **Super Admin Dashboard**, not directly in the sheet (the JSON is easy to break by hand).

## Roles

Assigned by the Admin from the Users & Access panel; a user can hold multiple roles at once, and the Admin can add or remove roles at any time.

| Role | Sections unlocked |
|---|---|
| HR/Payroll Super Admin | Everything except Users & Access management |
| HR Manager | Dashboard, Employees, BioData, Leave Register, Reports |
| Payroll Officer | Dashboard, Payroll Input/Calculation, Payslips, statutory setup, Reports |
| HR Officer | Dashboard, Employees, BioData, Leave Register |
| Finance Manager / Accountant | Dashboard, Payroll Calculation, Payslips, Loan Register, Reports |
| Compliance Officer | Dashboard, Reports, statutory setup, Settings |
| Employee / Staff Self-Service User | **My Portal only** — their own payslip, leave requests, loan balance |

The Admin account itself always has full access, including Users & Access, regardless of roles. A User with no roles assigned yet defaults to My Portal (least-privilege fallback).

## 7-day free trial

- `signupOrg` in `Code.gs` sets `subscriptionStatus: 'trialing'` and `trialEndsAt: now + 7 days` automatically — no payment step exists in this build (see below).
- The dashboard shows a trial card ("Free Trial — N days remaining") plus a gold **Upgrade** icon in the topbar, both linking out to `pricing.html`. Both update live via `updateTrialUI()`, refreshed hourly and on every login/sync.
- Trial expiry is enforced **server-side**, in `requireSession_()` — every single API call re-checks it, not just login, so access is cut off within the hour even mid-session (the client's hourly refresh will surface the "trial ended" state, and any write attempt will be rejected by the backend regardless).
- **What's not wired up yet:** there's no payment processor integrated (no Paystack/Flutterwave call anywhere), so "upgrading" currently just sends the person to `pricing.html` — nothing on that page actually captures payment. Wiring a real payment gateway and having it flip `subscriptionStatus` to `active` is a follow-up piece, not part of this build.

## Communication: Announcements, Payslip Delivery & Messages

From **Announcements** (Admin, plus HR Manager / HR Officer / Payroll Officer roles by default — edit `COMMS_ROLES` in `Code.gs` to change this):
- Compose a message and send it to **all staff** or **selected employees**, over **Email, SMS, and/or WhatsApp** at once.
- Pick a type — General Announcement, Birthday, Work Anniversary, or Personalized/Other — and use `%NAME%` in the message body to auto-insert each recipient's first name.
- **Email works immediately**, no setup required (`MailApp`). **SMS and WhatsApp are stubbed, not faked** — `sendViaSms_()` and `sendViaWhatsApp_()` in `Code.gs` throw a clear "not configured yet" error until you set `SMS_API_URL`/`SMS_API_KEY` (e.g. Termii, Africa's Talking) or `WHATSAPP_API_URL`/`WHATSAPP_API_KEY` (e.g. Twilio, Meta Cloud API) as **Script Properties** (File → Project properties → Script properties in the Apps Script editor). The UI reports these as failed sends with that reason rather than silently pretending they went out.
- The same screen can **email that period's payslip** to all active employees or a chosen few, straight to the email address on their Employee record.

**Messages** is a simple internal inbox — Admin and any User in the organization can message each other directly. A red badge on the sidebar shows unread count, refreshed every 45 seconds.

## Upgrade & Subscription (manual bank-transfer flow)

There's no live payment gateway checkout wired in — upgrades are confirmed manually against a bank transfer, on purpose (no third-party payment integration required just to run this). Gateway *credentials* can be stored (see Super Admin below) for when that's built, but nothing redirects to Paystack/Remita/Flutterwave checkout yet.

1. On **Upgrade & Subscription** (Admin only), the form is pre-filled with the Admin's org name, name, email, and phone (editable). The payment methods shown, and the live prices in the plan dropdown, are fetched from whatever the Super Admin has configured (`getPublicPlatformInfo`) — if nothing's been configured yet, or the device is offline, it falls back to the original OPay details and default Essential/Enterprise prices baked into `Code.gs`, so the form always works.
2. The Admin picks a plan + billing cycle (the amount updates live), uploads a screenshot of their transfer, and submits.
3. The screenshot is uploaded to Google Drive and a row is added to the `UpgradeRequests` sheet; an email with all the details and a link to the screenshot goes to the configured company email.
4. Marking a row's `status` column **Confirmed** or **Rejected** directly in the `UpgradeRequests` sheet (after running `installUpgradeApprovalTrigger` once — see Deployment) automatically emails the customer their result and — if confirmed — flips their Admin row to `subscriptionStatus: active`, sets the start/due dates, and it shows up on their Dashboard immediately (an **Active Plan** card with start date, due date, and a live days/weeks/months-remaining countdown, replacing the trial card).
5. Recent request history (with status) is visible right on the same screen so the Admin can see where things stand.

## Super Admin Dashboard (`app/superadmin.html`)

A separate, platform-level dashboard for managing every organization on the system — logged into from the **same login page** as everyone else (`app/index.html`), which detects the `isSuperAdmin` flag and routes accordingly.

**Default login:** `technologyokv@gmail.com` / `OKV557` (created once by running `setupSuperAdmin()` — see Deployment). Change the password immediately from **My Account**.

| Section | What it does |
|---|---|
| **Dashboard** | KPIs across every organization — total orgs, active subscriptions, trials, suspended — plus a recent-signups table. |
| **Organizations** | Every org with its Admin's contact details, plan, subscription/trial status, and user count. Edit any org's contact details or plan/dates directly, or Suspend/Reactivate the whole organization (suspending signs out and blocks every user in it, not just the Admin). This replaces reviewing the raw `Users` sheet by hand. |
| **Announcements** | Send a message to all organizations or selected ones, over Email/SMS/WhatsApp, same personalization pattern as the org-level Announcements feature. |
| **Branding & Info** | Set the logo URL and primary/accent brand colors (applied live via CSS custom properties on the login page and org dashboard), and the company email/phone/website shown everywhere. |
| **Payment Methods** | Add/edit/remove manual bank-transfer methods (each with its own enable/disable toggle — customers only see enabled ones), and store Paystack/Remita/Flutterwave credentials for future gateway integration. |
| **Communications** | SMS and WhatsApp provider credentials (API URL + key, e.g. Termii, Twilio, Meta Cloud API) — fill these in here instead of editing code; `Code.gs` reads them at send-time. |
| **Pricing & Plans** | Edit Essential/Enterprise prices (all three billing cycles) and their "suitable for" description. Changes reflect immediately on `pricing.html` and every org's Upgrade & Subscription form. |
| **My Account** | Change the Super Admin's own password. |

**What's not wired up yet:** no live checkout for Paystack/Remita/Flutterwave — credentials can be saved and are ready for that integration, but nothing currently redirects a customer to an actual payment page or verifies a webhook. The manual bank-transfer + screenshot + Sheet-approval flow is the only *working* payment path today.

## Automatic Trial & Subscription Reminders

Runs daily (after `installReminderTrigger()` is installed once) but is deliberately capped so it's never spammy:
- **Trial orgs**: one reminder 2 days before the trial ends, one more the day it ends. That's it — no daily nagging.
- **Active/paid orgs**: at most once every ~14 days per organization (so, twice a month), with the message escalating to "renewal due soon" language and a suggested next tier if renewal is within 7 days, or a friendly check-in otherwise.
- Every reminder email includes next-plan/tier suggestions and instructions when relevant, and always ends with the current company contact details.
- This is independent of the **in-dashboard** trial/active-plan cards, which always reflect current status live (not throttled) every time the dashboard loads or refreshes hourly — so the person always has an accurate at-a-glance view even between emails.

## User Manual

Every dashboard has a **User Manual** tab with a real downloadable PDF, chosen automatically:
- Anyone whose *only* role is **Employee / Staff Self-Service User** gets the short **Quick Guide** (`app/manuals/OKV_Payroll_HR_QuickGuide_SelfService.pdf`) — covers My Portal, leave requests, and changing their password.
- Everyone else (Admin and all other roles) gets the **Full Manual** (`app/manuals/OKV_Payroll_HR_Full_Manual.pdf`) — covers every module up to and including Users & Access and Upgrade & Subscription.
- Both PDFs are static files generated once and shipped in `app/manuals/` — regenerate them by editing and re-running `generate_manuals.py` (not deployed, kept separately) if the product changes.

## Company info

Shown in every footer, the Upgrade & Subscription panel, and every email the system sends. Defined **once**, server-side, in `Code.gs`:
```js
const COMPANY_EMAIL = 'technologyokv@gmail.com';
const COMPANY_PHONE = '+2348104141138';
const COMPANY_WEBSITE = 'www.okvtechnology.com';
```
Change these three lines and redeploy to update the developer/support contact everywhere the backend sends it. Front-end pages (footers) currently hardcode the same values in each HTML file — search for `technologyokv@gmail.com` across the project if you ever need to change it and want the static footers to match too.

## Legal / compliance pages

Three static pages cover the legal basics for a Nigerian SaaS handling employee payroll data:

- **`privacy-policy.html`** — what's collected, why, where it's stored (Google Sheets/Apps Script infrastructure, per-tenant spreadsheets), sub-processors, retention, security measures, and data-subject rights under the **Nigeria Data Protection Act 2023 (NDPA)**. Frames your Organization as the Data Controller for employee data and OKV as the Data Processor — the standard split for B2B HR software.
- **`terms-of-service.html`** — account terms, the 7-day trial, manual bank-transfer billing, acceptable use, the 10,000,000-cell Google Sheets storage limit, liability limits, and governing law (Nigeria).
- **`refund-policy.html`** — the **30-day money-back guarantee** already advertised on `pricing.html`'s guarantee banner, cancellation terms, and what happens to data after cancellation. Written to match that existing marketing claim rather than contradict it — if you ever change the guarantee terms on the pricing page, update this file to match.

**Linked from:** the `index.html` footer (new "Legal" column), `pricing.html` and `signup.html` footers, the login page (`app/index.html`) and password-reset page (`app/reset-password.html`) footers, the bottom of the sidebar in `app/app.html`, `app/superadmin.html`, and `demo.html`, and — required — a consent checkbox on `signup.html` ("I agree to the Terms of Service and Privacy Policy…") that must be checked before an account can be created.

**Before going live, review and adjust:**
- Retention periods, refund window, and trial length are written to match the current `Code.gs` constants (`TRIAL_DAYS = 7`) and the pricing-page guarantee — if you change those constants, update the corresponding wording in these pages too, since nothing keeps them in sync automatically.
- These pages are a solid starting draft, not a substitute for a lawyer's review — especially the liability-limitation and NDPA sections, given you're processing real employees' bank account and salary data.
- The "Last updated" date at the top of each page should be bumped whenever you materially change the wording.

## Offline + sync behavior (the installed app, `app/`)

- Every write saves to **IndexedDB immediately** — the app is fully usable offline once it's synced at least once.
- Each store is also queued for push to the server (debounced ~1.5s), flushed automatically the moment the device comes back online.
- The **Sync button** in the topbar triggers an immediate push-then-pull; auto-sync also runs every 60 seconds while online.
- A local `okv_payroll_online_<orgId>` IndexedDB database is used per organization on each device, so switching which org you're logged into on the same browser never mixes data.
- **First-ever login on a device requires internet** — after that first sync, the app works fully offline and catches up automatically when reconnected.

## The live demo (`demo.html`)

- Loads a fixed set of sample employees/leave/loans/biodata directly in the browser — no login, no backend calls, nothing touches your real Sheet.
- Shows the **same 21 tabs as the real Admin dashboard**, including **Upgrade & Subscription**. Messages, Announcements, Upgrade & Subscription and the User Manual run the *real app code* against a small in-browser mock API (`apiCall` in `demo.html`), so chat, sending an announcement and submitting an upgrade request all work — but nothing is sent or saved, and the sample bank details are placeholders.
- A **"View as"** selector in the demo banner switches between the Admin and each of the 7 roles, showing exactly the tabs that role gets in the real app.
- Every save/delete/import/restore action is intercepted and replaced with a "sign up to unlock" toast, so a visitor can explore without being able to alter anything.
- The trial strip, trial card, Upgrade button and Synced button match what a real trial user sees.
- A "Get Started Now" card pops up after ~12 seconds (once per browser session) linking to `pricing.html`; the banner also has its own "Start Your Free Trial" link.
- When you change `app/app.html` UI or role tables, mirror them in `demo.html` (`ROLE_SECTIONS`, `TITLES`, sidebar) so the demo stays identical.

## Admin: invite staff to install

Inside the app, **Users & Access → Share Install Link** gives a copy-able URL to `app/install.html`. Send it to staff — it shows device-specific install instructions only; after installing, the icon opens straight to the **login screen**, where they sign in with the username + password you set for them in Users & Access.

## Testing walkthrough

### 1. The funnel end-to-end
1. Open `index.html` — click through each nav link and confirm it smooth-scrolls to the right section, and that the "Start 7-Day Free Trial" button (top-right and in the hero) goes to `pricing.html`.
2. Click **View Live Demo** — confirm you land in `demo.html` fully populated with sample data, can click through every sidebar section, and that trying to save/delete anything shows the "sign up to unlock" toast instead of changing anything. Wait ~12s and confirm the "Get Started Now" card appears; click it and confirm it goes to `pricing.html`.
3. On `pricing.html`, switch between Monthly / Bi-Annual / Yearly and confirm prices and the two tiers' feature lists update. Click **Start for Free** on either tier.
4. Confirm you land on `signup.html` with the chosen plan and billing cycle already shown at the top of the form.
5. Fill in Organization Name, Full Name, Email, Phone, Username, Password and submit.
6. Confirm you're redirected to `app/install.html`, and that installing (or "continue without installing") takes you to `app/index.html` to log in.
7. Log in and confirm the Dashboard shows the trial card with "7 days remaining" (or close to it) and the correct plan name, and that the gold Upgrade icon is visible in the topbar.

### 2. Two isolated organizations
1. Sign up as Org A. Add an employee or two, then log out.
2. Sign up as Org B (private/incognito window) with a different email/username.
3. Confirm Org B's Dashboard shows zero employees — Org A's data never appears.
4. In the `Data` tab of your Google Sheet, confirm rows for both orgs exist side by side, distinguished only by `orgId`.

### 3. Roles, suspend/activate, password resets, offline+sync
Follow the same steps as before — create Users with different roles from Users & Access and confirm sidebar access matches the table above; suspend/reactivate a User; test the Admin's email-based "Forgot password" flow end-to-end via `app/reset-password.html`; test an Admin setting a User's password directly; take the app offline, make a change, and confirm it syncs once reconnected.

### 4. Trial expiry (manual test)
Since there's no real payment step, you can simulate expiry directly in the Sheet: find the Admin's row in `Users`, edit `trialEndsAt` to a past date, then reload the app (or wait for the hourly refresh) — confirm the trial card and Upgrade prompts switch to "trial has ended" and any write action gets rejected with that message.

### 5. Announcements & payslip emailing
1. As an Admin (or a User with HR Manager/HR Officer/Payroll Officer role), open Announcements.
2. Send a General Announcement to "All Staff" via Email — confirm the "Last Send Result" panel shows the correct sent count, and check that the employees' inboxes (use real addresses to test) received it.
3. Try including `%NAME%` in the message and confirm each recipient's email shows their own first name.
4. Switch to "Selected Employees" and pick 1-2 — confirm only those addresses were used.
5. In the same screen, use **Email Payslips Now** for a couple of employees and confirm the payslip HTML arrives correctly formatted in their inbox.
6. Try checking the SMS or WhatsApp boxes without setting up `SMS_API_URL`/`WHATSAPP_API_URL` in Script Properties — confirm the send reports those recipients as "failed" with a clear "not configured yet" reason, rather than pretending to succeed.

### 6. Messages (internal chat)
1. As Admin, open Messages, start a new conversation with a User (via the "+ New message…" dropdown), and send a message.
2. Log in as that User on another device/browser, confirm the message appears with an unread badge on the sidebar, reply, and confirm the Admin sees the reply and the badge clears once read.

### 7. Upgrade & Subscription end-to-end
1. As Admin, open Upgrade & Subscription — confirm the form is pre-filled with your org/contact info (editable) and the payment methods shown match whatever is currently enabled in the Super Admin Dashboard (or the OPay default, if nothing's been configured yet).
2. Pick a plan + billing cycle — confirm the amount hint updates live — attach any image as a "payment screenshot," and submit — confirm you get the "you'll hear back within the hour" message and a new row appears in `UpgradeRequests`.
3. Confirm an email landed at the configured company email with the details and a link to the uploaded screenshot.
4. In the Sheet, run `installUpgradeApprovalTrigger` once if you haven't already, then change that row's `status` to **Confirmed**.
5. Confirm: the customer's email address receives a confirmation email, and reloading their Dashboard now shows the **Active Plan** card (not the trial card) with the correct start date, due date, and a days/weeks/months-remaining countdown.
6. Repeat with a different request marked **Rejected** and confirm the customer gets the "unable to confirm" email instead, with no change to their plan.

### 8. User Manual
1. As Admin, open User Manual — confirm it shows "Full User Manual" and the PDF downloads correctly.
2. Log in as a User whose only role is Employee / Staff Self-Service User — confirm they instead see "Quick Guide — Employee / Staff Self-Service" with the shorter PDF.

### 9. Logout everywhere
Confirm the account menu (top right) with **Log Out** is visible and working from every single section — Dashboard, My Portal, Announcements, Messages, User Manual, Users & Access, Upgrade & Subscription, and every payroll/HR module — since it lives in the shared topbar, not inside any individual section. Confirm the Super Admin Dashboard has its own working Log Out too (footer link).

### 10. Super Admin end-to-end
1. Log in at `app/index.html` with `technologyokv@gmail.com` / `OKV557` — confirm you land on `app/superadmin.html`, not the regular org dashboard.
2. **Organizations** — confirm every org you've created so far is listed with correct contact info, plan, and status; edit one org's phone number and plan, save, and confirm it reflects immediately.
3. Suspend an org, then try logging into it as that org's Admin — confirm login is rejected. Reactivate and confirm login works again.
4. **Branding & Info** — set a custom accent color (e.g. a different hex) and save. Log out, log back in as a regular org Admin, and confirm the login page and dashboard sidebar now use the new color. Try a logo URL too and confirm it swaps in on the login page.
5. **Payment Methods** — add a second manual payment method, save, then check an org Admin's Upgrade & Subscription screen shows both methods. Disable one and confirm it disappears from their view.
6. **Pricing & Plans** — change the Enterprise monthly price, save, then confirm `pricing.html` (in a fresh/incognito tab) and an org Admin's Upgrade & Subscription plan dropdown both show the new price.
7. **Announcements** — send a test message to one organization via Email and confirm it arrives.
8. **My Account** — change the Super Admin password, log out, and confirm you can log back in with the new one (and that the old default no longer works).
