/**
 * sendContactMessage — Firebase Callable Function
 * -------------------------------------------------
 * Sends the app's contact-form submission by email from the server side,
 * instead of the client POSTing straight to a third-party form-relay
 * service (FormSubmit.co). Called from index.html via:
 *
 *   firebase.functions().httpsCallable("sendContactMessage")({ name, email, category, message })
 *
 * The client (see sendContactViaFirebase() in index.html) only calls this
 * when Firebase is configured for the deployment (CLOUD_SYNC_ENABLED). If
 * it isn't configured, or this call throws / returns ok:false, the client
 * automatically falls back to the existing FormSubmit.co path — so this
 * function is additive, not a hard requirement for the contact form to work.
 *
 * Why put this on the server at all, if FormSubmit.co already works?
 *   - No dependency on a third party being reachable/configured correctly
 *     from the browser (ad-blockers, corporate proxies, etc. sometimes
 *     block third-party form-relay domains).
 *   - Avoids FormSubmit.co's first-use "activation email" gotcha, since we
 *     send with our own mail transport instead of asking FormSubmit to
 *     relay to a brand-new address.
 *   - Basic per-IP / per-app-check rate limiting can happen here, out of
 *     the client's reach.
 *   - Every submission is also written to Firestore (collection
 *     "contactInquiries") as a durable log, independent of the local
 *     per-device history the client already keeps in window.storage.
 *
 * ---------------------------------------------------------------------
 * SETUP (do this before deploying):
 *
 * 1. Install dependencies in your functions/ directory:
 *      npm install firebase-functions firebase-admin nodemailer
 *
 * 2. Choose a mail transport and set its credentials as function config /
 *    environment variables — do NOT hardcode credentials here. Two common
 *    options:
 *
 *    a) Gmail with an App Password (simplest for low volume):
 *         firebase functions:config:set mail.user="you@gmail.com" mail.pass="xxxxxxxxxxxxxxxx"
 *       (App Password, not your normal Gmail password — requires 2-Step
 *       Verification enabled on the Google account.)
 *
 *    b) A transactional email API (SendGrid, Resend, Mailgun, etc.) —
 *       swap the nodemailer transport below for the provider's SDK/API,
 *       following the same input/output shape.
 *
 * 3. Deploy:
 *      firebase deploy --only functions:sendContactMessage
 *
 * 4. Make sure this function's region matches what the client requests —
 *    index.html initializes functions with region "asia-northeast1"
 *    (see initFirebaseIfEnabled() / firebase.functions(app, "asia-northeast1")).
 *    Keep the region below in sync with that, or change both together.
 * ---------------------------------------------------------------------
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

if (!admin.apps.length) {
  admin.initializeApp();
}

const REGION = "asia-northeast1"; // keep in sync with the client's firebase.functions(app, ...) call
const SUPPORT_NOTIFY_EMAIL = "subox.studio@gmail.com";

// Very small in-memory rate limiter (per Cloud Functions instance — good
// enough to blunt a runaway client loop or basic abuse; for real spam
// protection, consider App Check + a Firestore/Redis-backed limiter).
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_PER_WINDOW = 5;
const recentSubmissionsByIp = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (recentSubmissionsByIp.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  timestamps.push(now);
  recentSubmissionsByIp.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX_PER_WINDOW;
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildTransport() {
  const config = functions.config();
  const user = config.mail && config.mail.user;
  const pass = config.mail && config.mail.pass;
  if (!user || !pass) {
    throw new Error(
      "mail.user / mail.pass function config is not set. " +
        'Run: firebase functions:config:set mail.user="..." mail.pass="..."'
    );
  }
  // Swap this out for another provider's transport/SDK if you're not using
  // Gmail — everything below this point only needs a working `transporter`.
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

exports.sendContactMessage = functions
  .region(REGION)
  .https.onCall(async (data, context) => {
    const name = typeof data.name === "string" ? data.name.trim().slice(0, 200) : "";
    const email = typeof data.email === "string" ? data.email.trim().slice(0, 320) : "";
    const category = typeof data.category === "string" ? data.category.trim().slice(0, 100) : "その他";
    const message = typeof data.message === "string" ? data.message.trim().slice(0, 5000) : "";

    if (!isValidEmail(email)) {
      throw new functions.https.HttpsError("invalid-argument", "正しいメールアドレスを入力してください");
    }
    if (!message) {
      throw new functions.https.HttpsError("invalid-argument", "お問い合わせ内容を入力してください");
    }

    const ip = (context.rawRequest && context.rawRequest.ip) || "unknown";
    if (isRateLimited(ip)) {
      throw new functions.https.HttpsError(
        "resource-exhausted",
        "送信回数が多すぎます。しばらく時間をおいて再度お試しください。"
      );
    }

    // Durable server-side log, independent of the client's local history.
    try {
      await admin.firestore().collection("contactInquiries").add({
        name,
        email,
        category,
        message,
        uid: (context.auth && context.auth.uid) || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      // Logging failure shouldn't block the actual email from going out.
      console.error("Failed to write contactInquiries log", e);
    }

    try {
      const transporter = buildTransport();
      await transporter.sendMail({
        from: SUPPORT_NOTIFY_EMAIL,
        to: SUPPORT_NOTIFY_EMAIL,
        replyTo: email,
        subject: `【Subox】お問い合わせ: ${category}`,
        text:
          `氏名: ${name || "(未入力)"}\n` +
          `メール: ${email}\n` +
          `種別: ${category}\n\n` +
          `${message}`,
        html:
          `<table cellpadding="6" style="border-collapse:collapse;">` +
          `<tr><td><b>氏名</b></td><td>${escapeHtml(name || "(未入力)")}</td></tr>` +
          `<tr><td><b>メール</b></td><td>${escapeHtml(email)}</td></tr>` +
          `<tr><td><b>種別</b></td><td>${escapeHtml(category)}</td></tr>` +
          `<tr><td><b>内容</b></td><td>${escapeHtml(message).replace(/\n/g, "<br>")}</td></tr>` +
          `</table>`,
      });
    } catch (e) {
      console.error("Failed to send contact email", e);
      throw new functions.https.HttpsError("internal", "メールの送信に失敗しました");
    }

    return { ok: true };
  });
