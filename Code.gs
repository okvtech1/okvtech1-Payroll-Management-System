/* ============================================================================
   OKV NIGERIA PAYROLL & HR — BACKEND (Google Apps Script)  ·  SINGLE FILE
   ----------------------------------------------------------------------------
   THIS ONE FILE IS THE WHOLE BACKEND. Paste it as the only script file in the
   Apps Script project (Extensions → Apps Script; delete any starter code first).
   Earlier versions split the code into four files (Code.gs, MasterRegistry.gs,
   CapacityMonitor.gs, Migration.gs). If any one of those was not pasted, the
   editor reports errors such as "... is not defined". Keeping everything in one
   file removes that risk.

   After pasting, run checkSetup() from the function dropdown. It lists anything
   still missing (Master tabs, Super Admin login, triggers) instead of failing
   later with a vague error.
   ============================================================================ */

/**
 * OKV Nigeria Payroll & HR Management System — ONLINE (Subscribe) BACKEND
 * Google Apps Script Web App, backed by a Google Sheet with two tabs: "Users" and "Data".
 *
 * DEPLOYMENT
 *  1. Create a new Google Sheet. Rename Sheet1 to "Users", add a second sheet named "Data".
 *  2. Extensions → Apps Script. Delete any starter code and paste this whole file in as Code.gs.
 *  3. Run `setupSheets` once from the Apps Script editor (select it in the function dropdown,
 *     click Run) to write the correct header rows into both tabs. Grant permissions when asked.
 *  4. Deploy → New deployment → type "Web app".
 *       Execute as:  Me
 *       Who has access: Anyone
 *  5. Copy the Web App URL — this is API_BASE_URL used by every front-end file (signup.html,
 *     index.html, reset-password.html, app.html). Paste it into the API_BASE_URL constant near
 *     the top of each of those files.
 *  6. Whenever you edit this script, you must create a NEW deployment (or "Manage deployments" →
 *     edit the existing one → new version) for changes to take effect on the live URL.
 *
 * See README.md for the exact sheet headers, full testing walkthrough, and security notes.
 */

const SESSION_DAYS = 30;
const RESET_TOKEN_MINUTES = 60;
const TRIAL_DAYS = 7;
const ALL_ENTITY_TYPES = ['employees', 'payrollInputs', 'leaveRegister', 'loanRegister', 'bioData', 'settings', 'payrollHistory'];
/* NOTE: 'payrollHistory' (archived pay runs from Payroll Calculation -> Confirm & Archive) MUST be in this list.
   Without it the server rejects the push and the next pull returns nothing, wiping the device's archived months. */

/* Fallback used only if a client ever calls forgotPassword without sending its own
   resetBaseUrl (app/index.html always sends one, so this is a safety net, not the
   normal path). Set this to wherever you host app/reset-password.html. */
const RESET_PAGE_URL = 'https://YOUR-DOMAIN-HERE/app/reset-password.html';

/* ============================================================
   COMPANY INFO — shown across the app (Upgrade/Subscription panel,
   footers, emails). Edit here once and it flows everywhere server-side.
   ============================================================ */
const COMPANY_EMAIL = 'technologyokv@gmail.com';
const COMPANY_PHONE = '+2348104141138';
const COMPANY_WEBSITE = 'www.okvtechnology.com';
const PAYMENT_ACCOUNT_NUMBER = '8104141138';
const PAYMENT_BANK_NAME = 'OPay MFB';
const PAYMENT_ACCOUNT_NAME = 'Olasile Kehinde Victor';

/* Must mirror the prices shown on pricing.html — used only to log the expected
   amount on an upgrade request; the actual transfer amount is whatever the
   customer sends, confirmed manually against their payment screenshot. */
const PLAN_PRICES = {
  Essential: { monthly: 15000, biannual: 80000, yearly: 150000 },
  Enterprise: { monthly: 35000, biannual: 190000, yearly: 360000 }
};
const BILLING_CYCLE_DAYS = { monthly: 30, biannual: 182, yearly: 365 };

/* Roles allowed to send org-wide Announcements/payslip broadcasts, in addition to the Admin. */
const COMMS_ROLES = ['HR/Payroll Super Admin', 'HR Manager', 'HR Officer', 'Payroll Officer'];

/* Default Super Admin login, seeded once by setupSuperAdmin(). Change the password
   immediately after first login from the Super Admin Dashboard → My Account. */
const SUPER_ADMIN_EMAIL = 'technologyokv@gmail.com';
const SUPER_ADMIN_DEFAULT_PASSWORD = 'OKV557';

/* Platform-wide configuration, editable live from the Super Admin Dashboard (Settings tab).
   These are FALLBACK defaults only — once a Super Admin saves settings, the PlatformSettings
   sheet takes over and these are just what a brand-new, never-configured install starts with. */
const DEFAULT_PLATFORM_SETTINGS = {
  companyEmail: COMPANY_EMAIL, companyPhone: COMPANY_PHONE, companyWebsite: COMPANY_WEBSITE,
  logoUrl: '', primaryColor: '#0B1F3A', accentColor: '#C9A24B',
  manualPaymentMethods: [
    { id: 'default', label: 'Bank Transfer', accountNumber: PAYMENT_ACCOUNT_NUMBER, bankName: PAYMENT_BANK_NAME, accountName: PAYMENT_ACCOUNT_NAME, enabled: true }
  ],
  gateways: {
    paystack:    { enabled: false, secretKey: '', publicKey: '' },
    remita:      { enabled: false, merchantId: '', apiKey: '', serviceTypeId: '' },
    flutterwave: { enabled: false, secretKey: '', publicKey: '' }
  },
  comms: {
    sms:      { enabled: false, apiUrl: '', apiKey: '', senderId: 'OKV' },
    whatsapp: { enabled: false, apiUrl: '', apiKey: '' }
  },
  plans: {
    Essential:  { monthly: 15000, biannual: 80000,  yearly: 150000, suitableFor: 'Small businesses and startups managing a single core payroll & HR workflow.' },
    Enterprise: { monthly: 35000, biannual: 190000, yearly: 360000, suitableFor: 'Growing companies and HR consultancies needing full reporting, compliance tools, and multiple staff accounts.' }
  }
};

/* ============================================================
   ONE-TIME SETUP
   ------------------------------------------------------------
   LEGACY / first-install only. setupSheets() below writes the OLD single-
   spreadsheet layout (one shared Users/Data/Messages/Chats for every org).
   For the current per-tenant architecture:
     - Brand-new installs: run setupMasterRegistry() (MasterRegistry.gs) instead —
       it prepares this spreadsheet as the MASTER (Registry/UserIndex/
       SessionIndex/SuperAdmins/CapacityLog), plus setupSheets() is still needed
       once for the PlatformSettings/UpgradeRequests tabs that stay in the Master.
     - Existing installs with live data in the old layout: run setupSheets() (if
       not already done), then setupMasterRegistry(), then migrateToPerTenant()
       (Migration.gs) to move each org into its own spreadsheet.
   ============================================================ */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let users = ss.getSheetByName('Users');
  if (!users) users = ss.insertSheet('Users');
  let data = ss.getSheetByName('Data');
  if (!data) data = ss.insertSheet('Data');
  let messages = ss.getSheetByName('Messages');
  if (!messages) messages = ss.insertSheet('Messages');
  let chats = ss.getSheetByName('Chats');
  if (!chats) chats = ss.insertSheet('Chats');
  let upgrades = ss.getSheetByName('UpgradeRequests');
  if (!upgrades) upgrades = ss.insertSheet('UpgradeRequests');
  let platformSettings = ss.getSheetByName('PlatformSettings');
  if (!platformSettings) platformSettings = ss.insertSheet('PlatformSettings');

  const userHeaders = ['orgId','orgName','userId','fullName','username','email','phone','passwordHash','isAdmin','roles','plan','billingCycle','status','subscriptionStatus','subscriptionStartDate','subscriptionExpiry','trialEndsAt','resetToken','resetTokenExpiry','sessionToken','sessionTokenExpiry','employeeId','createdAt','updatedAt','isSuperAdmin','lastReminderSentAt'];
  const dataHeaders = ['orgId','entityType','recordId','jsonData','updatedAt','updatedBy'];
  const messageHeaders = ['orgId','messageId','fromUserId','fromName','toScope','toLabel','channel','messageType','subject','body','recipientCount','sentAt'];
  const chatHeaders = ['orgId','chatId','fromUserId','toUserId','body','sentAt','readAt'];
  const upgradeHeaders = ['orgId','requestId','userId','orgName','fullName','email','phone','planRequested','billingCycle','amount','screenshotUrl','status','submittedAt','decidedAt','subscriptionStartDate','subscriptionEndDate'];

  users.getRange(1, 1, 1, userHeaders.length).setValues([userHeaders]);
  users.setFrozenRows(1);
  data.getRange(1, 1, 1, dataHeaders.length).setValues([dataHeaders]);
  data.setFrozenRows(1);
  messages.getRange(1, 1, 1, messageHeaders.length).setValues([messageHeaders]);
  messages.setFrozenRows(1);
  chats.getRange(1, 1, 1, chatHeaders.length).setValues([chatHeaders]);
  chats.setFrozenRows(1);
  upgrades.getRange(1, 1, 1, upgradeHeaders.length).setValues([upgradeHeaders]);
  upgrades.setFrozenRows(1);
  const platformHeaders = ['key', 'value'];
  if (platformSettings.getLastRow() < 1) {
    platformSettings.getRange(1, 1, 1, platformHeaders.length).setValues([platformHeaders]);
    platformSettings.setFrozenRows(1);
  }

  SpreadsheetApp.getUi().alert('Sheets are ready: Users, Data, Messages, Chats, UpgradeRequests, PlatformSettings headers written.\n\nNext steps:\n1. Run installUpgradeApprovalTrigger() once.\n2. Run setupSuperAdmin() once to create your Super Admin login.\n3. Run installReminderTrigger() once to enable twice-monthly subscription reminders.');
}

/* Run this once, manually, to create the Super Admin login (technologyokv@gmail.com).
   Default password is 'OKV557' — change it immediately from the Super Admin Dashboard
   → My Account after your first login. Safe to re-run: won't duplicate if it already exists.
   Lives in the Master's SuperAdmins sheet (see MasterRegistry.gs) — not tied to any org. */
function setupSuperAdmin() {
  const existing = readObjects_(superAdminsSheet_()).find(u => String(u.username).toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase());
  if (existing) {
    SpreadsheetApp.getUi().alert('Super Admin already exists (' + existing.username + '). No changes made.');
    return;
  }
  const now = nowIso_();
  const userId = genId_('sup');
  const passwordHash = sha256Hex_(SUPER_ADMIN_DEFAULT_PASSWORD);
  superAdminsSheet_().appendRow([
    userId, 'OKV Super Admin', SUPER_ADMIN_EMAIL, SUPER_ADMIN_EMAIL, passwordHash, 'Active', '', '', '', '', now, now
  ]);
  SpreadsheetApp.getUi().alert('Super Admin created.\n\nLogin: ' + SUPER_ADMIN_EMAIL + '\nPassword: ' + SUPER_ADMIN_DEFAULT_PASSWORD + '\n\nLog in from the same login page as everyone else, then change this password immediately from My Account.');
}

/* Run this once, manually, from the Apps Script editor (select it in the function
   dropdown, click Run). Installs an edit-watcher on the UpgradeRequests tab so that
   changing a row's status to "Confirmed" or "Rejected" automatically upgrades the
   organization and emails the customer — this is the "before an hour" step: it's
   instant the moment you mark the row, so just check the sheet within the hour. */
function installUpgradeApprovalTrigger() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'onUpgradeSheetEdit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onUpgradeSheetEdit').forSpreadsheet(ss).onEdit().create();
  SpreadsheetApp.getUi().alert('Upgrade-approval trigger installed. Marking a row in UpgradeRequests as Confirmed or Rejected will now automatically email the customer (and upgrade their account, if Confirmed).');
}

/* ============================================================
   ENTRY POINTS
   ============================================================ */
function doGet(e) {
  return jsonOut({ success: true, message: 'OKV Payroll & HR API is running.' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut({ success: false, error: 'Invalid request body.' });
  }
  const action = body.action;
  try {
    let result;
    switch (action) {
      case 'signup':                result = signupOrg(body); break;
      case 'login':                 result = login(body); break;
      case 'validateSession':       result = validateSessionAction(body); break;
      case 'forgotPassword':        result = forgotPassword(body); break;
      case 'resetPassword':         result = resetPassword(body); break;
      case 'changePassword':        result = changePassword(body); break;
      case 'adminListUsers':        result = adminListUsers(body); break;
      case 'adminCreateUser':       result = adminCreateUser(body); break;
      case 'adminUpdateUserRoles':  result = adminUpdateUserRoles(body); break;
      case 'adminSetUserStatus':    result = adminSetUserStatus(body); break;
      case 'adminSetUserPassword':  result = adminSetUserPassword(body); break;
      case 'adminDeleteUser':       result = adminDeleteUser(body); break;
      case 'getData':               result = getData(body); break;
      case 'pushEntity':            result = pushEntity(body); break;
      case 'sendMessage':           result = sendMessageAction(body); break;
      case 'sendInternalMessage':   result = sendInternalMessageAction(body); break;
      case 'getInternalMessages':   result = getInternalMessagesAction(body); break;
      case 'listChatThreads':       result = listChatThreadsAction(body); break;
      case 'submitUpgradeRequest':  result = submitUpgradeRequestAction(body); break;
      case 'getUpgradeRequests':    result = getUpgradeRequestsAction(body); break;
      case 'getPublicPlatformInfo': result = getPublicPlatformInfo(body); break;
      case 'superAdminLogin':            result = login(body); break;
      case 'superAdminChangePassword':   result = changePassword(body); break;
      case 'superAdminListOrgs':         result = superAdminListOrgs(body); break;
      case 'superAdminUpdateOrgContact': result = superAdminUpdateOrgContact(body); break;
      case 'superAdminSetOrgStatus':     result = superAdminSetOrgStatus(body); break;
      case 'superAdminSetOrgPlan':       result = superAdminSetOrgPlan(body); break;
      case 'superAdminSendMessage':      result = superAdminSendMessage(body); break;
      case 'superAdminGetSettings':      result = superAdminGetSettings(body); break;
      case 'superAdminSaveSettings':     result = superAdminSaveSettings(body); break;
      case 'superAdminGetCapacityOverview': result = superAdminGetCapacityOverview(body); break;
      default:                      result = { success: false, error: 'Unknown action: ' + action };
    }
    return jsonOut(result);
  } catch (err) {
    return jsonOut({ success: false, error: String(err && err.message ? err.message : err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   SHEET HELPERS
   ------------------------------------------------------------
   Users/Data/Messages/Chats now live in each tenant's OWN spreadsheet, resolved
   dynamically via getOrgSpreadsheet(orgId) (see MasterRegistry.gs). There is no
   more "the active spreadsheet" for tenant data — the script is bound to the
   MASTER spreadsheet, which holds only Registry/UserIndex/SessionIndex/
   SuperAdmins/CapacityLog/PlatformSettings/UpgradeRequests.
   usersSheet_()/dataSheet_() etc. below are thin aliases kept so the rest of
   this file reads the same as before; they just require an orgId now.
   ============================================================ */
function usersSheet_(orgId) { return tenantUsersSheet_(orgId); }
function dataSheet_(orgId)  { return tenantDataSheet_(orgId); }

function readObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.every(c => c === '')) continue;
    const obj = {};
    headers.forEach((h, j) => obj[h] = row[j]);
    obj.__row = i + 1; // 1-indexed physical sheet row, for updates
    out.push(obj);
  }
  return out;
}

function genId_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12);
}
function nowIso_() { return new Date().toISOString(); }
function safeParse_(str) { try { return JSON.parse(str); } catch (e) { return {}; } }

/* Matches the client's Web Crypto SHA-256 hex output exactly — used only for
   server-seeded passwords (Super Admin default password). */
function sha256Hex_(str) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytes.map(b => ((b < 0 ? b + 256 : b).toString(16)).padStart(2, '0')).join('');
}

/* Looks up a login identifier WITHOUT knowing the org up front: checks the small,
   global SuperAdmins sheet first, then routes through UserIndex to the right
   tenant spreadsheet. This is the only place a login has to "search everywhere". */
function findUserByUsername_(username) {
  const uname = String(username || '').trim().toLowerCase();
  const sa = readObjects_(superAdminsSheet_()).find(u => String(u.username).trim().toLowerCase() === uname);
  if (sa) return superAdminAsUser_(sa);
  const orgId = findOrgIdByUsername_(uname);
  if (!orgId) return null;
  return readObjects_(tenantUsersSheet_(orgId)).find(u => String(u.username).trim().toLowerCase() === uname) || null;
}
/* orgId is required for tenant users; pass '' / omit for a Super Admin lookup. */
function findUserById_(userId, orgId) {
  if (!orgId) return null;
  return readObjects_(tenantUsersSheet_(orgId)).find(u => u.userId === userId) || null;
}
/* Adapts a SuperAdmins row to the same shape used everywhere else (publicUser_,
   requireAdmin_, requireSuperAdmin_ all read u.isAdmin/u.isSuperAdmin/u.orgId). */
function superAdminAsUser_(sa) {
  return Object.assign({}, sa, {
    orgId: '', orgName: '', isAdmin: false, isSuperAdmin: true, roles: '', plan: '', billingCycle: '',
    subscriptionStatus: '', subscriptionExpiry: '', trialEndsAt: '', subscriptionStartDate: '', employeeId: '',
    __isSuperAdminRow: true
  });
}
/* Resolves a bare sessionToken to its user, using SessionIndex (Master) to find
   which tenant to open, then re-checking the token directly against that tenant's
   Users row — so a suspended/logged-out user (whose row-level sessionToken was
   cleared) can't keep authenticating off a stale index entry. */
function findUserBySessionToken_(token) {
  if (!token) return null;
  const idx = getSessionIndex_(token);
  if (!idx) return null;
  if (idx.orgId === 'PLATFORM') {
    const sa = readObjects_(superAdminsSheet_()).find(r => r.userId === idx.userId);
    return (sa && sa.sessionToken === token) ? superAdminAsUser_(sa) : null;
  }
  const row = readObjects_(tenantUsersSheet_(idx.orgId)).find(r => r.userId === idx.userId);
  return (row && row.sessionToken === token) ? row : null;
}
function updateUserRow_(userObj, patch) {
  const sheet = userObj.__isSuperAdminRow ? superAdminsSheet_() : tenantUsersSheet_(userObj.orgId);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const merged = Object.assign({}, userObj, patch, { updatedAt: nowIso_() });
  const rowVals = headers.map(h => merged[h] !== undefined ? merged[h] : '');
  sheet.getRange(userObj.__row, 1, 1, headers.length).setValues([rowVals]);
  if (!userObj.__isSuperAdminRow && (patch.sessionToken !== undefined)) {
    if (patch.sessionToken) setSessionIndex_(patch.sessionToken, userObj.orgId, userObj.userId, patch.sessionTokenExpiry || '');
    else clearSessionIndex_(userObj.userId);
  }
}

/* Validates a session token: exists, not expired, account Active, subscription active or trialing. Throws on failure.
   Org-level gating (status/plan/trial/expiry) is read from the Registry — the single source of
   truth for subscription state — not from the tenant's own Users row, so a Super Admin edit in
   superAdminSetOrgPlan/Status takes effect immediately without touching every tenant spreadsheet. */
function requireSession_(sessionToken) {
  const u = findUserBySessionToken_(sessionToken);
  if (!u) throw new Error('Your session has expired. Please log in again.');
  if (new Date(u.sessionTokenExpiry) < new Date()) throw new Error('Your session has expired. Please log in again.');
  if (String(u.status) !== 'Active') throw new Error('Your account has been suspended. Contact your Admin.');
  if (u.isSuperAdmin === true || String(u.isSuperAdmin).toUpperCase() === 'TRUE') return u; // no org, no subscription — skip the checks below
  const reg = getRegistryRow_(u.orgId);
  if (reg) {
    if (String(reg.status) !== 'Active') throw new Error('Your organization has been suspended. Contact support.');
    const subStatus = String(reg.subscriptionStatus || '');
    if (subStatus === 'trialing') {
      if (reg.trialEndsAt && new Date(reg.trialEndsAt) < new Date()) throw new Error('Your free trial has ended. Upgrade your plan to continue.');
    } else if (subStatus !== 'active') {
      throw new Error('Your organization\'s subscription is inactive.');
    } else if (reg.subscriptionExpiry && new Date(reg.subscriptionExpiry) < new Date()) {
      throw new Error('Your organization\'s subscription has expired.');
    }
  }
  return u;
}
function requireAdmin_(sessionToken) {
  const u = requireSession_(sessionToken);
  if (u.isAdmin !== true && String(u.isAdmin).toUpperCase() !== 'TRUE') throw new Error('Admin access required.');
  return u;
}
function requireSuperAdmin_(sessionToken) {
  const u = requireSession_(sessionToken);
  if (!(u.isSuperAdmin === true || String(u.isSuperAdmin).toUpperCase() === 'TRUE')) throw new Error('Super Admin access required.');
  return u;
}
function publicUser_(u) {
  return {
    orgId: u.orgId, orgName: u.orgName, userId: u.userId, fullName: u.fullName, username: u.username,
    email: u.email || '', phone: u.phone || '',
    isAdmin: (u.isAdmin === true || String(u.isAdmin).toUpperCase() === 'TRUE'),
    isSuperAdmin: (u.isSuperAdmin === true || String(u.isSuperAdmin).toUpperCase() === 'TRUE'),
    roles: String(u.roles || '').split(',').map(r => r.trim()).filter(Boolean),
    status: u.status, employeeId: u.employeeId || '',
    plan: u.plan || '', billingCycle: u.billingCycle || '',
    subscriptionStatus: u.subscriptionStatus, subscriptionStartDate: u.subscriptionStartDate || '', subscriptionExpiry: u.subscriptionExpiry,
    trialEndsAt: u.trialEndsAt || ''
  };
}

/* ============================================================
   AUTH ACTIONS
   ============================================================ */
function signupOrg(body) {
  const orgName = String(body.orgName || '').trim();
  const fullName = String(body.fullName || '').trim();
  const username = String(body.username || '').trim().toLowerCase();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim();
  const passwordHash = String(body.passwordHash || '');
  const plan = String(body.plan || 'Essential');
  const billingCycle = String(body.billingCycle || 'monthly');
  if (!orgName || !fullName || !username || !email || !passwordHash) return { success: false, error: 'All required fields must be filled in.' };
  if (isUsernameOrEmailTaken_(username, email)) return { success: false, error: 'That username or email is already registered.' };

  const orgId = genId_('org');
  const userId = genId_('usr');
  const sessionToken = genId_('tok');
  const sessionExpiry = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString();
  const now = nowIso_();

  // Per-tenant spreadsheet, created fresh for this org — see MasterRegistry.gs.
  const spreadsheetId = createTenantSpreadsheet_(orgName, orgId);

  // Registry row MUST exist before the first tenantUsersSheet_(orgId) call below,
  // since getOrgSpreadsheet(orgId) resolves the spreadsheet ID from the Registry.
  appendRegistryRow_({
    orgId: orgId, orgName: orgName, spreadsheetId: spreadsheetId,
    adminUserId: userId, adminFullName: fullName, adminEmail: email, adminPhone: phone,
    plan: plan, billingCycle: billingCycle, status: 'Active', subscriptionStatus: 'trialing',
    subscriptionStartDate: '', subscriptionExpiry: '', trialEndsAt: trialEndsAt,
    createdAt: now, updatedAt: now, lastReminderSentAt: '',
    cellsUsed: '', cellPercentUsed: '', rowsAddedRecent: '', estMonthsRemaining: '',
    capacityStatus: '', lastCapacityCheck: '', capacityAlertSent: false
  });

  tenantUsersSheet_(orgId).appendRow([
    orgId, orgName, userId, fullName, username, email, phone, passwordHash, true, 'HR/Payroll Super Admin',
    plan, billingCycle, 'Active', 'trialing', '', '', trialEndsAt, '', '', sessionToken, sessionExpiry, '', now, now, false, ''
  ]);
  addUserIndexEntry_(username, email, orgId);
  setSessionIndex_(sessionToken, orgId, userId, sessionExpiry);

  try {
    MailApp.sendEmail({
      to: email,
      subject: 'Welcome to OKV Nigeria Payroll & HR — your 7-day free trial has started',
      htmlBody: 'Hello ' + fullName + ',<br><br>' +
        'Your organization "' + orgName + '" is set up on the <b>' + plan + '</b> plan (' + billingCycle + ' billing).<br><br>' +
        'Your login username is: <b>' + username + '</b><br>' +
        'Your 7-day free trial is active now and ends on ' + new Date(trialEndsAt).toDateString() + '.<br><br>' +
        'Install the app and log in to get started: see the installation link in the app, or visit your install page.<br><br>' +
        '— OKV Technology Consults'
    });
  } catch (e) { /* email delivery issues shouldn't block signup */ }

  return {
    success: true,
    message: 'Account created.',
    user: {
      orgId, orgName, userId, fullName, username, email, phone, isAdmin: true,
      roles: ['HR/Payroll Super Admin'], status: 'Active', plan, billingCycle,
      subscriptionStatus: 'trialing', subscriptionExpiry: '', trialEndsAt
    },
    sessionToken, sessionTokenExpiry: sessionExpiry
  };
}

function login(body) {
  const username = String(body.username || '').trim().toLowerCase();
  const passwordHash = String(body.passwordHash || '');
  const u = findUserByUsername_(username);
  if (!u || u.passwordHash !== passwordHash) return { success: false, error: 'Invalid username or password.' };
  if (String(u.status) !== 'Active') return { success: false, error: 'Your account has been suspended. Contact your Admin.' };

  // Super Admin has no org/subscription — skip straight to issuing a session.
  if (u.isSuperAdmin === true || String(u.isSuperAdmin).toUpperCase() === 'TRUE') {
    const sToken = genId_('tok');
    const sExpiry = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    updateUserRow_(u, { sessionToken: sToken, sessionTokenExpiry: sExpiry });
    setSessionIndex_(sToken, 'PLATFORM', u.userId, sExpiry);
    return { success: true, user: publicUser_(u), sessionToken: sToken, sessionTokenExpiry: sExpiry };
  }

  // Org-level status/plan/trial/expiry is authoritative on the Registry (Master), not this tenant row.
  const reg = getRegistryRow_(u.orgId);
  if (!reg) return { success: false, error: 'Your organization could not be found. Contact support.' };
  if (String(reg.status) !== 'Active') {
    return { success: false, error: 'Your organization has been suspended. Contact support.' };
  }
  const subStatus = String(reg.subscriptionStatus || '');
  if (subStatus === 'trialing') {
    if (reg.trialEndsAt && new Date(reg.trialEndsAt) < new Date()) {
      return { success: false, error: 'Your 7-day free trial has ended. Upgrade your plan to continue.', trialExpired: true };
    }
  } else if (subStatus !== 'active') {
    return { success: false, error: 'Your organization\'s subscription is inactive. Upgrade your plan to continue.' };
  }
  if (reg.subscriptionExpiry && subStatus === 'active' && new Date(reg.subscriptionExpiry) < new Date()) {
    return { success: false, error: 'Your organization\'s subscription has expired. Renew to continue.' };
  }

  const sessionToken = genId_('tok');
  const sessionExpiry = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  updateUserRow_(u, { sessionToken, sessionTokenExpiry: sessionExpiry }); // also updates SessionIndex — see updateUserRow_

  const pub = publicUser_(u);
  // Trial/subscription state is authoritative on the Registry — reflect it for every user in the org.
  pub.subscriptionStatus = reg.subscriptionStatus; pub.subscriptionExpiry = reg.subscriptionExpiry;
  pub.trialEndsAt = reg.trialEndsAt; pub.plan = reg.plan; pub.billingCycle = reg.billingCycle;
  pub.subscriptionStartDate = reg.subscriptionStartDate || '';
  return { success: true, user: pub, sessionToken, sessionTokenExpiry: sessionExpiry };
}

function validateSessionAction(body) {
  try {
    const u = requireSession_(body.sessionToken);
    const pub = publicUser_(u);
    if (!pub.isSuperAdmin) {
      // Overlay authoritative subscription/plan state from the Registry — the tenant
      // row's own copy of these fields can go stale for non-Admin users, who never
      // get individually re-synced after superAdminSetOrgPlan/Status or an upgrade approval.
      const reg = getRegistryRow_(u.orgId);
      if (reg) {
        pub.subscriptionStatus = reg.subscriptionStatus; pub.subscriptionExpiry = reg.subscriptionExpiry;
        pub.trialEndsAt = reg.trialEndsAt; pub.plan = reg.plan; pub.billingCycle = reg.billingCycle;
        pub.subscriptionStartDate = reg.subscriptionStartDate || '';
      }
    }
    return { success: true, user: pub };
  } catch (err) {
    return { success: false, error: String(err.message || err) };
  }
}

function forgotPassword(body) {
  const email = String(body.email || body.username || '').trim().toLowerCase();
  const resetBaseUrl = String(body.resetBaseUrl || RESET_PAGE_URL || '');
  const orgId = findOrgIdByEmail_(email);
  const u = orgId ? readObjects_(tenantUsersSheet_(orgId)).find(x => String(x.email).toLowerCase() === email) : null;
  // Only Admins get an email reset flow (Users are reset by their Admin). Respond generically
  // either way so the endpoint can't be used to enumerate which accounts exist.
  if (u && (u.isAdmin === true || String(u.isAdmin).toUpperCase() === 'TRUE') && resetBaseUrl) {
    const token = genId_('rst');
    const expiry = new Date(Date.now() + RESET_TOKEN_MINUTES * 60000).toISOString();
    updateUserRow_(u, { resetToken: token, resetTokenExpiry: expiry });
    setResetIndex_(token, orgId, u.userId, expiry);
    const link = resetBaseUrl + (resetBaseUrl.indexOf('?') > -1 ? '&' : '?') + 'token=' + encodeURIComponent(token);
    const body_ = 'Hello ' + u.fullName + ',\n\n' +
      'A password reset was requested for your OKV Payroll & HR account (' + u.username + ').\n\n' +
      'Reset your password here (link expires in ' + RESET_TOKEN_MINUTES + ' minutes):\n' + link + '\n\n' +
      'If you did not request this, you can safely ignore this email.\n\n— OKV Technology Consults';
    MailApp.sendEmail(u.email, 'Reset your OKV Payroll & HR password', body_);
  }
  return { success: true, message: 'If that account exists, a reset link has been sent to its email address.' };
}

function resetPassword(body) {
  const token = String(body.token || '');
  const newPasswordHash = String(body.newPasswordHash || '');
  if (!token || !newPasswordHash) return { success: false, error: 'Missing token or new password.' };
  const idx = getResetIndex_(token);
  const u = idx ? readObjects_(tenantUsersSheet_(idx.orgId)).find(x => x.resetToken === token) : null;
  if (!u) return { success: false, error: 'This reset link is invalid or has already been used.' };
  if (!u.resetTokenExpiry || new Date(u.resetTokenExpiry) < new Date()) return { success: false, error: 'This reset link has expired. Please request a new one.' };
  updateUserRow_(u, { passwordHash: newPasswordHash, resetToken: '', resetTokenExpiry: '' });
  clearResetIndex_(u.userId);
  return { success: true, message: 'Password reset successfully.' };
}

function changePassword(body) {
  const u = requireSession_(body.sessionToken);
  if (u.passwordHash !== String(body.currentPasswordHash || '')) return { success: false, error: 'Current password is incorrect.' };
  updateUserRow_(u, { passwordHash: String(body.newPasswordHash || '') });
  return { success: true };
}

/* ============================================================
   ADMIN — USER MANAGEMENT (scoped to the admin's own orgId)
   ============================================================ */
function adminListUsers(body) {
  const admin = requireAdmin_(body.sessionToken);
  const users = readObjects_(usersSheet_(admin.orgId))
    .filter(u => u.orgId === admin.orgId)
    .map(u => ({
      userId: u.userId, fullName: u.fullName, username: u.username,
      isAdmin: (u.isAdmin === true || String(u.isAdmin).toUpperCase() === 'TRUE'),
      roles: String(u.roles || '').split(',').map(r => r.trim()).filter(Boolean),
      status: u.status, employeeId: u.employeeId || '', createdAt: u.createdAt
    }));
  return { success: true, users };
}

function adminCreateUser(body) {
  const admin = requireAdmin_(body.sessionToken);
  const fullName = String(body.fullName || '').trim();
  const username = String(body.username || '').trim().toLowerCase();
  const passwordHash = String(body.passwordHash || '');
  const roles = Array.isArray(body.roles) ? body.roles.filter(Boolean) : [];
  const employeeId = String(body.employeeId || '');
  if (!fullName || !username || !passwordHash) return { success: false, error: 'Full name, username and password are required.' };
  if (isUsernameOrEmailTaken_(username, '')) return { success: false, error: 'That username/email is already registered.' };

  const userId = genId_('usr');
  const now = nowIso_();
  usersSheet_(admin.orgId).appendRow([
    admin.orgId, admin.orgName, userId, fullName, username, '', '', passwordHash, false, roles.join(','),
    admin.plan || '', admin.billingCycle || '', 'Active', admin.subscriptionStatus || 'trialing', admin.subscriptionStartDate || '', admin.subscriptionExpiry || '',
    admin.trialEndsAt || '', '', '', '', '', employeeId, now, now, false, ''
  ]);
  addUserIndexEntry_(username, '', admin.orgId);
  return { success: true, userId };
}

function adminUpdateUserRoles(body) {
  const admin = requireAdmin_(body.sessionToken);
  const target = findUserById_(body.userId, admin.orgId);
  if (!target || target.orgId !== admin.orgId) return { success: false, error: 'User not found in your organization.' };
  const roles = Array.isArray(body.roles) ? body.roles.filter(Boolean) : [];
  updateUserRow_(target, { roles: roles.join(',') });
  return { success: true };
}

function adminSetUserStatus(body) {
  const admin = requireAdmin_(body.sessionToken);
  const target = findUserById_(body.userId, admin.orgId);
  if (!target || target.orgId !== admin.orgId) return { success: false, error: 'User not found in your organization.' };
  const status = body.status === 'Suspended' ? 'Suspended' : 'Active';
  const patch = { status: status };
  if (status === 'Suspended') { patch.sessionToken = ''; patch.sessionTokenExpiry = ''; } // force logout
  updateUserRow_(target, patch);
  return { success: true };
}

function adminSetUserPassword(body) {
  const admin = requireAdmin_(body.sessionToken);
  const target = findUserById_(body.userId, admin.orgId);
  if (!target || target.orgId !== admin.orgId) return { success: false, error: 'User not found in your organization.' };
  updateUserRow_(target, { passwordHash: String(body.newPasswordHash || '') });
  return { success: true };
}

function adminDeleteUser(body) {
  const admin = requireAdmin_(body.sessionToken);
  const target = findUserById_(body.userId, admin.orgId);
  if (!target || target.orgId !== admin.orgId) return { success: false, error: 'User not found in your organization.' };
  const isTargetAdmin = (target.isAdmin === true || String(target.isAdmin).toUpperCase() === 'TRUE');
  if (isTargetAdmin) {
    const adminCount = readObjects_(usersSheet_(admin.orgId)).filter(u => u.orgId === admin.orgId && (u.isAdmin === true || String(u.isAdmin).toUpperCase() === 'TRUE')).length;
    if (adminCount <= 1) return { success: false, error: 'Cannot delete the only Admin in this organization.' };
  }
  usersSheet_(admin.orgId).deleteRow(target.__row);
  removeUserIndexEntry_(target.username);
  clearSessionIndex_(target.userId);
  return { success: true };
}

/* ============================================================
   DATA SYNC  (whole-entity-type replace, scoped to orgId)
   ============================================================ */
function getData(body) {
  const u = requireSession_(body.sessionToken);
  const rows = readObjects_(dataSheet_(u.orgId)).filter(r => r.orgId === u.orgId);
  const entities = {};
  ALL_ENTITY_TYPES.forEach(t => entities[t] = []);
  rows.forEach(r => {
    let parsed;
    try { parsed = JSON.parse(r.jsonData); } catch (e) { parsed = null; }
    if (!entities[r.entityType]) entities[r.entityType] = [];
    entities[r.entityType].push({ recordId: r.recordId, data: parsed, updatedAt: r.updatedAt, updatedBy: r.updatedBy });
  });
  return { success: true, entities: entities };
}

function pushEntity(body) {
  const u = requireSession_(body.sessionToken);
  const entityType = String(body.entityType || '');
  if (ALL_ENTITY_TYPES.indexOf(entityType) === -1) return { success: false, error: 'Unknown entity type.' };
  const records = Array.isArray(body.records) ? body.records : [];

  const sheet = dataSheet_(u.orgId);
  const all = readObjects_(sheet);
  // Remove existing rows for this org+entityType (delete bottom-up to keep row indices valid)
  const toDelete = all.filter(r => r.orgId === u.orgId && r.entityType === entityType).map(r => r.__row).sort((a, b) => b - a);
  toDelete.forEach(rowNum => sheet.deleteRow(rowNum));

  const now = nowIso_();
  if (records.length) {
    const newRows = records.map(r => [u.orgId, entityType, String(r.recordId || ''), JSON.stringify(r.data || {}), now, u.username]);
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 6).setValues(newRows);
  }
  return { success: true, count: records.length, syncedAt: now };
}

/* ============================================================
   ANNOUNCEMENTS / PERSONALIZED MESSAGES / PAYSLIP DELIVERY
   Email always works out of the box (MailApp). SMS and WhatsApp
   need a third-party gateway — see sendViaSms_/sendViaWhatsApp_
   below for where to plug in your provider (e.g. Termii, Twilio).
   ============================================================ */
// Messages/Chats now live per-tenant (see MasterRegistry.gs); UpgradeRequests stays
// in the Master since Super Admin needs to see/approve requests across all orgs.
function messagesSheet_(orgId) { return tenantMessagesSheet_(orgId); }
function chatsSheet_(orgId) { return tenantChatsSheet_(orgId); }
function upgradeSheet_() { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('UpgradeRequests'); }
// Log of Super Admin -> all-orgs broadcasts (platform-wide, so it belongs in the Master, not any one tenant).
const PLATFORM_MESSAGE_HEADERS = ['messageId', 'fromUserId', 'fromName', 'toScope', 'toLabel', 'channel', 'messageType', 'subject', 'body', 'recipientCount', 'sentAt'];
function platformMessagesSheet_() { return ensureSheetWithHeaders_(SpreadsheetApp.getActiveSpreadsheet(), 'PlatformMessages', PLATFORM_MESSAGE_HEADERS); }

function canSendComms_(u) {
  if (u.isAdmin === true || String(u.isAdmin).toUpperCase() === 'TRUE') return true;
  const roles = String(u.roles || '').split(',').map(r => r.trim());
  return roles.some(r => COMMS_ROLES.indexOf(r) !== -1);
}

/* Sends one message to one or many recipients over one channel. Each recipient can carry
   its own personalized `body` (used for payslips and birthday/anniversary notes); otherwise
   the shared `sharedBody` is used for everyone (plain announcements). */
function sendMessageAction(body) {
  const u = requireSession_(body.sessionToken);
  if (!canSendComms_(u)) return { success: false, error: 'You don\'t have permission to send announcements. Contact your Admin.' };

  const channel = String(body.channel || 'email');
  const subject = String(body.subject || 'Message from ' + (u.orgName || 'your organization'));
  const sharedBody = String(body.sharedBody || '');
  const messageType = String(body.messageType || 'custom');
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  if (!recipients.length) return { success: false, error: 'No recipients selected.' };

  let sent = 0;
  const failed = [];
  recipients.forEach(r => {
    const text = r.body || sharedBody;
    try {
      if (channel === 'email') {
        if (!r.email) throw new Error('No email on file');
        MailApp.sendEmail({ to: r.email, subject: subject, htmlBody: text });
      } else if (channel === 'sms') {
        if (!r.phone) throw new Error('No phone on file');
        sendViaSms_(r.phone, stripHtml_(text));
      } else if (channel === 'whatsapp') {
        if (!r.phone) throw new Error('No phone on file');
        sendViaWhatsApp_(r.phone, stripHtml_(text));
      }
      sent++;
    } catch (err) {
      failed.push({ name: r.name || r.email || r.phone || 'Unknown', reason: String(err.message || err) });
    }
  });

  messagesSheet_(u.orgId).appendRow([
    u.orgId, genId_('msg'), u.userId, u.fullName, recipients.length > 1 ? 'multiple' : 'individual',
    recipients.length > 1 ? (recipients.length + ' recipients') : (recipients[0].name || recipients[0].email || recipients[0].phone || ''),
    channel, messageType, subject, sharedBody, sent, nowIso_()
  ]);

  return { success: true, sent: sent, failed: failed };
}

/* SMS gateway (e.g. Termii, Africa's Talking, Twilio). Prefers the Super Admin
   Dashboard's Settings → Communications config (PlatformSettings sheet); falls back
   to Script Properties (SMS_API_URL/SMS_API_KEY/SMS_SENDER_ID) for backward
   compatibility. Until either is set and enabled, this throws — sendMessageAction
   reports it as a failed recipient rather than silently pretending it sent. */
function sendViaSms_(phone, text) {
  const cfg = getPlatformSettings_().comms.sms || {};
  const props = PropertiesService.getScriptProperties();
  const apiUrl = cfg.apiUrl || props.getProperty('SMS_API_URL');
  const apiKey = cfg.apiKey || props.getProperty('SMS_API_KEY');
  const senderId = cfg.senderId || props.getProperty('SMS_SENDER_ID') || 'OKV';
  if (cfg.apiUrl && cfg.enabled === false) throw new Error('SMS is disabled in Platform Settings.');
  if (!apiUrl || !apiKey) throw new Error('SMS is not configured yet — set it up in the Super Admin Dashboard → Settings → Communications.');
  UrlFetchApp.fetch(apiUrl, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ api_key: apiKey, to: normalizePhone_(phone), from: senderId, sms: text, type: 'plain', channel: 'generic' })
  });
}

/* WhatsApp Business API / gateway (e.g. Twilio, Meta Cloud API, Termii WhatsApp).
   Same pattern as SMS above — Platform Settings first, Script Properties fallback. */
function sendViaWhatsApp_(phone, text) {
  const cfg = getPlatformSettings_().comms.whatsapp || {};
  const props = PropertiesService.getScriptProperties();
  const apiUrl = cfg.apiUrl || props.getProperty('WHATSAPP_API_URL');
  const apiKey = cfg.apiKey || props.getProperty('WHATSAPP_API_KEY');
  if (cfg.apiUrl && cfg.enabled === false) throw new Error('WhatsApp is disabled in Platform Settings.');
  if (!apiUrl || !apiKey) throw new Error('WhatsApp is not configured yet — set it up in the Super Admin Dashboard → Settings → Communications.');
  UrlFetchApp.fetch(apiUrl, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify({ to: normalizePhone_(phone), message: text })
  });
}
function normalizePhone_(phone) {
  let p = String(phone || '').replace(/[^0-9+]/g, '');
  if (p.startsWith('0')) p = '234' + p.slice(1); // Nigerian local → international
  return p.replace('+', '');
}
function stripHtml_(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ============================================================
   INTERNAL MESSAGING (Admin ↔ User)
   ============================================================ */
function chatId_(a, b) { return [a, b].sort().join('__'); }

function sendInternalMessageAction(body) {
  const u = requireSession_(body.sessionToken);
  const toUserId = String(body.toUserId || '');
  const text = String(body.body || '').trim();
  if (!toUserId || !text) return { success: false, error: 'Message text is required.' };
  const target = findUserById_(toUserId, u.orgId);
  if (!target || target.orgId !== u.orgId) return { success: false, error: 'Recipient not found in your organization.' };

  chatsSheet_(u.orgId).appendRow([u.orgId, chatId_(u.userId, toUserId), u.userId, toUserId, text, nowIso_(), '']);
  return { success: true };
}

function getInternalMessagesAction(body) {
  const u = requireSession_(body.sessionToken);
  const withUserId = String(body.withUserId || '');
  if (!withUserId) return { success: false, error: 'withUserId is required.' };
  const cid = chatId_(u.userId, withUserId);
  const sheet = chatsSheet_(u.orgId);
  const rows = readObjects_(sheet).filter(r => r.orgId === u.orgId && r.chatId === cid);
  rows.sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
  // Mark messages sent TO me as read
  rows.forEach(r => {
    if (r.toUserId === u.userId && !r.readAt) {
      sheet.getRange(r.__row, 7).setValue(nowIso_()); // readAt is column 7
    }
  });
  return {
    success: true,
    messages: rows.map(r => ({ fromUserId: r.fromUserId, toUserId: r.toUserId, body: r.body, sentAt: r.sentAt }))
  };
}

/* For the Admin: list every User they've exchanged messages with, so the inbox has a thread list. */
function listChatThreadsAction(body) {
  const u = requireSession_(body.sessionToken);
  const rows = readObjects_(chatsSheet_(u.orgId)).filter(r => r.orgId === u.orgId && (r.fromUserId === u.userId || r.toUserId === u.userId));
  const otherIds = [...new Set(rows.map(r => (r.fromUserId === u.userId ? r.toUserId : r.fromUserId)))];
  const users = readObjects_(usersSheet_(u.orgId));
  const threads = otherIds.map(id => {
    const other = users.find(x => x.userId === id);
    const mine = rows.filter(r => r.fromUserId === id || r.toUserId === id);
    mine.sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
    const unread = mine.filter(r => r.toUserId === u.userId && !r.readAt).length;
    return {
      userId: id, fullName: other ? other.fullName : 'Unknown', unread: unread,
      lastMessage: mine[0] ? mine[0].body : '', lastAt: mine[0] ? mine[0].sentAt : ''
    };
  });
  threads.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
  return { success: true, threads: threads };
}

/* ============================================================
   MANUAL UPGRADE / BANK TRANSFER FLOW
   ============================================================ */
function submitUpgradeRequestAction(body) {
  const u = requireAdmin_(body.sessionToken); // subscription is org-level — only the Admin submits
  const orgName = String(body.orgName || u.orgName).trim();
  const fullName = String(body.fullName || u.fullName).trim();
  const email = String(body.email || u.email).trim();
  const phone = String(body.phone || u.phone).trim();
  const planRequested = String(body.planRequested || '');
  const billingCycle = String(body.billingCycle || 'monthly');
  const screenshotBase64 = String(body.screenshotBase64 || '');
  const screenshotFileName = String(body.screenshotFileName || 'payment-screenshot.jpg');
  if (!planRequested || !screenshotBase64) return { success: false, error: 'Select a plan and attach your payment screenshot.' };

  let screenshotUrl = '';
  try {
    const bytes = Utilities.base64Decode(screenshotBase64.split(',').pop());
    const blob = Utilities.newBlob(bytes, undefined, screenshotFileName);
    const file = DriveApp.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    screenshotUrl = file.getUrl();
  } catch (e) {
    return { success: false, error: 'Could not upload the payment screenshot. Please try a smaller image.' };
  }

  const platformSettingsForAmount = getPlatformSettings_();
  const amount = (platformSettingsForAmount.plans[planRequested] && platformSettingsForAmount.plans[planRequested][billingCycle]) || (PLAN_PRICES[planRequested] && PLAN_PRICES[planRequested][billingCycle]) || 0;
  const requestId = genId_('upg');
  const now = nowIso_();
  upgradeSheet_().appendRow([
    u.orgId, requestId, u.userId, orgName, fullName, email, phone, planRequested, billingCycle,
    amount, screenshotUrl, 'Pending', now, '', '', ''
  ]);

  const platformInfo = getPlatformSettings_();
  MailApp.sendEmail({
    to: platformInfo.companyEmail,
    subject: 'New Upgrade Request — ' + orgName + ' (' + planRequested + ', ' + billingCycle + ')',
    htmlBody:
      'A new upgrade request was submitted.<br><br>' +
      '<b>Organization:</b> ' + orgName + '<br>' +
      '<b>Contact:</b> ' + fullName + ' — ' + email + ' — ' + phone + '<br>' +
      '<b>Plan requested:</b> ' + planRequested + ' (' + billingCycle + ')<br>' +
      '<b>Expected amount:</b> ₦' + amount.toLocaleString('en-NG') + '<br>' +
      '<b>Payment screenshot:</b> <a href="' + screenshotUrl + '">' + screenshotUrl + '</a><br>' +
      '<b>Request ID:</b> ' + requestId + '<br><br>' +
      'Open the UpgradeRequests sheet and change this row\'s "status" column to <b>Confirmed</b> or <b>Rejected</b> — the customer is emailed automatically the moment you do.'
  });

  return { success: true, message: 'Upgrade request submitted. You\'ll receive an email with your status within the hour.' };
}

function getUpgradeRequestsAction(body) {
  const u = requireAdmin_(body.sessionToken);
  const rows = readObjects_(upgradeSheet_()).filter(r => r.orgId === u.orgId);
  rows.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  return { success: true, requests: rows.map(r => ({
    requestId: r.requestId, planRequested: r.planRequested, billingCycle: r.billingCycle, amount: r.amount,
    status: r.status, submittedAt: r.submittedAt, decidedAt: r.decidedAt,
    subscriptionStartDate: r.subscriptionStartDate, subscriptionEndDate: r.subscriptionEndDate
  })) };
}

/* Installable trigger — see installUpgradeApprovalTrigger() above.
   Fires whenever ANY cell in this spreadsheet is edited; we only act when the edit
   lands on the "status" column of the UpgradeRequests sheet. */
function onUpgradeSheetEdit(e) {
  try {
    const sheet = e.range.getSheet();
    if (sheet.getName() !== 'UpgradeRequests') return;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const statusCol = headers.indexOf('status') + 1;
    if (e.range.getColumn() !== statusCol || e.range.getRow() === 1) return;

    const newStatus = String(e.range.getValue()).trim();
    if (newStatus !== 'Confirmed' && newStatus !== 'Rejected') return;

    const rowNum = e.range.getRow();
    const rowVals = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
    const row = {};
    headers.forEach((h, i) => row[h] = rowVals[i]);
    if (row.decidedAt) return; // already processed — avoid double-sending on re-edit

    const platformInfo = getPlatformSettings_();
    const now = nowIso_();
    if (newStatus === 'Confirmed') {
      const days = BILLING_CYCLE_DAYS[row.billingCycle] || 30;
      const startDate = now;
      const endDate = new Date(Date.now() + days * 86400000).toISOString();

      // Update the request row
      sheet.getRange(rowNum, headers.indexOf('decidedAt') + 1).setValue(now);
      sheet.getRange(rowNum, headers.indexOf('subscriptionStartDate') + 1).setValue(startDate);
      sheet.getRange(rowNum, headers.indexOf('subscriptionEndDate') + 1).setValue(endDate);

      // Upgrade the organization: Registry is authoritative (read by login/requireSession_);
      // the tenant Admin row is also updated so the org's own dashboard reflects it.
      try {
        updateRegistryRow_(row.orgId, {
          plan: row.planRequested, billingCycle: row.billingCycle, subscriptionStatus: 'active',
          subscriptionStartDate: startDate, subscriptionExpiry: endDate
        });
      } catch (regErr) { console.error('Registry update failed for ' + row.orgId, regErr); }
      const admin = findUserById_(row.userId, row.orgId);
      if (admin) {
        updateUserRow_(admin, {
          plan: row.planRequested, billingCycle: row.billingCycle, subscriptionStatus: 'active',
          subscriptionStartDate: startDate, subscriptionExpiry: endDate
        });
      }

      MailApp.sendEmail({
        to: row.email,
        subject: 'Your OKV Payroll & HR upgrade is confirmed 🎉',
        htmlBody: 'Hello ' + row.fullName + ',<br><br>' +
          'Your payment has been confirmed and <b>' + row.orgName + '</b> is now upgraded to the <b>' + row.planRequested + '</b> plan (' + row.billingCycle + ' billing).<br><br>' +
          'Subscription start: ' + new Date(startDate).toDateString() + '<br>' +
          'Renewal due: ' + new Date(endDate).toDateString() + '<br><br>' +
          'This is now live on your dashboard. Thank you for upgrading!<br><br>— OKV Technology Consults<br>' +
          platformInfo.companyEmail + ' · ' + platformInfo.companyPhone + ' · ' + platformInfo.companyWebsite
      });
    } else {
      sheet.getRange(rowNum, headers.indexOf('decidedAt') + 1).setValue(now);
      MailApp.sendEmail({
        to: row.email,
        subject: 'Update on your OKV Payroll & HR upgrade request',
        htmlBody: 'Hello ' + row.fullName + ',<br><br>' +
          'We were unable to confirm the payment for your recent upgrade request for <b>' + row.orgName + '</b>. ' +
          'This can happen if the amount, reference, or screenshot didn\'t match what we received.<br><br>' +
          'Please reach out so we can sort it out:<br>' +
          'Email: ' + platformInfo.companyEmail + '<br>Phone/WhatsApp: ' + platformInfo.companyPhone + '<br>Website: ' + platformInfo.companyWebsite + '<br><br>' +
          '— OKV Technology Consults'
      });
    }
  } catch (err) {
    // Never let a trigger error block sheet editing — log it for later inspection instead.
    console.error('onUpgradeSheetEdit failed', err);
  }
}

/* ============================================================
   PLATFORM SETTINGS  (Super Admin — branding, contact, payment
   methods & gateways, comms providers, pricing/plans — all editable
   live from the Super Admin Dashboard, no redeploy needed)
   ============================================================ */
function platformSettingsSheet_() { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PlatformSettings'); }

function getPlatformSettings_() {
  const rows = readObjects_(platformSettingsSheet_());
  const row = rows.find(r => r.key === 'config');
  const stored = row ? safeParse_(row.value) : {};
  return {
    companyEmail: stored.companyEmail || DEFAULT_PLATFORM_SETTINGS.companyEmail,
    companyPhone: stored.companyPhone || DEFAULT_PLATFORM_SETTINGS.companyPhone,
    companyWebsite: stored.companyWebsite || DEFAULT_PLATFORM_SETTINGS.companyWebsite,
    logoUrl: stored.logoUrl || DEFAULT_PLATFORM_SETTINGS.logoUrl,
    primaryColor: stored.primaryColor || DEFAULT_PLATFORM_SETTINGS.primaryColor,
    accentColor: stored.accentColor || DEFAULT_PLATFORM_SETTINGS.accentColor,
    manualPaymentMethods: (stored.manualPaymentMethods && stored.manualPaymentMethods.length) ? stored.manualPaymentMethods : DEFAULT_PLATFORM_SETTINGS.manualPaymentMethods,
    gateways: Object.assign({}, DEFAULT_PLATFORM_SETTINGS.gateways, stored.gateways),
    comms: Object.assign({}, DEFAULT_PLATFORM_SETTINGS.comms, stored.comms),
    plans: Object.assign({}, DEFAULT_PLATFORM_SETTINGS.plans, stored.plans)
  };
}
function savePlatformSettings_(newSettings) {
  const sh = platformSettingsSheet_();
  const rows = readObjects_(sh);
  const row = rows.find(r => r.key === 'config');
  const value = JSON.stringify(newSettings);
  if (row) sh.getRange(row.__row, 2).setValue(value);
  else sh.appendRow(['config', value]);
}

/* Public, no-auth: safe subset only (no secret keys) — powers the org dashboard's
   Upgrade & Subscription bank details, plan dropdown, and the public pricing page. */
function getPublicPlatformInfo(body) {
  const s = getPlatformSettings_();
  return {
    success: true,
    companyEmail: s.companyEmail, companyPhone: s.companyPhone, companyWebsite: s.companyWebsite,
    logoUrl: s.logoUrl, primaryColor: s.primaryColor, accentColor: s.accentColor,
    manualPaymentMethods: s.manualPaymentMethods.filter(m => m.enabled),
    gatewaysEnabled: {
      paystack: !!(s.gateways.paystack && s.gateways.paystack.enabled),
      remita: !!(s.gateways.remita && s.gateways.remita.enabled),
      flutterwave: !!(s.gateways.flutterwave && s.gateways.flutterwave.enabled)
    },
    plans: s.plans
  };
}

function superAdminGetSettings(body) {
  requireSuperAdmin_(body.sessionToken);
  return { success: true, settings: getPlatformSettings_() };
}
function superAdminSaveSettings(body) {
  requireSuperAdmin_(body.sessionToken);
  if (!body.settings) return { success: false, error: 'No settings provided.' };
  const merged = Object.assign({}, getPlatformSettings_(), body.settings);
  savePlatformSettings_(merged);
  return { success: true, message: 'Settings saved.', settings: merged };
}

/* ============================================================
   SUPER ADMIN — ORGANIZATION MANAGEMENT
   ============================================================ */
/* Reads straight from the Registry (Master) — no tenant spreadsheets are opened just
   to list orgs. userCount is one lightweight getLastRow() per tenant (metadata only,
   not a full read), which is fine for an on-demand Super Admin listing. */
function superAdminListOrgs(body) {
  requireSuperAdmin_(body.sessionToken);
  const orgs = getAllRegistryRows_();
  return {
    success: true,
    orgs: orgs.map(o => ({
      orgId: o.orgId, orgName: o.orgName, fullName: o.adminFullName, username: '',
      email: o.adminEmail, phone: o.adminPhone, plan: o.plan, billingCycle: o.billingCycle,
      status: o.status, subscriptionStatus: o.subscriptionStatus,
      subscriptionStartDate: o.subscriptionStartDate, subscriptionExpiry: o.subscriptionExpiry,
      trialEndsAt: o.trialEndsAt, createdAt: o.createdAt,
      userCount: safeTenantUserCount_(o.orgId)
    }))
  };
}
function safeTenantUserCount_(orgId) {
  try {
    const sh = tenantUsersSheet_(orgId);
    return Math.max(0, sh.getLastRow() - 1);
  } catch (e) { return 0; }
}
/* Updates the Registry (authoritative) and, best-effort, mirrors onto the tenant's
   own Admin row so the org's dashboard displays the same details. */
function superAdminUpdateOrgContact(body) {
  requireSuperAdmin_(body.sessionToken);
  const reg = getRegistryRow_(body.orgId);
  if (!reg) return { success: false, error: 'Organization not found.' };
  const updates = {};
  if (typeof body.orgName === 'string' && body.orgName.trim()) updates.orgName = body.orgName.trim();
  if (typeof body.fullName === 'string' && body.fullName.trim()) updates.adminFullName = body.fullName.trim();
  if (typeof body.email === 'string' && body.email.trim()) updates.adminEmail = body.email.trim();
  if (typeof body.phone === 'string' && body.phone.trim()) updates.adminPhone = body.phone.trim();
  updateRegistryRow_(body.orgId, updates);
  try {
    const admin = readObjects_(tenantUsersSheet_(body.orgId)).find(u => u.orgId === body.orgId && (u.isAdmin === true || String(u.isAdmin).toUpperCase() === 'TRUE'));
    if (admin) {
      const mirror = {};
      if (updates.orgName) mirror.orgName = updates.orgName;
      if (updates.adminFullName) mirror.fullName = updates.adminFullName;
      if (updates.adminEmail) mirror.email = updates.adminEmail;
      if (updates.adminPhone) mirror.phone = updates.adminPhone;
      updateUserRow_(admin, mirror);
    }
  } catch (e) { console.error('Tenant mirror update failed', e); }
  return { success: true, message: 'Organization details updated.' };
}
function superAdminSetOrgStatus(body) {
  requireSuperAdmin_(body.sessionToken);
  const reg = getRegistryRow_(body.orgId);
  if (!reg) return { success: false, error: 'Organization not found.' };
  if (body.status !== 'Active' && body.status !== 'Suspended') return { success: false, error: 'Invalid status.' };
  updateRegistryRow_(body.orgId, { status: body.status });
  try {
    const users = readObjects_(tenantUsersSheet_(body.orgId));
    users.forEach(u => {
      const patch = { status: body.status };
      if (body.status === 'Suspended') { patch.sessionToken = ''; patch.sessionTokenExpiry = ''; } // updateUserRow_ clears SessionIndex too
      updateUserRow_(u, patch);
    });
  } catch (e) { console.error('Tenant status mirror failed', e); }
  return { success: true, message: 'Organization ' + (body.status === 'Suspended' ? 'suspended.' : 'reactivated.') };
}
function superAdminSetOrgPlan(body) {
  requireSuperAdmin_(body.sessionToken);
  const reg = getRegistryRow_(body.orgId);
  if (!reg) return { success: false, error: 'Organization not found.' };
  const updates = {};
  if (body.plan) updates.plan = body.plan;
  if (body.billingCycle) updates.billingCycle = body.billingCycle;
  if (body.subscriptionStatus) updates.subscriptionStatus = body.subscriptionStatus;
  if (body.subscriptionStartDate) updates.subscriptionStartDate = body.subscriptionStartDate;
  if (body.subscriptionExpiry) updates.subscriptionExpiry = body.subscriptionExpiry;
  if (body.trialEndsAt) updates.trialEndsAt = body.trialEndsAt;
  updateRegistryRow_(body.orgId, updates);
  try {
    const admin = readObjects_(tenantUsersSheet_(body.orgId)).find(u => u.orgId === body.orgId && (u.isAdmin === true || String(u.isAdmin).toUpperCase() === 'TRUE'));
    if (admin) updateUserRow_(admin, updates);
  } catch (e) { console.error('Tenant plan mirror failed', e); }
  return { success: true, message: 'Organization plan updated.' };
}

/* Super Admin broadcasts to org Admins — same channels/personalization as the
   org-level Announcements feature, just targeting Admin contacts across orgs. */
function superAdminSendMessage(body) {
  const sa = requireSuperAdmin_(body.sessionToken);
  const channel = String(body.channel || 'email');
  const subject = String(body.subject || 'Message from OKV Technology Consults');
  const sharedBody = String(body.sharedBody || '');
  const messageType = String(body.messageType || 'custom');
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  if (!recipients.length) return { success: false, error: 'No recipients selected.' };

  let sent = 0;
  const failed = [];
  recipients.forEach(r => {
    const text = r.body || sharedBody;
    try {
      if (channel === 'email') {
        if (!r.email) throw new Error('No email on file');
        MailApp.sendEmail({ to: r.email, subject: subject, htmlBody: text });
      } else if (channel === 'sms') {
        if (!r.phone) throw new Error('No phone on file');
        sendViaSms_(r.phone, stripHtml_(text));
      } else if (channel === 'whatsapp') {
        if (!r.phone) throw new Error('No phone on file');
        sendViaWhatsApp_(r.phone, stripHtml_(text));
      }
      sent++;
    } catch (err) {
      failed.push({ name: r.name || r.email || r.phone || 'Unknown', reason: String(err.message || err) });
    }
  });

  platformMessagesSheet_().appendRow([
    genId_('msg'), sa.userId, sa.fullName, recipients.length > 1 ? 'multiple' : 'individual',
    recipients.length > 1 ? (recipients.length + ' organizations') : (recipients[0].name || recipients[0].email || recipients[0].phone || ''),
    channel, messageType, subject, sharedBody, sent, nowIso_()
  ]);
  return { success: true, sent: sent, failed: failed };
}

/* ============================================================
   AUTOMATIC TRIAL / SUBSCRIPTION REMINDERS
   - Trial: reminded 2 days before it ends, and again the day it ends.
   - Active paid plans: a twice-a-month check-in (won't fire more than
     once per ~14 days per org even if the trigger runs daily), with
     extra urgency if their renewal is within 7 days.
   Run installReminderTrigger() once from the Apps Script editor —
   after that this runs automatically once a day with no further action needed.
   ============================================================ */
function installReminderTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'runSubscriptionReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runSubscriptionReminders').timeBased().everyDays(1).atHour(8).create();
  SpreadsheetApp.getUi().alert('Reminder trigger installed — runs daily at ~8am. Trial reminders fire near day 5 and day 7; active-plan reminders fire at most twice a month per organization.');
}
/* Reads straight from the Registry — this no longer opens a single tenant
   spreadsheet, since plan/subscription/trial state is authoritative there. */
function runSubscriptionReminders() {
  const s = getPlatformSettings_();
  const orgs = getAllRegistryRows_();
  const now = new Date();

  orgs.forEach(org => {
    try {
      if (String(org.status) !== 'Active') return; // suspended org — don't nag them

      if (String(org.subscriptionStatus) === 'trialing' && org.trialEndsAt) {
        const daysLeft = Math.ceil((new Date(org.trialEndsAt) - now) / 86400000);
        if (daysLeft === 2 || daysLeft === 0) {
          sendReminderEmail_(org, s, daysLeft <= 0 ? 'trial_ended' : 'trial_ending');
          updateRegistryRow_(org.orgId, { lastReminderSentAt: nowIso_() });
        }
      } else if (String(org.subscriptionStatus) === 'active') {
        const lastSent = org.lastReminderSentAt ? new Date(org.lastReminderSentAt) : null;
        const daysSinceLast = lastSent ? (now - lastSent) / 86400000 : 999;
        if (daysSinceLast >= 14) {
          const daysToExpiry = org.subscriptionExpiry ? Math.ceil((new Date(org.subscriptionExpiry) - now) / 86400000) : null;
          sendReminderEmail_(org, s, (daysToExpiry !== null && daysToExpiry <= 7) ? 'renewal_due' : 'checkin');
          updateRegistryRow_(org.orgId, { lastReminderSentAt: nowIso_() });
        }
      }
    } catch (err) {
      console.error('Reminder failed for org ' + org.orgId, err);
    }
  });
}
function sendReminderEmail_(org, s, kind) {
  const plans = s.plans || {};
  const nextPlan = (org.plan === 'Essential') ? 'Enterprise' : null;
  const nextPlanLine = nextPlan && plans[nextPlan]
    ? '<br><br>Since you\'re growing, you might also consider upgrading to <b>' + nextPlan + '</b> (₦' + Number(plans[nextPlan].monthly).toLocaleString('en-NG') + '/month) — ' + (plans[nextPlan].suitableFor || '') : '';
  let subject, body;
  if (kind === 'trial_ending') {
    subject = 'Your OKV Payroll & HR trial ends in 2 days';
    body = 'Hello ' + org.adminFullName + ',<br><br>Your free trial for <b>' + org.orgName + '</b> ends on ' + new Date(org.trialEndsAt).toDateString() + '. ' +
      'Upgrade anytime from your dashboard (Upgrade & Subscription) to keep full access with no interruption.' + nextPlanLine;
  } else if (kind === 'trial_ended') {
    subject = 'Your OKV Payroll & HR trial has ended';
    body = 'Hello ' + org.adminFullName + ',<br><br>Your free trial for <b>' + org.orgName + '</b> has ended. ' +
      'Upgrade now from your dashboard (Upgrade & Subscription) — pick a plan, transfer, upload your screenshot, and you\'ll be confirmed within the hour.' + nextPlanLine;
  } else if (kind === 'renewal_due') {
    subject = 'Your OKV Payroll & HR plan renews soon';
    body = 'Hello ' + org.adminFullName + ',<br><br>Your <b>' + org.plan + '</b> plan for <b>' + org.orgName + '</b> is due for renewal on ' +
      (org.subscriptionExpiry ? new Date(org.subscriptionExpiry).toDateString() : 'soon') + '. Renew from Upgrade & Subscription to avoid any interruption.' + nextPlanLine;
  } else {
    subject = 'Your OKV Payroll & HR account';
    body = 'Hello ' + org.adminFullName + ',<br><br>Just checking in — your <b>' + org.plan + '</b> plan for <b>' + org.orgName + '</b> is active and in good standing.' + nextPlanLine;
  }
  MailApp.sendEmail({
    to: org.adminEmail,
    subject: subject,
    htmlBody: body + '<br><br>— OKV Technology Consults<br>' + s.companyEmail + ' · ' + s.companyPhone + ' · ' + s.companyWebsite
  });
}


/* ---------------- merged from MasterRegistry.gs ---------------- */
/**
 * MASTER REGISTRY — multi-tenant architecture
 * ============================================================
 * The Apps Script project stays BOUND to one spreadsheet: that spreadsheet is now
 * the MASTER. It never stores payroll/HR transactional data. It holds only:
 *
 *   - Registry       one row per tenant/org: name, admin contact, spreadsheetId,
 *                     plan/billing, subscription & trial dates, capacity stats.
 *                     THIS IS THE SINGLE SOURCE OF TRUTH for plan/subscription
 *                     state — org-level gating (login, requireSession_) reads it
 *                     from here, not from the tenant's own Users sheet.
 *   - UserIndex       username/email -> orgId. Lets login() find which tenant
 *                     spreadsheet to open WITHOUT scanning every tenant.
 *   - SessionIndex    sessionToken -> orgId + userId + expiry. Lets every other
 *                     authenticated action resolve the right tenant spreadsheet
 *                     from a bare sessionToken, with no front-end changes needed.
 *   - SuperAdmins     the 1-2 platform Super Admin accounts (not tied to any org).
 *   - PlatformSettings, UpgradeRequests, CapacityLog — existing/new cross-tenant
 *     sheets that were already global in spirit (Super Admin config, upgrade
 *     approvals, capacity history snapshots).
 *
 * Each TENANT spreadsheet (created via createTenantSpreadsheet_) holds only that
 * org's own Users, Data, Messages, Chats sheets — exactly the four sheets that are
 * already filtered by orgId in Code.gs today.
 *
 * Everything here is additive. Run setupMasterRegistry() once, then
 * migrateToPerTenant() once (see Migration.gs) to move existing data across.
 */

/* Optional: set this to a Drive folder ID to keep all tenant spreadsheets
   organized in one place instead of scattered across "My Drive". Leave blank
   to create them at Drive root. */
const TENANT_FILES_FOLDER_ID = '';

const REGISTRY_HEADERS = [
  'orgId', 'orgName', 'spreadsheetId', 'adminUserId', 'adminFullName', 'adminEmail', 'adminPhone',
  'plan', 'billingCycle', 'status', 'subscriptionStatus', 'subscriptionStartDate', 'subscriptionExpiry',
  'trialEndsAt', 'createdAt', 'updatedAt', 'lastReminderSentAt',
  // capacity monitoring (written by CapacityMonitor.gs, read-only elsewhere)
  'cellsUsed', 'cellPercentUsed', 'rowsAddedRecent', 'estMonthsRemaining', 'capacityStatus',
  'lastCapacityCheck', 'capacityAlertSent'
];
const USER_INDEX_HEADERS = ['username', 'email', 'orgId'];
const SESSION_INDEX_HEADERS = ['sessionToken', 'orgId', 'userId', 'expiry'];
const RESET_INDEX_HEADERS = ['resetToken', 'orgId', 'userId', 'expiry'];
const SUPERADMINS_HEADERS = ['userId', 'fullName', 'username', 'email', 'passwordHash', 'status', 'sessionToken', 'sessionTokenExpiry', 'resetToken', 'resetTokenExpiry', 'createdAt', 'updatedAt'];
const TENANT_USER_HEADERS = ['orgId', 'orgName', 'userId', 'fullName', 'username', 'email', 'phone', 'passwordHash', 'isAdmin', 'roles', 'plan', 'billingCycle', 'status', 'subscriptionStatus', 'subscriptionStartDate', 'subscriptionExpiry', 'trialEndsAt', 'resetToken', 'resetTokenExpiry', 'sessionToken', 'sessionTokenExpiry', 'employeeId', 'createdAt', 'updatedAt', 'isSuperAdmin', 'lastReminderSentAt'];
const TENANT_DATA_HEADERS = ['orgId', 'entityType', 'recordId', 'jsonData', 'updatedAt', 'updatedBy'];
const TENANT_MESSAGE_HEADERS = ['orgId', 'messageId', 'fromUserId', 'fromName', 'toScope', 'toLabel', 'channel', 'messageType', 'subject', 'body', 'recipientCount', 'sentAt'];
const TENANT_CHAT_HEADERS = ['orgId', 'chatId', 'fromUserId', 'toUserId', 'body', 'sentAt', 'readAt'];
const CAPACITY_LOG_HEADERS = ['orgId', 'timestamp', 'cellsUsed'];

/* ============================================================
   ONE-TIME SETUP — run this once on the spreadsheet that will act as MASTER.
   Safe to re-run (won't duplicate sheets or overwrite existing rows).
   ============================================================ */
function setupMasterRegistry() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheetWithHeaders_(ss, 'Registry', REGISTRY_HEADERS);
  ensureSheetWithHeaders_(ss, 'UserIndex', USER_INDEX_HEADERS);
  ensureSheetWithHeaders_(ss, 'SessionIndex', SESSION_INDEX_HEADERS);
  ensureSheetWithHeaders_(ss, 'ResetIndex', RESET_INDEX_HEADERS);
  ensureSheetWithHeaders_(ss, 'SuperAdmins', SUPERADMINS_HEADERS);
  ensureSheetWithHeaders_(ss, 'CapacityLog', CAPACITY_LOG_HEADERS);
  // PlatformSettings / UpgradeRequests / Messages(platform broadcasts) already exist from setupSheets().
  SpreadsheetApp.getUi().alert(
    'Master registry ready: Registry, UserIndex, SessionIndex, SuperAdmins, CapacityLog sheets created.\n\n' +
    'Next: if you have existing data in this spreadsheet\'s old Users/Data/Messages/Chats tabs, run ' +
    'migrateToPerTenant() once from Migration.gs to move each organization into its own dedicated spreadsheet.\n\n' +
    'Then run installCapacityTrigger() to enable the daily capacity check.'
  );
}

function ensureSheetWithHeaders_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function registrySheet_() { return ensureSheetWithHeaders_(SpreadsheetApp.getActiveSpreadsheet(), 'Registry', REGISTRY_HEADERS); }
function userIndexSheet_() { return ensureSheetWithHeaders_(SpreadsheetApp.getActiveSpreadsheet(), 'UserIndex', USER_INDEX_HEADERS); }
function sessionIndexSheet_() { return ensureSheetWithHeaders_(SpreadsheetApp.getActiveSpreadsheet(), 'SessionIndex', SESSION_INDEX_HEADERS); }
function superAdminsSheet_() { return ensureSheetWithHeaders_(SpreadsheetApp.getActiveSpreadsheet(), 'SuperAdmins', SUPERADMINS_HEADERS); }
function resetIndexSheet_() { return ensureSheetWithHeaders_(SpreadsheetApp.getActiveSpreadsheet(), 'ResetIndex', RESET_INDEX_HEADERS); }

/* Password-reset tokens are looked up by token alone (the link a user clicks
   carries only the token) — this small index maps a reset token back to the
   org/user it belongs to, without scanning every tenant spreadsheet. */
function setResetIndex_(resetToken, orgId, userId, expiry) {
  const sheet = resetIndexSheet_();
  const rows = readObjects_(sheet).filter(r => r.userId === userId);
  rows.sort((a, b) => b.__row - a.__row).forEach(r => sheet.deleteRow(r.__row)); // one live reset token per user
  sheet.appendRow([resetToken, orgId, userId, expiry]);
}
function getResetIndex_(resetToken) {
  if (!resetToken) return null;
  return readObjects_(resetIndexSheet_()).find(r => r.resetToken === resetToken) || null;
}
function clearResetIndex_(userId) {
  const sheet = resetIndexSheet_();
  const rows = readObjects_(sheet).filter(r => r.userId === userId);
  rows.sort((a, b) => b.__row - a.__row).forEach(r => sheet.deleteRow(r.__row));
}
function capacityLogSheet_() { return ensureSheetWithHeaders_(SpreadsheetApp.getActiveSpreadsheet(), 'CapacityLog', CAPACITY_LOG_HEADERS); }

/* ============================================================
   REGISTRY READ/WRITE
   ============================================================ */
function getRegistryRow_(orgId) {
  return readObjects_(registrySheet_()).find(r => r.orgId === orgId) || null;
}
function getAllRegistryRows_() {
  return readObjects_(registrySheet_());
}
function updateRegistryRow_(orgId, patch) {
  const sheet = registrySheet_();
  const rows = readObjects_(sheet);
  const row = rows.find(r => r.orgId === orgId);
  if (!row) throw new Error('Registry row not found for orgId ' + orgId);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const merged = Object.assign({}, row, patch, { updatedAt: nowIso_() });
  const rowVals = headers.map(h => merged[h] !== undefined ? merged[h] : '');
  sheet.getRange(row.__row, 1, 1, headers.length).setValues([rowVals]);
  invalidateOrgCache_(orgId);
}
function appendRegistryRow_(fields) {
  const sheet = registrySheet_();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const rowVals = headers.map(h => fields[h] !== undefined ? fields[h] : '');
  sheet.appendRow(rowVals);
}

/* ============================================================
   USER INDEX  (username/email -> orgId, for login routing)
   ============================================================ */
/* Used for LOGIN routing — matches the username field only, so a login attempt is
   never routed to the wrong org because the typed string happens to equal a
   different account's email address (see findOrgIdByEmail_ below for that case). */
function findOrgIdByUsername_(username) {
  const needle = String(username || '').trim().toLowerCase();
  const row = readObjects_(userIndexSheet_()).find(r => String(r.username).toLowerCase() === needle);
  return row ? row.orgId : null;
}
/* Used for EMAIL-based flows (forgotPassword) — matches the email field only. */
function findOrgIdByEmail_(email) {
  const needle = String(email || '').trim().toLowerCase();
  const row = readObjects_(userIndexSheet_()).find(r => r.email && String(r.email).toLowerCase() === needle);
  return row ? row.orgId : null;
}
function isUsernameOrEmailTaken_(username, email) {
  const uname = String(username || '').trim().toLowerCase();
  const mail = String(email || '').trim().toLowerCase();
  return readObjects_(userIndexSheet_()).some(r =>
    (uname && String(r.username).toLowerCase() === uname) || (mail && r.email && String(r.email).toLowerCase() === mail));
}
function addUserIndexEntry_(username, email, orgId) {
  userIndexSheet_().appendRow([String(username || '').toLowerCase(), String(email || '').toLowerCase(), orgId]);
}
function removeUserIndexEntry_(username) {
  const uname = String(username || '').toLowerCase();
  const sheet = userIndexSheet_();
  const rows = readObjects_(sheet).filter(r => String(r.username).toLowerCase() === uname);
  rows.sort((a, b) => b.__row - a.__row).forEach(r => sheet.deleteRow(r.__row));
}

/* ============================================================
   SESSION INDEX  (sessionToken -> orgId/userId, so requireSession_ never has
   to scan every tenant spreadsheet to find who's calling)
   ============================================================ */
function setSessionIndex_(sessionToken, orgId, userId, expiry) {
  const sheet = sessionIndexSheet_();
  const rows = readObjects_(sheet);
  const existing = rows.find(r => r.userId === userId); // one live session tracked per user
  const vals = [sessionToken, orgId, userId, expiry];
  if (existing) sheet.getRange(existing.__row, 1, 1, vals.length).setValues([vals]);
  else sheet.appendRow(vals);
}
function getSessionIndex_(sessionToken) {
  if (!sessionToken) return null;
  return readObjects_(sessionIndexSheet_()).find(r => r.sessionToken === sessionToken) || null;
}
function clearSessionIndex_(userId) {
  const sheet = sessionIndexSheet_();
  const rows = readObjects_(sheet).filter(r => r.userId === userId);
  rows.sort((a, b) => b.__row - a.__row).forEach(r => sheet.deleteRow(r.__row));
}

/* ============================================================
   TENANT SPREADSHEET RESOLUTION  — the central helper requested:
   every backend function that needs a tenant's data calls getOrgSpreadsheet(orgId)
   instead of SpreadsheetApp.getActiveSpreadsheet().
   ============================================================ */
var _tenantSpreadsheetCache = {}; // in-memory, lives only for this single execution

function getOrgSpreadsheet(orgId) {
  if (!orgId) throw new Error('getOrgSpreadsheet_: missing orgId.');
  if (_tenantSpreadsheetCache[orgId]) return _tenantSpreadsheetCache[orgId];

  // Script-cache holds the spreadsheetId (cheap, 6hr TTL) to skip the Registry
  // sheet scan on repeat calls across executions; falls back to Registry lookup.
  const cache = CacheService.getScriptCache();
  let spreadsheetId = cache.get('ssid_' + orgId);
  if (!spreadsheetId) {
    const reg = getRegistryRow_(orgId);
    if (!reg || !reg.spreadsheetId) throw new Error('No spreadsheet is registered for this organization.');
    spreadsheetId = reg.spreadsheetId;
    cache.put('ssid_' + orgId, spreadsheetId, 21600); // 6 hours
  }
  const ss = SpreadsheetApp.openById(spreadsheetId);
  _tenantSpreadsheetCache[orgId] = ss;
  return ss;
}
function invalidateOrgCache_(orgId) {
  delete _tenantSpreadsheetCache[orgId];
  CacheService.getScriptCache().remove('ssid_' + orgId);
}

/* ============================================================
   TENANT SPREADSHEET CREATION — called at signup/onboarding.
   ============================================================ */
function createTenantSpreadsheet_(orgName, orgId) {
  const ss = SpreadsheetApp.create('OKV Payroll — ' + orgName + ' (' + orgId + ')');
  if (TENANT_FILES_FOLDER_ID) {
    try {
      const file = DriveApp.getFileById(ss.getId());
      const folder = DriveApp.getFolderById(TENANT_FILES_FOLDER_ID);
      folder.addFile(file);
      DriveApp.getRootFolder().removeFile(file);
    } catch (e) { /* folder move is best-effort; spreadsheet still works at Drive root */ }
  }

  const users = ss.getSheetByName('Sheet1');
  users.setName('Users');
  users.getRange(1, 1, 1, TENANT_USER_HEADERS.length).setValues([TENANT_USER_HEADERS]);
  users.setFrozenRows(1);

  const data = ss.insertSheet('Data');
  data.getRange(1, 1, 1, TENANT_DATA_HEADERS.length).setValues([TENANT_DATA_HEADERS]);
  data.setFrozenRows(1);

  const messages = ss.insertSheet('Messages');
  messages.getRange(1, 1, 1, TENANT_MESSAGE_HEADERS.length).setValues([TENANT_MESSAGE_HEADERS]);
  messages.setFrozenRows(1);

  const chats = ss.insertSheet('Chats');
  chats.getRange(1, 1, 1, TENANT_CHAT_HEADERS.length).setValues([TENANT_CHAT_HEADERS]);
  chats.setFrozenRows(1);

  return ss.getId();
}

function tenantUsersSheet_(orgId) { return getOrgSpreadsheet(orgId).getSheetByName('Users'); }
function tenantDataSheet_(orgId) { return getOrgSpreadsheet(orgId).getSheetByName('Data'); }
function tenantMessagesSheet_(orgId) { return getOrgSpreadsheet(orgId).getSheetByName('Messages'); }
function tenantChatsSheet_(orgId) { return getOrgSpreadsheet(orgId).getSheetByName('Chats'); }


/* ---------------- merged from CapacityMonitor.gs ---------------- */
/**
 * CELL-CAPACITY MONITORING
 * ============================================================
 * Google Sheets hard-caps a spreadsheet file at 10,000,000 cells total, summed
 * across every tab. Each tenant now has its own spreadsheet, so each tenant has
 * its own 10M budget. This file:
 *
 *   1. Computes real cell usage per tenant (used range only, not the full
 *      default 1000x26 grid every new sheet starts with).
 *   2. Logs a daily snapshot per org to CapacityLog (in the Master spreadsheet)
 *      so growth rate can be measured over 30/90 days.
 *   3. Projects time remaining until ~90% capacity from that growth rate.
 *   4. Writes results back to the Registry row for that org (percentage,
 *      estimated time remaining, status flag) — this is what the Super Admin
 *      dashboard reads. Nothing here runs on page load; it's all driven by the
 *      daily trigger below.
 *   5. Emails the Super Admin once when a tenant first crosses "Action Needed".
 * ============================================================
 */

const CELL_LIMIT = 10000000;
const CAPACITY_MONITOR_THRESHOLD = 0.70;  // -> "Monitor"
const CAPACITY_ACTION_THRESHOLD = 0.85;   // -> "Action Needed"
const CAPACITY_PROJECT_TO = 0.90;         // "time remaining until ~90% full"

/* Run this once from the Apps Script editor to enable the automatic daily check. */
function installCapacityTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'checkAllTenantsCapacity') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkAllTenantsCapacity').timeBased().everyDays(1).atHour(3).create();
  SpreadsheetApp.getUi().alert('Capacity trigger installed — checks every tenant spreadsheet daily at ~3am and updates the Registry + Super Admin dashboard.');
}

/* Sums the ACTUAL used range of every sheet/tab in a spreadsheet — i.e. the data
   that exists, not the full default grid a blank sheet starts with. */
function computeTenantCellUsage_(ss) {
  let cells = 0;
  let dataRows = 0;
  ss.getSheets().forEach(sh => {
    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (lastRow > 0 && lastCol > 0) cells += lastRow * lastCol;
    if (sh.getName() === 'Data') dataRows = Math.max(0, lastRow - 1); // header row excluded
  });
  return { cellsUsed: cells, dataRows: dataRows };
}

/* Growth rate from CapacityLog history: cells added per day, averaged over
   whichever of the last 30/90-day windows has data, then projected to a
   months-remaining estimate. Returns null growth if there's not enough history yet. */
function estimateGrowth_(orgId, cellsNow) {
  const now = new Date();
  const history = readObjects_(capacityLogSheet_()).filter(r => r.orgId === orgId);
  if (!history.length) return { rowsAddedRecent: 0, cellsPerDay: null };

  const in30 = history.filter(r => (now - new Date(r.timestamp)) / 86400000 <= 30);
  const in90 = history.filter(r => (now - new Date(r.timestamp)) / 86400000 <= 90);
  const window = in30.length >= 2 ? in30 : (in90.length >= 2 ? in90 : null);
  if (!window) return { rowsAddedRecent: 0, cellsPerDay: null };

  window.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const oldest = window[0];
  const spanDays = Math.max(1, (now - new Date(oldest.timestamp)) / 86400000);
  const cellsAdded = cellsNow - Number(oldest.cellsUsed || 0);
  const cellsPerDay = cellsAdded > 0 ? cellsAdded / spanDays : 0;
  return { rowsAddedRecent: Math.max(0, cellsAdded), cellsPerDay: cellsPerDay };
}

function capacityStatusFor_(percentUsed) {
  if (percentUsed >= CAPACITY_ACTION_THRESHOLD * 100) return 'Action Needed';
  if (percentUsed >= CAPACITY_MONITOR_THRESHOLD * 100) return 'Monitor';
  return 'Healthy';
}
function capacityGuidanceFor_(status) {
  if (status === 'Action Needed') return 'Archive older records (e.g. past payroll runs, leavers) into a separate archive spreadsheet, or split this tenant\'s data across an additional spreadsheet.';
  if (status === 'Monitor') return 'No action needed yet — keep an eye on growth. Consider planning an archive of older records within the next few months.';
  return 'No action needed.';
}

/* The daily job. Iterates every org in the Registry, opens its tenant spreadsheet,
   measures usage, logs a snapshot, and writes the summary back to the Registry. */
function checkAllTenantsCapacity() {
  const orgs = getAllRegistryRows_();
  const nowIso = nowIso_();
  orgs.forEach(org => {
    try {
      if (!org.spreadsheetId) return;
      const ss = getOrgSpreadsheet(org.orgId);
      const usage = computeTenantCellUsage_(ss);
      const percentUsed = (usage.cellsUsed / CELL_LIMIT) * 100;
      const growth = estimateGrowth_(org.orgId, usage.cellsUsed);

      let estMonthsRemaining = '';
      if (growth.cellsPerDay && growth.cellsPerDay > 0) {
        const cellsUntil90 = (CELL_LIMIT * CAPACITY_PROJECT_TO) - usage.cellsUsed;
        const daysRemaining = cellsUntil90 / growth.cellsPerDay;
        estMonthsRemaining = daysRemaining > 0 ? Math.round((daysRemaining / 30) * 10) / 10 : 0;
      }

      const status = capacityStatusFor_(percentUsed);
      const wasAlerted = String(org.capacityAlertSent).toUpperCase() === 'TRUE';

      updateRegistryRow_(org.orgId, {
        cellsUsed: usage.cellsUsed,
        cellPercentUsed: Math.round(percentUsed * 100) / 100,
        rowsAddedRecent: growth.rowsAddedRecent,
        estMonthsRemaining: estMonthsRemaining,
        capacityStatus: status,
        lastCapacityCheck: nowIso,
        capacityAlertSent: status === 'Action Needed' ? true : (status === 'Healthy' ? false : wasAlerted)
      });

      capacityLogSheet_().appendRow([org.orgId, nowIso, usage.cellsUsed]);

      if (status === 'Action Needed' && !wasAlerted) {
        sendCapacityAlertEmail_(org, percentUsed, estMonthsRemaining);
      }
    } catch (err) {
      console.error('Capacity check failed for org ' + org.orgId, err);
    }
  });

  pruneCapacityLog_();
}

/* Keep CapacityLog from growing forever — 90 days of daily snapshots per org is
   plenty for the growth-rate calculation above. */
function pruneCapacityLog_() {
  const sheet = capacityLogSheet_();
  const cutoff = new Date(Date.now() - 100 * 86400000);
  const rows = readObjects_(sheet).filter(r => new Date(r.timestamp) < cutoff);
  rows.sort((a, b) => b.__row - a.__row).forEach(r => sheet.deleteRow(r.__row));
}

function sendCapacityAlertEmail_(org, percentUsed, estMonthsRemaining) {
  const s = getPlatformSettings_();
  const etaText = (estMonthsRemaining === '' || estMonthsRemaining === null)
    ? 'not enough history yet to estimate'
    : (estMonthsRemaining <= 0 ? 'already at the 90% projection point' : (estMonthsRemaining + ' month(s) until ~90% full'));
  MailApp.sendEmail({
    to: s.companyEmail,
    subject: 'Capacity alert — ' + org.orgName + ' is at ' + Math.round(percentUsed) + '% of its Sheets cell limit',
    htmlBody:
      '<b>' + org.orgName + '</b> has crossed the "Action Needed" capacity threshold.<br><br>' +
      'Cells used: ' + Math.round(percentUsed) + '% of 10,000,000<br>' +
      'Estimated time remaining: ' + etaText + '<br><br>' +
      'Recommended: ' + capacityGuidanceFor_('Action Needed') + '<br><br>' +
      'See the Super Admin Dashboard → Storage &amp; Capacity for full details.'
  });
}

/* ============================================================
   SUPER ADMIN DASHBOARD ENDPOINT — read-only, reads the last daily check from
   the Registry. Never recomputes live (per spec: no on-page-load checks).
   ============================================================ */
function superAdminGetCapacityOverview(body) {
  requireSuperAdmin_(body.sessionToken);
  const orgs = getAllRegistryRows_();
  return {
    success: true,
    orgs: orgs.map(o => ({
      orgId: o.orgId,
      orgName: o.orgName,
      cellPercentUsed: o.cellPercentUsed === '' ? null : Number(o.cellPercentUsed),
      cellsUsed: o.cellsUsed === '' ? null : Number(o.cellsUsed),
      estMonthsRemaining: o.estMonthsRemaining === '' ? null : Number(o.estMonthsRemaining),
      capacityStatus: o.capacityStatus || 'Not yet checked',
      guidance: o.capacityStatus ? capacityGuidanceFor_(o.capacityStatus) : 'Capacity check has not run yet for this organization.',
      lastCapacityCheck: o.lastCapacityCheck || ''
    })).sort((a, b) => (b.cellPercentUsed || 0) - (a.cellPercentUsed || 0))
  };
}


/* ---------------- merged from Migration.gs ---------------- */
/**
 * ONE-TIME MIGRATION — old single-spreadsheet layout -> per-tenant spreadsheets
 * ============================================================
 * Run this ONCE, manually, from the Apps Script editor, on the spreadsheet that
 * currently holds your live Users/Data/Messages/Chats/UpgradeRequests tabs
 * (the original okv-payroll-online.gs layout). That spreadsheet becomes the
 * MASTER afterwards.
 *
 * What it does, for every distinct orgId currently in the old "Users" tab:
 *   1. Creates a brand-new tenant spreadsheet (createTenantSpreadsheet_).
 *   2. Copies that org's rows from the old Users/Data/Messages/Chats tabs into
 *      the new tenant spreadsheet's matching tabs.
 *   3. Adds one Registry row (org metadata + new spreadsheetId), pulling
 *      plan/subscription fields from the org's Admin user row.
 *   4. Adds a UserIndex entry for every user in that org, so login can route
 *      to the right tenant spreadsheet.
 *   5. Moves the Super Admin account(s) — rows with isSuperAdmin=TRUE and no
 *      orgId — into the new SuperAdmins sheet.
 *
 * It does NOT touch UpgradeRequests or PlatformSettings — those already live in
 * what is becoming the Master, and stay there (see MasterRegistry.gs header
 * comment for why).
 *
 * It does NOT delete anything from the old tabs. Once you've verified the new
 * tenant spreadsheets look right (open a couple, check row counts), run
 * cleanupOldTenantSheets() separately to clear the old Users/Data/Messages/Chats
 * tabs in the Master so it stops holding transactional data. That step is
 * deliberately manual/separate — never auto-run.
 *
 * Safe to re-run signup/login flows will simply not find a tenant if migration
 * hasn't been run — run this before deploying the tenant-aware Code.gs changes.
 * ============================================================
 */
function migrateToPerTenant() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const oldUsersSheet = ss.getSheetByName('Users');
  if (!oldUsersSheet) { SpreadsheetApp.getUi().alert('No old "Users" sheet found — nothing to migrate.'); return; }

  setupMasterRegistry(); // idempotent — ensures Registry/UserIndex/SessionIndex/SuperAdmins/CapacityLog exist first
  // setupMasterRegistry() shows its own alert; suppress a second one below by not calling ui.alert twice.

  const oldUsers = readObjects_(oldUsersSheet);
  const oldData = ss.getSheetByName('Data') ? readObjects_(ss.getSheetByName('Data')) : [];
  const oldMessages = ss.getSheetByName('Messages') ? readObjects_(ss.getSheetByName('Messages')) : [];
  const oldChats = ss.getSheetByName('Chats') ? readObjects_(ss.getSheetByName('Chats')) : [];

  // --- Super Admin accounts (no orgId) -> SuperAdmins sheet ---
  const superAdmins = oldUsers.filter(u => (u.isSuperAdmin === true || String(u.isSuperAdmin).toUpperCase() === 'TRUE'));
  const saSheet = superAdminsSheet_();
  const existingSaUsernames = readObjects_(saSheet).map(r => String(r.username).toLowerCase());
  superAdmins.forEach(sa => {
    if (existingSaUsernames.indexOf(String(sa.username).toLowerCase()) !== -1) return; // already migrated
    saSheet.appendRow([
      sa.userId, sa.fullName, sa.username, sa.email, sa.passwordHash, sa.status || 'Active',
      sa.sessionToken || '', sa.sessionTokenExpiry || '', sa.resetToken || '', sa.resetTokenExpiry || '',
      sa.createdAt || nowIso_(), nowIso_()
    ]);
  });

  // --- Org tenants ---
  const orgIds = [...new Set(oldUsers.map(u => u.orgId).filter(Boolean))];
  const existingOrgIds = getAllRegistryRows_().map(r => r.orgId);
  let migrated = 0, skipped = 0;

  orgIds.forEach(orgId => {
    if (existingOrgIds.indexOf(orgId) !== -1) { skipped++; return; } // already migrated

    const orgUsers = oldUsers.filter(u => u.orgId === orgId);
    const admin = orgUsers.find(u => u.isAdmin === true || String(u.isAdmin).toUpperCase() === 'TRUE') || orgUsers[0];
    const orgName = admin.orgName || 'Org ' + orgId;

    const spreadsheetId = createTenantSpreadsheet_(orgName, orgId);
    const tenantSs = SpreadsheetApp.openById(spreadsheetId);

    writeRows_(tenantSs.getSheetByName('Users'), TENANT_USER_HEADERS, orgUsers);
    writeRows_(tenantSs.getSheetByName('Data'), TENANT_DATA_HEADERS, oldData.filter(r => r.orgId === orgId));
    writeRows_(tenantSs.getSheetByName('Messages'), TENANT_MESSAGE_HEADERS, oldMessages.filter(r => r.orgId === orgId));
    writeRows_(tenantSs.getSheetByName('Chats'), TENANT_CHAT_HEADERS, oldChats.filter(r => r.orgId === orgId));

    appendRegistryRow_({
      orgId: orgId, orgName: orgName, spreadsheetId: spreadsheetId,
      adminUserId: admin.userId, adminFullName: admin.fullName, adminEmail: admin.email, adminPhone: admin.phone || '',
      plan: admin.plan || '', billingCycle: admin.billingCycle || '', status: admin.status || 'Active',
      subscriptionStatus: admin.subscriptionStatus || 'trialing',
      subscriptionStartDate: admin.subscriptionStartDate || '', subscriptionExpiry: admin.subscriptionExpiry || '',
      trialEndsAt: admin.trialEndsAt || '', createdAt: admin.createdAt || nowIso_(), updatedAt: nowIso_(),
      lastReminderSentAt: admin.lastReminderSentAt || '',
      cellsUsed: '', cellPercentUsed: '', rowsAddedRecent: '', estMonthsRemaining: '',
      capacityStatus: '', lastCapacityCheck: '', capacityAlertSent: false
    });

    orgUsers.forEach(u => {
      if (!isUsernameOrEmailTaken_(u.username, u.email)) addUserIndexEntry_(u.username, u.email, orgId);
      if (u.sessionToken) setSessionIndex_(u.sessionToken, orgId, u.userId, u.sessionTokenExpiry || '');
    });

    migrated++;
  });

  SpreadsheetApp.getUi().alert(
    'Migration complete.\n\nOrganizations migrated: ' + migrated + '\nAlready migrated (skipped): ' + skipped +
    '\n\nOpen a couple of the new tenant spreadsheets to spot-check the data, then:\n' +
    '1. Run cleanupOldTenantSheets() to clear the old Users/Data/Messages/Chats tabs here in the Master.\n' +
    '2. Run installCapacityTrigger() to start daily capacity checks.\n' +
    '3. Deploy the updated Code.gs (tenant-aware version) as a new deployment version.'
  );
}

function writeRows_(sheet, headers, objects) {
  if (!objects.length) return;
  const rows = objects.map(o => headers.map(h => o[h] !== undefined ? o[h] : ''));
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

/* Run this manually, AFTER verifying the migration above, to stop the Master
   spreadsheet from holding transactional data. Not run automatically — this is
   destructive to the old copies (the data now lives in each tenant spreadsheet). */
function cleanupOldTenantSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const resp = ui.alert('Clear old Users/Data/Messages/Chats tabs?',
    'This clears (not deletes) the old Users, Data, Messages, and Chats tabs in THIS spreadsheet, now that their data has been copied into per-tenant spreadsheets. This cannot be undone. Continue?',
    ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;

  ['Users', 'Data', 'Messages', 'Chats'].forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const lastRow = sh.getLastRow();
    if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).clearContent();
  });
  ui.alert('Old tabs cleared. The Master spreadsheet now holds only Registry, UserIndex, SessionIndex, SuperAdmins, CapacityLog, PlatformSettings, and UpgradeRequests.');
}


/* ============================================================================
   checkSetup — run once after pasting, and any time something looks wrong.
   Reports missing Master tabs, the Super Admin login and installed triggers.
   ============================================================================ */
function checkSetup() {
  const problems = [];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) { problems.push('This script is not attached to a Google Sheet. Open the Sheet → Extensions → Apps Script.'); }
  else {
    ['Registry','UserIndex','SessionIndex','ResetIndex','SuperAdmins','CapacityLog','PlatformSettings','UpgradeRequests'].forEach(name => {
      if (!ss.getSheetByName(name)) problems.push('Missing tab "' + name + '" — run setupSheets and setupMasterRegistry.');
    });
    try {
      const sa = readObjects_(superAdminsSheet_()).find(u => String(u.username).toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase());
      if (!sa) problems.push('No Super Admin login yet — run setupSuperAdmin.');
    } catch (e) { problems.push('Could not read SuperAdmins tab: ' + e.message); }
  }
  const triggerNames = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
  ['onUpgradeSheetEdit','runSubscriptionReminders','checkAllTenantsCapacity'].forEach(fn => {
    if (triggerNames.indexOf(fn) === -1) problems.push('Trigger not installed for ' + fn + ' — run its install function (see README).');
  });
  const msg = problems.length
    ? 'Setup check found ' + problems.length + ' item(s):\n\n- ' + problems.join('\n- ')
    : 'Setup check passed. Master tabs, Super Admin login and triggers are all in place.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return problems;
}
