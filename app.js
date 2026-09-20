require("dotenv").config();

const express = require("express");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oidc");
const helmet = require("helmet");

const app = express();

const PORT = Number(process.env.PORT || 3069);
const IS_PRODUCTION =
    process.env.NODE_ENV === "production";

const requiredEnv = [
    "SESSION_SECRET",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_CALLBACK_URL",
    "ALLOWED_EMAILS",
    "WC_STORE_URL",
    "WC_CONSUMER_KEY",
    "WC_CONSUMER_SECRET",
];

for (const name of requiredEnv) {
    if (!process.env[name]) {
        console.error(
            `Missing required environment variable: ${name}`
        );

        process.exit(1);
    }
}

// ---------------------------------------------------------
// Configuration
// ---------------------------------------------------------

const ALLOWED_EMAILS = new Set(
    process.env.ALLOWED_EMAILS
        .split(",")
        .map(email =>
            email.trim().toLowerCase()
        )
        .filter(Boolean)
);

const WC_STORE_URL =
    process.env.WC_STORE_URL.replace(
        /\/$/,
        ""
    );

const WC_CONSUMER_KEY =
    process.env.WC_CONSUMER_KEY;

const WC_CONSUMER_SECRET =
    process.env.WC_CONSUMER_SECRET;

const WC_QUERY_STRING_AUTH =
    process.env.WC_QUERY_STRING_AUTH ===
    "true";

const PER_PAGE = 100;

// ---------------------------------------------------------
// Concurrent WooCommerce requests
// ---------------------------------------------------------

const MAX_EXPORT_CONCURRENCY = 69;

const requestedConcurrency =
    Number.parseInt(
        process.env
            .WC_EXPORT_CONCURRENCY ||
        "8",
        10
    );

const EXPORT_CONCURRENCY =
    Number.isFinite(
        requestedConcurrency
    )
        ? Math.min(
            Math.max(
                requestedConcurrency,
                1
            ),
            MAX_EXPORT_CONCURRENCY
        )
        : 8;

// ---------------------------------------------------------
// Export progress
// ---------------------------------------------------------

// Progress is stored per session.
//
// This is perfect for a small internal exporter.
//
// If this app is eventually deployed with multiple Node
// instances/containers, move this to something shared
// such as Redis.
const exportProgress =
    new Map();

function setExportProgress(
    sessionId,
    progress
) {
    if (!sessionId) {
        return;
    }

    exportProgress.set(
        sessionId,
        progress
    );
}

function scheduleProgressCleanup(
    sessionId
) {
    if (!sessionId) {
        return;
    }

    const timer = setTimeout(
        () => {
            exportProgress.delete(
                sessionId
            );
        },
        15 * 60 * 1000
    );

    // Don't keep Node alive just because
    // this cleanup timer exists.
    if (typeof timer.unref === "function") {
        timer.unref();
    }
}

if (IS_PRODUCTION) {
    app.set(
        "trust proxy",
        1
    );
}

// ---------------------------------------------------------
// Security / middleware
// ---------------------------------------------------------

app.use(
    helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: [
                    "'self'",
                ],

                scriptSrc: [
                    "'self'",
                ],

                styleSrc: [
                    "'self'",
                    "'unsafe-inline'",
                ],

                mediaSrc: [
                    "'self'",
                ],
            },
        },
    })
);

app.use(
    express.static("public")
);

app.use(
    session({
        name:
            "woocommerce_export_session",

        secret:
            process.env
                .SESSION_SECRET,

        resave: false,

        saveUninitialized:
            false,

        cookie: {
            httpOnly: true,

            secure:
                IS_PRODUCTION,

            sameSite:
                "lax",

            maxAge:
                8 *
                60 *
                60 *
                1000,
        },
    })
);

app.use(
    passport.initialize()
);

app.use(
    passport.session()
);

// ---------------------------------------------------------
// Passport / Google authentication
// ---------------------------------------------------------

passport.use(
    new GoogleStrategy(
        {
            clientID:
                process.env
                    .GOOGLE_CLIENT_ID,

            clientSecret:
                process.env
                    .GOOGLE_CLIENT_SECRET,

            callbackURL:
                process.env
                    .GOOGLE_CALLBACK_URL,

            scope: [
                "profile",
                "email",
            ],
        },

        function verify(
            issuer,
            profile,
            done
        ) {
            try {
                const email =
                    profile.emails?.[0]
                        ?.value
                        ?.trim()
                        .toLowerCase();

                if (!email) {
                    console.warn(
                        "Google account returned no email."
                    );

                    return done(
                        null,
                        false
                    );
                }

                if (
                    !ALLOWED_EMAILS.has(
                        email
                    )
                ) {
                    console.warn(
                        `Rejected Google login from non-whitelisted email: ${email}`
                    );

                    return done(
                        null,
                        false
                    );
                }

                return done(
                    null,
                    {
                        id:
                            profile.id,

                        email,

                        displayName:
                            profile.displayName ||
                            email,
                    }
                );
            } catch (error) {
                return done(error);
            }
        }
    )
);

passport.serializeUser(
    (user, done) => {
        done(
            null,
            user
        );
    }
);

passport.deserializeUser(
    (user, done) => {
        done(
            null,
            user
        );
    }
);

// ---------------------------------------------------------
// Authentication middleware
// ---------------------------------------------------------

function requireLogin(
    req,
    res,
    next
) {
    if (
        !req.isAuthenticated()
    ) {
        return res.redirect("/");
    }

    const email =
        req.user?.email?.toLowerCase();

    if (
        !email ||
        !ALLOWED_EMAILS.has(
            email
        )
    ) {
        return res
            .status(403)
            .send(
                "Access denied."
            );
    }

    next();
}

// Used by fetch() routes so we don't redirect to HTML.
function requireApiLogin(
    req,
    res,
    next
) {
    if (
        !req.isAuthenticated()
    ) {
        return res
            .status(401)
            .json({
                error:
                    "Not authenticated",
            });
    }

    const email =
        req.user?.email?.toLowerCase();

    if (
        !email ||
        !ALLOWED_EMAILS.has(
            email
        )
    ) {
        return res
            .status(403)
            .json({
                error:
                    "Access denied",
            });
    }

    next();
}

// ---------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------

function csvEscape(value) {
    if (
        value === null ||
        value === undefined
    ) {
        return "";
    }

    const str =
        String(value);

    if (
        str.includes(",") ||
        str.includes('"') ||
        str.includes("\n") ||
        str.includes("\r")
    ) {
        return `"${str.replace(
            /"/g,
            '""'
        )}"`;
    }

    return str;
}

function orderToRow(order) {
    const items =
        (
            order.line_items ||
            []
        )
            .map(
                item =>
                    `${item.name} x${item.quantity}`
            )
            .join(" | ");

    const itemCount =
        (
            order.line_items ||
            []
        ).reduce(
            (
                total,
                item
            ) =>
                total +
                Number(
                    item.quantity ||
                    0
                ),

            0
        );

    const coupons =
        (
            order.coupon_lines ||
            []
        )
            .map(
                coupon =>
                    coupon.code
            )
            .join(" | ");

    return [
        order.id,
        order.number,
        order.date_created,
        order.status,
        order.currency,

        order.total,
        order.discount_total,
        order.shipping_total,
        order.total_tax,

        order.payment_method,
        order.payment_method_title,

        order.customer_id,

        order.billing
            ?.first_name,

        order.billing
            ?.last_name,

        order.billing
            ?.email,

        order.billing
            ?.phone,

        order.billing
            ?.country,

        itemCount,
        items,
        coupons,
    ];
}

const CSV_HEADERS = [
    "order_id",
    "order_number",
    "date_created",
    "status",
    "currency",

    "total",
    "discount_total",
    "shipping_total",
    "total_tax",

    "payment_method",
    "payment_method_title",

    "customer_id",

    "billing_first_name",
    "billing_last_name",
    "billing_email",
    "billing_phone",
    "billing_country",

    "item_count",
    "items",
    "coupons",
];

// ---------------------------------------------------------
// WooCommerce
// ---------------------------------------------------------

async function fetchOrdersPage(
    page,
    after,
    before
) {
    const params =
        new URLSearchParams({
            after:
                after.toISOString(),

            before:
                before.toISOString(),

            dates_are_gmt:
                "true",

            status:
                "any",

            page:
                String(page),

            per_page:
                String(PER_PAGE),

            orderby:
                "date",

            order:
                "asc",
        });

    const headers = {};

    if (
        WC_QUERY_STRING_AUTH
    ) {
        params.set(
            "consumer_key",
            WC_CONSUMER_KEY
        );

        params.set(
            "consumer_secret",
            WC_CONSUMER_SECRET
        );
    } else {
        const credentials =
            Buffer.from(
                `${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`
            ).toString(
                "base64"
            );

        headers.Authorization =
            `Basic ${credentials}`;
    }

    const url =
        `${WC_STORE_URL}` +
        `/wp-json/wc/v3/orders?` +
        params.toString();

    const response =
        await fetch(
            url,
            {
                headers,
            }
        );

    if (!response.ok) {
        const body =
            await response.text();

        throw new Error(
            `WooCommerce API error: ` +
            `${response.status} ` +
            `${response.statusText}\n` +
            body
        );
    }

    const orders =
        await response.json();

    return {
        orders,

        totalOrders:
            Number(
                response.headers.get(
                    "x-wp-total"
                ) ||
                orders.length
            ),

        totalPages:
            Number(
                response.headers.get(
                    "x-wp-totalpages"
                ) ||
                1
            ),
    };
}

// ---------------------------------------------------------
// Generate CSV concurrently
// ---------------------------------------------------------

async function generateOrdersCsv(
    onProgress = () => { }
) {
    const before =
        new Date();

    const after =
        new Date(before);

    after.setUTCMonth(
        after.getUTCMonth() -
        24
    );

    console.log("");
    console.log(
        "Starting WooCommerce export"
    );

    console.log(
        `From: ${after.toISOString()}`
    );

    console.log(
        `To:   ${before.toISOString()}`
    );

    console.log(
        `Concurrency: ${EXPORT_CONCURRENCY}`
    );

    // -----------------------------------------------------
    // Fetch page 1 first.
    //
    // WooCommerce returns the total order count and total
    // page count in response headers.
    // -----------------------------------------------------

    const firstPage =
        await fetchOrdersPage(
            1,
            after,
            before
        );

    const totalPages =
        Math.max(
            firstPage.totalPages,
            1
        );

    console.log(
        `Orders: ${firstPage.totalOrders}`
    );

    console.log(
        `Pages: ${totalPages}`
    );

    // Store results by page index.
    //
    // Requests may finish out of order, but our final CSV
    // should remain in WooCommerce's original order.
    const pageResults =
        new Array(
            totalPages
        );

    pageResults[0] =
        firstPage.orders;

    let completedPages = 1;
    let nextPage = 2;

    function reportProgress() {
        const percent =
            Math.round(
                (
                    completedPages /
                    totalPages
                ) *
                100
            );

        onProgress({
            completedPages,
            totalPages,

            totalOrders:
                firstPage.totalOrders,

            percent,
        });
    }

    reportProgress();

    console.log(
        `Fetched page 1/${totalPages}`
    );

    // -----------------------------------------------------
    // Worker
    // -----------------------------------------------------

    async function worker() {
        while (true) {
            // nextPage++ happens synchronously before await,
            // so each worker receives a unique page.
            const page =
                nextPage++;

            if (
                page >
                totalPages
            ) {
                return;
            }

            const result =
                await fetchOrdersPage(
                    page,
                    after,
                    before
                );

            pageResults[
                page - 1
            ] =
                result.orders;

            completedPages++;

            console.log(
                `Fetched page ${page}/${totalPages}`
            );

            reportProgress();
        }
    }

    const remainingPages =
        totalPages - 1;

    const workerCount =
        Math.min(
            EXPORT_CONCURRENCY,
            remainingPages
        );

    if (
        workerCount > 0
    ) {
        await Promise.all(
            Array.from(
                {
                    length:
                        workerCount,
                },

                () =>
                    worker()
            )
        );
    }

    // -----------------------------------------------------
    // Flatten pages in correct page order
    // -----------------------------------------------------

    const allOrders =
        pageResults.flat();

    const rows =
        allOrders.map(
            orderToRow
        );

    const csv = [
        CSV_HEADERS
            .map(csvEscape)
            .join(","),

        ...rows.map(
            row =>
                row
                    .map(
                        csvEscape
                    )
                    .join(",")
        ),
    ].join("\r\n");

    return {
        csv,

        count:
            allOrders.length,

        after,

        before,
    };
}

// ---------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------

function escapeHtml(value) {
    return String(value)
        .replaceAll(
            "&",
            "&amp;"
        )
        .replaceAll(
            "<",
            "&lt;"
        )
        .replaceAll(
            ">",
            "&gt;"
        )
        .replaceAll(
            '"',
            "&quot;"
        )
        .replaceAll(
            "'",
            "&#039;"
        );
}

function page(content) {
    return `
<!DOCTYPE html>
<html lang="en">

<head>

  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <meta
    name="color-scheme"
    content="dark"
  >

  <title>WooCommerce Exporter</title>

  <style>

    * {
      box-sizing: border-box;
    }

    html {
      color-scheme: dark;
    }

    body {
      margin: 0;
      padding: 40px 20px;

      min-height: 100vh;

      display: flex;
      align-items: center;
      justify-content: center;

      font-family:
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;

      background:
        radial-gradient(
          circle at 20% 20%,
          rgba(139, 92, 246, 0.18),
          transparent 32%
        ),
        radial-gradient(
          circle at 80% 70%,
          rgba(236, 72, 153, 0.10),
          transparent 30%
        ),
        #090b10;

      color: #f3f4f6;
    }

    .card {
      position: relative;

      width: 100%;
      max-width: 560px;

      padding: 36px;

      background:
        rgba(22, 25, 34, 0.97);

      border:
        1px solid #2b3140;

      border-radius: 22px;

      box-shadow:
        0 24px 80px
        rgba(0, 0, 0, 0.45);
    }

    /*
     * Tiny cat ears :3
     */

    .card::before,
    .card::after {
      content: "";

      position: absolute;

      width: 44px;
      height: 44px;

      top: -17px;

      background: #161922;

      border-top:
        1px solid #343949;

      border-left:
        1px solid #343949;

      transform:
        rotate(45deg);

      z-index: -1;
    }

    .card::before {
      left: 60px;
    }

    .card::after {
      right: 60px;
    }

    h1 {
      margin-top: 0;
      margin-bottom: 10px;

      font-size: 28px;
      line-height: 1.2;
    }

    h1::before {
      content: "ฅ^•ﻌ•^ฅ";

      display: block;

      margin-bottom: 10px;

      font-family:
        monospace;

      font-size: 18px;

      color: #a78bfa;

      letter-spacing: 2px;
    }

    .muted {
      color: #949baa;
    }

    .button {
      display: inline-block;

      padding:
        12px 18px;

      border:
        1px solid
        rgba(
          255,
          255,
          255,
          0.08
        );

      border-radius: 10px;

      background:
        linear-gradient(
          135deg,
          #7c3aed,
          #9333ea
        );

      color: white;

      font-size: 15px;

      font-weight: 650;

      text-decoration: none;

      cursor: pointer;

      transition:
        transform 0.15s ease,
        opacity 0.15s ease,
        box-shadow 0.15s ease;

      box-shadow:
        0 6px 20px
        rgba(
          124,
          58,
          237,
          0.25
        );
    }

    .button:hover:not(:disabled) {
      transform:
        translateY(-1px);

      box-shadow:
        0 8px 24px
        rgba(
          124,
          58,
          237,
          0.35
        );
    }

    .button:active:not(:disabled) {
      transform:
        translateY(1px);
    }

    .button:disabled {
      opacity: 0.55;
      cursor: wait;
    }

    .secondary {
      background: #252936;

      color: #d8dbe3;

      box-shadow: none;
    }

    .actions {
      margin-top: 24px;

      display: flex;
      flex-wrap: wrap;

      gap: 10px;
    }

    .status {
      margin-top: 20px;

      min-height: 24px;

      font-size: 14px;
    }

    .success {
      color: #5ee6a8;

      font-weight: 600;
    }

    .error {
      color: #ff808b;

      font-weight: 600;
    }

    .login-error {
      padding: 12px;
      margin-bottom: 20px;

      border-radius: 10px;

      background:
        rgba(
          255,
          80,
          90,
          0.12
        );

      border:
        1px solid
        rgba(
          255,
          100,
          110,
          0.2
        );

      color: #ff9ca5;
    }

    form {
      margin: 0;
    }

    /*
     * Progress
     */

    .progress-wrap {
      margin-top: 18px;

      padding: 15px;

      background: #10131a;

      border:
        1px solid #292e3c;

      border-radius: 12px;
    }

    .progress-wrap[hidden] {
      display: none;
    }

    .progress-info {
      display: flex;

      justify-content:
        space-between;

      align-items: center;

      gap: 16px;

      margin-bottom: 10px;

      font-size: 13px;

      color: #aeb4c2;
    }

    #progressLabel {
      overflow-wrap:
        anywhere;
    }

    #progressPercent {
      flex-shrink: 0;

      color: #c4b5fd;

      font-weight: 700;
    }

    .progress-track {
      position: relative;

      width: 100%;
      height: 10px;

      overflow: hidden;

      background: #272b37;

      border-radius: 999px;
    }

    .progress-bar {
      width: 0%;
      height: 100%;

      border-radius: inherit;

      background:
        linear-gradient(
          90deg,
          #7c3aed,
          #a855f7,
          #ec4899
        );

      box-shadow:
        0 0 14px
        rgba(
          168,
          85,
          247,
          0.55
        );

      transition:
        width 0.25s ease;
    }

    .cat-footer {
      margin-top: 24px;

      text-align: center;

      color: #535968;

      font-family:
        monospace;

      font-size: 13px;

      user-select: none;
    }

    @media (
      max-width: 520px
    ) {
      body {
        padding:
          32px 14px;
      }

      .card {
        padding:
          28px 22px;
      }

      .card::before {
        left: 45px;
      }

      .card::after {
        right: 45px;
      }

      .actions {
        flex-direction:
          column;
      }

      .button {
        width: 100%;

        text-align:
          center;
      }

      form {
        width: 100%;
      }
    }

  </style>

</head>

<body>

  <main class="card">
    ${content}

    <div class="cat-footer">
      /ᐠ｡ꞈ｡ᐟ\\
    </div>
  </main>

</body>

</html>
`;
}

// ---------------------------------------------------------
// Routes
// ---------------------------------------------------------

app.get(
    "/",
    (req, res) => {
        const error =
            req.query.error ===
                "access_denied"
                ? `
          <div class="login-error">
            Your Google account is not authorized
            to use this exporter.
          </div>
        `
                : "";

        if (
            !req.isAuthenticated()
        ) {
            return res.send(
                page(`
          <h1>
            WooCommerce Exporter
          </h1>

          ${error}

          <p class="muted">
            Sign in with an authorized Google account
            to export WooCommerce orders.
          </p>

          <div class="actions">

            <a
              class="button"
              href="/auth/google"
            >
              Sign in with Google
            </a>

          </div>
        `)
            );
        }

        return res.send(
            page(`
        <h1>
          WooCommerce Exporter
        </h1>

        <p>
          Signed in as
          <strong>
            ${escapeHtml(
                req.user.email
            )}
          </strong>
        </p>

        <p class="muted">
          Export all WooCommerce orders from
          the previous 24 months.
        </p>

        <div class="actions">

          <button
            class="button"
            id="exportButton"
            type="button"
          >
            Export CSV 🐾
          </button>

          <form
            method="POST"
            action="/logout"
          >

            <button
              class="button secondary"
              type="submit"
            >
              Sign out
            </button>

          </form>

        </div>

        <div
          id="exportStatus"
          class="status muted"
        ></div>

        <div
          id="progressWrap"
          class="progress-wrap"
          hidden
        >

          <div class="progress-info">

            <span id="progressLabel">
              Waking up the export cats...
            </span>

            <span id="progressPercent">
              0%
            </span>

          </div>

          <div
            id="progressTrack"
            class="progress-track"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow="0"
          >

            <div
              id="progressBar"
              class="progress-bar"
            ></div>

          </div>

        </div>

        <audio
          id="doneSound"
          preload="auto"
          src="/sounds/done.mp3"
        ></audio>

        <script src="/js/export.js"></script>
      `)
        );
    }
);

// ---------------------------------------------------------
// Google OAuth
// ---------------------------------------------------------

app.get(
    "/auth/google",

    passport.authenticate(
        "google"
    )
);

app.get(
    "/auth/google/callback",

    passport.authenticate(
        "google",
        {
            failureRedirect:
                "/?error=access_denied",
        }
    ),

    (req, res) => {
        res.redirect("/");
    }
);

// ---------------------------------------------------------
// Export progress
// ---------------------------------------------------------

app.get(
    "/export-progress",

    requireApiLogin,

    (req, res) => {
        res.setHeader(
            "Cache-Control",
            "no-store"
        );

        const progress =
            exportProgress.get(
                req.sessionID
            );

        res.json(
            progress || {
                state:
                    "idle",

                completedPages:
                    0,

                totalPages:
                    0,

                totalOrders:
                    0,

                percent:
                    0,
            }
        );
    }
);

// ---------------------------------------------------------
// Protected export
// ---------------------------------------------------------

app.get(
    "/export",

    requireApiLogin,

    async (
        req,
        res
    ) => {
        const progressId =
            req.sessionID;

        try {
            console.log(
                `Export requested by ${req.user.email}`
            );

            setExportProgress(
                progressId,
                {
                    state:
                        "starting",

                    completedPages:
                        0,

                    totalPages:
                        0,

                    totalOrders:
                        0,

                    percent:
                        0,
                }
            );

            const result =
                await generateOrdersCsv(
                    progress => {
                        setExportProgress(
                            progressId,
                            {
                                state:
                                    "fetching",

                                ...progress,
                            }
                        );
                    }
                );

            const startDate =
                result.after
                    .toISOString()
                    .slice(
                        0,
                        10
                    );

            const endDate =
                result.before
                    .toISOString()
                    .slice(
                        0,
                        10
                    );

            const filename =
                `woocommerce-orders-` +
                `${startDate}-to-${endDate}.csv`;

            setExportProgress(
                progressId,
                {
                    state:
                        "done",

                    completedPages:
                        exportProgress.get(
                            progressId
                        )
                            ?.totalPages ||
                        0,

                    totalPages:
                        exportProgress.get(
                            progressId
                        )
                            ?.totalPages ||
                        0,

                    totalOrders:
                        result.count,

                    percent:
                        100,
                }
            );

            res.setHeader(
                "Content-Type",
                "text/csv; charset=utf-8"
            );

            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${filename}"`
            );

            res.setHeader(
                "Cache-Control",
                "no-store"
            );

            // Makes UTF-8 friendlier for Excel.
            res.send(
                "\uFEFF" +
                result.csv
            );

            console.log(
                `Export completed: ${result.count} orders`
            );

            scheduleProgressCleanup(
                progressId
            );
        } catch (error) {
            console.error(
                "Export failed:"
            );

            console.error(
                error
            );

            const previous =
                exportProgress.get(
                    progressId
                ) || {};

            setExportProgress(
                progressId,
                {
                    ...previous,

                    state:
                        "error",
                }
            );

            scheduleProgressCleanup(
                progressId
            );

            if (
                !res.headersSent
            ) {
                res
                    .status(500)
                    .json({
                        error:
                            "The WooCommerce export could not be completed.",
                    });
            }
        }
    }
);

// ---------------------------------------------------------
// Logout
// ---------------------------------------------------------

app.post(
    "/logout",

    requireLogin,

    (
        req,
        res,
        next
    ) => {
        const sessionId =
            req.sessionID;

        req.logout(
            error => {
                if (error) {
                    return next(
                        error
                    );
                }

                req.session.destroy(
                    () => {
                        exportProgress.delete(
                            sessionId
                        );

                        res.clearCookie(
                            "woocommerce_export_session"
                        );

                        res.redirect(
                            "/"
                        );
                    }
                );
            }
        );
    }
);

// ---------------------------------------------------------
// Health
// ---------------------------------------------------------

app.get(
    "/health",

    (req, res) => {
        res.json({
            status:
                "ok",

            exportConcurrency:
                EXPORT_CONCURRENCY,
        });
    }
);

// ---------------------------------------------------------
// Start
// ---------------------------------------------------------

app.listen(
    PORT,

    () => {
        console.log("");
        console.log(
            `WooCommerce exporter running on port ${PORT}`
        );

        console.log(
            `WooCommerce export concurrency: ${EXPORT_CONCURRENCY}`
        );

        if (
            !IS_PRODUCTION
        ) {
            console.log(
                `Open: http://localhost:${PORT}`
            );
        }
    }
);