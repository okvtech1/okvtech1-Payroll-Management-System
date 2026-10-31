/* OKV Nigeria Payroll & HR — shared front-end auth/API helper.
   Include this on every page that talks to the backend. */

// API_URL is set ONCE in app/config.js (window.OKV_CONFIG). Do not hard-code it here.
const API_URL = (window.OKV_CONFIG && window.OKV_CONFIG.API_URL) || '';

const SESSION_KEY = 'okv_session_v1';
const SUPERADMIN_SESSION_KEY = 'okv_superadmin_session_v1';

/* Shows an impossible-to-miss banner at the very top of the page, the instant it loads, if
   API_URL is still the placeholder — instead of waiting for someone to click a button and hit
   a confusing "Failed to fetch". Safe to call on every page; does nothing once API_URL is set. */
(function warnIfApiUrlUnconfigured(){
  if(API_URL && API_URL.indexOf('YOUR_DEPLOYMENT_ID') === -1) return;
  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div');
    bar.textContent = '⚠ Setup incomplete: API_URL in app/config.js is still the placeholder. Buttons on this page (login, sign up, save, etc.) will not work until it\'s replaced with your real Apps Script Web App URL.';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#B4231F;color:#fff;'
      + 'font:600 13px/1.5 system-ui,sans-serif;text-align:center;padding:10px 16px;';
    document.body.prepend(bar);
  });
})();

async function sha256Hex(text){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function apiCall(action, payload){
  if(!API_URL || API_URL.indexOf('YOUR_DEPLOYMENT_ID') !== -1){
    throw new Error('Setup incomplete: open app/config.js and replace API_URL with your deployed Apps Script Web App URL. See README.md → Deployment.');
  }
  let res;
  try{
    res = await fetch(API_URL, {
      method: 'POST',
      // text/plain avoids a CORS preflight against the Apps Script endpoint
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({action}, payload || {}))
    });
  }catch(networkErr){
    throw new Error('Could not reach the server. Check your internet connection, or that API_URL in app/config.js points to a live Apps Script deployment (set in app/config.js).');
  }
  if(!res.ok) throw new Error('Network error (' + res.status + ')');
  const data = await res.json();
  if(!data.success) throw new Error(data.error || 'Request failed.');
  return data;
}

function saveSession(user, sessionToken){
  localStorage.setItem(SESSION_KEY, JSON.stringify({user, sessionToken, savedAt: new Date().toISOString()}));
}
function getSession(){
  try{
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}
function clearSession(){
  localStorage.removeItem(SESSION_KEY);
}
function saveSuperAdminSession(user, sessionToken){
  localStorage.setItem(SUPERADMIN_SESSION_KEY, JSON.stringify({user, sessionToken, savedAt: new Date().toISOString()}));
}
function getSuperAdminSession(){
  try{
    const raw = localStorage.getItem(SUPERADMIN_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}
function clearSuperAdminSession(){
  localStorage.removeItem(SUPERADMIN_SESSION_KEY);
}
function isOnline(){ return navigator.onLine; }

/* Toggles a password <input> between hidden/visible text and swaps the eye icon.
   Usage: wrap the input in <div class="pw-field">...<input type="password">
   <button type="button" class="pw-toggle" onclick="togglePasswordField(this)" tabindex="-1"
   aria-label="Show password"><i class="bi bi-eye"></i></button></div> */
function togglePasswordField(btn){
  const wrap = btn.closest('.pw-field');
  const input = wrap && wrap.querySelector('input');
  if(!input) return;
  const icon = btn.querySelector('i');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  if(icon){ icon.classList.toggle('bi-eye', showing); icon.classList.toggle('bi-eye-slash', !showing); }
  btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
}
/* Clears a password field's value AND resets its visibility toggle back to hidden —
   use this (instead of setting .value directly) for any password input inside a
   modal/form that gets reused across multiple opens, so a previously revealed
   password doesn't stay "shown" (with a mismatched icon) the next time it opens. */
function resetPasswordField(id){
  const input = document.getElementById(id);
  if(!input) return;
  input.value = '';
  input.type = 'password';
  const wrap = input.closest('.pw-field');
  const btn = wrap && wrap.querySelector('.pw-toggle');
  const icon = btn && btn.querySelector('i');
  if(icon){ icon.classList.add('bi-eye'); icon.classList.remove('bi-eye-slash'); }
  if(btn) btn.setAttribute('aria-label', 'Show password');
}

/* Applies the Super Admin's saved brand colors/logo (if any have been configured)
   by overriding the --navy/--gold CSS custom properties used throughout the product,
   and swapping any element with class "brand-logo-mark" for an <img> if a logo URL
   is set. Safe no-op if offline or nothing has been customized yet. */
async function applyBranding(){
  try{
    const res = await apiCall('getPublicPlatformInfo', {});
    if(res.primaryColor) document.documentElement.style.setProperty('--navy', res.primaryColor);
    if(res.accentColor) document.documentElement.style.setProperty('--gold', res.accentColor);
    if(res.logoUrl){
      document.querySelectorAll('.brand-logo-mark').forEach(el => {
        el.innerHTML = '';
        el.style.background = 'transparent';
        const img = document.createElement('img');
        img.src = res.logoUrl;
        img.alt = 'Logo';
        img.style.cssText = 'width:100%; height:100%; object-fit:contain;';
        el.appendChild(img);
      });
    }
    return res;
  }catch(err){ return null; } // offline or not configured yet — keep default branding
}
