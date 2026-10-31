/* ==========================================================================
   OKV Nigeria Payroll & HR — SINGLE CONFIGURATION FILE
   --------------------------------------------------------------------------
   This is the ONLY place you set the Apps Script Web App URL.
   Every page (marketing site and the app) reads it from here.

   1. Deploy Code.gs as a Web App (Deploy → New deployment → Web app,
      Execute as: Me, Who has access: Anyone).
   2. Copy the URL that ends in /exec and paste it below, replacing
      YOUR_DEPLOYMENT_ID.
   3. Upload the whole folder to your static host. No other file needs editing.
   ========================================================================== */
window.OKV_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec'
};
