require("dotenv").config();

const express = require("express");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oidc");
const helmet = require("helmet");

const app = express();

const PORT = Number(process.env.PORT || 3069);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

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
        console.error(`Missing required environment variable: ${name}`);
        process.exit(1);
    }
}

// ---------------------------------------------------------
// Configuration
// ---------------------------------------------------------

const ALLOWED_EMAILS = new Set(
    process.env.ALLOWED_EMAILS
        .split(",")
        .map(email => email.trim().toLowerCase())
        .filter(Boolean)
);

const WC_STORE_URL = process.env.WC_STORE_URL.replace(/\/$/, "");
const WC_CONSUMER_KEY = process.env.WC_CONSUMER_KEY;
const WC_CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET;

const WC_QUERY_STRING_AUTH =
    process.env.WC_QUERY_STRING_AUTH === "true";

const PER_PAGE = 100;

if (IS_PRODUCTION) {
    app.set("trust proxy", 1);
}

// ---------------------------------------------------------
// Security / middleware
// ---------------------------------------------------------

app.use(
    helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                mediaSrc: ["'self'"],
            },
        },
    })
);

app.use(express.static("public"));

app.use(
    session({
        name: "woocommerce_export_session",
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,

        cookie: {
            httpOnly: true,
            secure: IS_PRODUCTION,
            sameSite: "lax",
            maxAge: 8 * 60 * 60 * 1000,
        },
    })
);

app.use(passport.initialize());
app.use(passport.session());

// ---------------------------------------------------------
// Passport / Google authentication
// ---------------------------------------------------------

passport.use(
    new GoogleStrategy(
        {
            clientID: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            callbackURL: process.env.GOOGLE_CALLBACK_URL,
            scope: ["profile", "email"],
        },

        function verify(issuer, profile, done) {
            try {
                const email = profile.emails?.[0]?.value
                    ?.trim()
                    .toLowerCase();

                if (!email) {
                    console.warn("Google account returned no email.");
                    return done(null, false);
                }

                if (!ALLOWED_EMAILS.has(email)) {
                    console.warn(
                        `Rejected Google login from non-whitelisted email: ${email}`
                    );

                    return done(null, false);
                }

                return done(null, {
                    id: profile.id,
                    email,
                    displayName: profile.displayName || email,
                });
            } catch (error) {
                return done(error);
            }
        }
    )
);

passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((user, done) => {
    done(null, user);
});

// ---------------------------------------------------------
// Authentication middleware
// ---------------------------------------------------------

function requireLogin(req, res, next) {
    if (!req.isAuthenticated()) {
        return res.redirect("/");
    }

    const email = req.user?.email?.toLowerCase();

    if (!email || !ALLOWED_EMAILS.has(email)) {
        return res.status(403).send("Access denied.");
    }

    next();
}

// Used by fetch() routes so we don't redirect to HTML
function requireApiLogin(req, res, next) {
    if (!req.isAuthenticated()) {
        return res.status(401).json({
            error: "Not authenticated",
        });
    }

    const email = req.user?.email?.toLowerCase();

    if (!email || !ALLOWED_EMAILS.has(email)) {
        return res.status(403).json({
            error: "Access denied",
        });
    }

    next();
}

// ---------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------

function csvEscape(value) {
    if (value === null || value === undefined) {
        return "";
    }

    const str = String(value);

    if (
        str.includes(",") ||
        str.includes('"') ||
        str.includes("\n") ||
        str.includes("\r")
    ) {
        return `"${str.replace(/"/g, '""')}"`;
    }

    return str;
}

function orderToRow(order) {
    const items = (order.line_items || [])
        .map(item => `${item.name} x${item.quantity}`)
        .join(" | ");

    const itemCount = (order.line_items || []).reduce(
        (total, item) => total + Number(item.quantity || 0),
        0
    );

    const coupons = (order.coupon_lines || [])
        .map(coupon => coupon.code)
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

        order.billing?.first_name,
        order.billing?.last_name,
        order.billing?.email,
        order.billing?.phone,
        order.billing?.country,

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

async function fetchOrdersPage(page, after, before) {
    const params = new URLSearchParams({
        after: after.toISOString(),
        before: before.toISOString(),
        dates_are_gmt: "true",
        status: "any",

        page: String(page),
        per_page: String(PER_PAGE),

        orderby: "date",
        order: "asc",
    });

    const headers = {};

    if (WC_QUERY_STRING_AUTH) {
        params.set("consumer_key", WC_CONSUMER_KEY);
        params.set("consumer_secret", WC_CONSUMER_SECRET);
    } else {
        const credentials = Buffer.from(
            `${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`
        ).toString("base64");

        headers.Authorization = `Basic ${credentials}`;
    }

    const url =
        `${WC_STORE_URL}/wp-json/wc/v3/orders?${params.toString()}`;

    const response = await fetch(url, {
        headers,
    });

    if (!response.ok) {
        const body = await response.text();

        throw new Error(
            `WooCommerce API error: ${response.status} ${response.statusText}\n${body}`
        );
    }

    const orders = await response.json();

    return {
        orders,

        totalOrders: Number(
            response.headers.get("x-wp-total") || orders.length
        ),

        totalPages: Number(
            response.headers.get("x-wp-totalpages") || 1
        ),
    };
}

async function generateOrdersCsv() {
    const before = new Date();

    const after = new Date(before);
    after.setUTCMonth(after.getUTCMonth() - 24);

    console.log("");
    console.log("Starting WooCommerce export");
    console.log(`From: ${after.toISOString()}`);
    console.log(`To:   ${before.toISOString()}`);

    const firstPage = await fetchOrdersPage(
        1,
        after,
        before
    );

    console.log(`Orders: ${firstPage.totalOrders}`);
    console.log(`Pages: ${firstPage.totalPages}`);

    const allOrders = [...firstPage.orders];

    console.log(
        `Fetched page 1/${firstPage.totalPages}`
    );

    for (
        let page = 2;
        page <= firstPage.totalPages;
        page++
    ) {
        const result = await fetchOrdersPage(
            page,
            after,
            before
        );

        allOrders.push(...result.orders);

        console.log(
            `Fetched page ${page}/${firstPage.totalPages}`
        );
    }

    const rows = allOrders.map(orderToRow);

    const csv = [
        CSV_HEADERS.map(csvEscape).join(","),

        ...rows.map(row =>
            row.map(csvEscape).join(",")
        ),
    ].join("\r\n");

    return {
        csv,
        count: allOrders.length,
        after,
        before,
    };
}

// ---------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
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

  <title>WooCommerce Exporter</title>

  <style>
    * {
      box-sizing: border-box;
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

      background: #f5f5f5;
      color: #222;
    }

    .card {
      width: 100%;
      max-width: 520px;

      background: white;
      padding: 32px;

      border-radius: 16px;

      box-shadow:
        0 8px 30px
        rgba(0, 0, 0, 0.08);
    }

    h1 {
      margin-top: 0;
    }

    .muted {
      color: #666;
    }

    .button {
      display: inline-block;

      padding: 12px 18px;

      border: 0;
      border-radius: 8px;

      background: #111;
      color: white;

      font-size: 15px;
      font-weight: 600;

      text-decoration: none;

      cursor: pointer;
    }

    .button:disabled {
      opacity: 0.55;
      cursor: wait;
    }

    .secondary {
      background: #eee;
      color: #222;
    }

    .actions {
      margin-top: 24px;

      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .error {
      padding: 12px;
      margin-bottom: 20px;

      border-radius: 8px;

      background: #ffe9e9;
      color: #8b0000;
    }

    .success {
      margin-top: 18px;
      color: #18794e;
      font-weight: 600;
    }

    .status {
      margin-top: 18px;
      min-height: 24px;
    }

    form {
      margin: 0;
    }
  </style>

</head>

<body>

  <main class="card">
    ${content}
  </main>

</body>

</html>
`;
}

// ---------------------------------------------------------
// Routes
// ---------------------------------------------------------

app.get("/", (req, res) => {
    const error =
        req.query.error === "access_denied"
            ? `
        <div class="error">
          Your Google account is not authorized
          to use this exporter.
        </div>
      `
            : "";

    if (!req.isAuthenticated()) {
        return res.send(
            page(`
        <h1>WooCommerce Exporter</h1>

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
      <h1>WooCommerce Exporter</h1>

      <p>
        Signed in as
        <strong>
          ${escapeHtml(req.user.email)}
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
          Export CSV
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

      <audio
        id="doneSound"
        preload="auto"
        src="/sounds/done.mp3"
      ></audio>

      <script src="/js/export.js"></script>
    `)
    );
});

app.get(
    "/auth/google",
    passport.authenticate("google")
);

app.get(
    "/auth/google/callback",

    passport.authenticate("google", {
        failureRedirect: "/?error=access_denied",
    }),

    (req, res) => {
        res.redirect("/");
    }
);

// ---------------------------------------------------------
// Protected export
// ---------------------------------------------------------

app.get(
    "/export",
    requireApiLogin,

    async (req, res) => {
        try {
            console.log(
                `Export requested by ${req.user.email}`
            );

            const result =
                await generateOrdersCsv();

            const startDate =
                result.after
                    .toISOString()
                    .slice(0, 10);

            const endDate =
                result.before
                    .toISOString()
                    .slice(0, 10);

            const filename =
                `woocommerce-orders-${startDate}-to-${endDate}.csv`;

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

            // Makes UTF-8 friendlier for Excel
            res.send("\uFEFF" + result.csv);

            console.log(
                `Export completed: ${result.count} orders`
            );
        } catch (error) {
            console.error("Export failed:");
            console.error(error);

            res.status(500).json({
                error: "The WooCommerce export could not be completed.",
            });
        }
    }
);

// ---------------------------------------------------------
// Logout
// ---------------------------------------------------------

app.post(
    "/logout",
    requireLogin,

    (req, res, next) => {
        req.logout(error => {
            if (error) {
                return next(error);
            }

            req.session.destroy(() => {
                res.clearCookie(
                    "woocommerce_export_session"
                );

                res.redirect("/");
            });
        });
    }
);

// ---------------------------------------------------------
// Health
// ---------------------------------------------------------

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
    });
});

// ---------------------------------------------------------
// Start
// ---------------------------------------------------------

app.listen(PORT, () => {
    console.log("");
    console.log(
        `WooCommerce exporter running on port ${PORT}`
    );

    if (!IS_PRODUCTION) {
        console.log(
            `Open: http://localhost:${PORT}`
        );
    }
});