const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is not configured.");
    process.exit(1);
}

if (!ADMIN_PASSWORD) {
    console.error("ERROR: ADMIN_PASSWORD is not configured.");
    process.exit(1);
}


/* =========================================================
   DATABASE
========================================================= */

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});


/* =========================================================
   EXPRESS
========================================================= */

app.use(express.json());

app.use(express.urlencoded({
    extended: true
}));

app.use(express.static(
    path.join(__dirname, "public")
));


/* =========================================================
   CONSTANTS
========================================================= */

const MARKETS = [
    "ETHUSDT",
    "SOLUSDT",
    "POLUSDT",
    "TRXUSDT"
];

const DIRECTIONS = [
    "CALL",
    "PUT"
];


/* =========================================================
   DATABASE SETUP
========================================================= */

async function setupDatabase() {

    console.log("Setting up database...");

    await pool.query(`
        CREATE TABLE IF NOT EXISTS trades (

            id UUID PRIMARY KEY,

            market VARCHAR(20) NOT NULL,

            direction VARCHAR(10) NOT NULL,

            amount NUMERIC(18,2) NOT NULL,

            status VARCHAR(30) NOT NULL,

            created_at TIMESTAMPTZ NOT NULL,

            approval_expires_at TIMESTAMPTZ NOT NULL,

            approved_at TIMESTAMPTZ,

            trade_expires_at TIMESTAMPTZ,

            resolved_at TIMESTAMPTZ,

            start_price NUMERIC(30,12),

            demo_return NUMERIC(18,2) DEFAULT 0,

            demo_profit NUMERIC(18,2) DEFAULT 0,

            resolution_source VARCHAR(20)

        );
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        trades_status_index
        ON trades(status);
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        trades_created_index
        ON trades(created_at DESC);
    `);

    console.log("Database ready.");
}


/* =========================================================
   PAYOUT
========================================================= */

function calculatePayout(amount, status) {

    amount = Number(amount);

    if (status !== "WIN") {

        return {
            totalReturn: 0,
            profit: 0
        };

    }

    const multiplier =
        amount < 500
            ? 1.8
            : 3;

    const totalReturn =
        amount * multiplier;

    const profit =
        totalReturn - amount;

    return {
        totalReturn,
        profit
    };
}


/* =========================================================
   ADMIN AUTH
========================================================= */

function requireAdmin(req, res, next) {

    const password =
        req.headers["x-admin-password"];

    if (
        !password ||
        password !== ADMIN_PASSWORD
    ) {

        return res.status(401).json({
            success: false,
            error: "Unauthorized"
        });

    }

    next();
}


/* =========================================================
   CREATE DEMO TRADE
========================================================= */

app.post("/api/trades", async (req, res) => {

    try {

        const {
            market,
            direction,
            amount,
            startPrice
        } = req.body;


        if (!MARKETS.includes(market)) {

            return res.status(400).json({
                success: false,
                error: "Invalid market"
            });

        }


        if (!DIRECTIONS.includes(direction)) {

            return res.status(400).json({
                success: false,
                error: "Invalid direction"
            });

        }


        const numericAmount =
            Number(amount);


        if (
            !Number.isFinite(numericAmount) ||
            numericAmount <= 0
        ) {

            return res.status(400).json({
                success: false,
                error: "Invalid amount"
            });

        }


        const id =
            crypto.randomUUID();


        const createdAt =
            new Date();


        const approvalExpiresAt =
            new Date(
                createdAt.getTime() + 60000
            );


        const result =
            await pool.query(
                `
                INSERT INTO trades (

                    id,
                    market,
                    direction,
                    amount,
                    status,
                    created_at,
                    approval_expires_at,
                    start_price

                )

                VALUES (

                    $1,
                    $2,
                    $3,
                    $4,
                    'PENDING_APPROVAL',
                    $5,
                    $6,
                    $7

                )

                RETURNING *
                `,
                [
                    id,
                    market,
                    direction,
                    numericAmount,
                    createdAt,
                    approvalExpiresAt,
                    startPrice || null
                ]
            );


        console.log(
            "New demo trade:",
            id
        );


        res.json({
            success: true,
            trade: result.rows[0]
        });

    }

    catch (error) {

        console.error(
            "CREATE TRADE ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            error: "Unable to create demo trade",
            details: error.message
        });

    }

});


/* =========================================================
   GET TRADE
========================================================= */

app.get("/api/trades/:id", async (req, res) => {

    try {

        const result =
            await pool.query(
                `
                SELECT *
                FROM trades
                WHERE id = $1
                `,
                [req.params.id]
            );


        if (result.rows.length === 0) {

            return res.status(404).json({
                success: false,
                error: "Trade not found"
            });

        }


        res.json({
            success: true,
            trade: result.rows[0]
        });

    }

    catch (error) {

        console.error(
            "GET TRADE ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            error: "Unable to get trade"
        });

    }

});


/* =========================================================
   ADMIN LOGIN
========================================================= */

app.post("/api/admin/login", (req, res) => {

    const {
        password
    } = req.body;


    if (password !== ADMIN_PASSWORD) {

        return res.status(401).json({
            success: false,
            error: "Invalid password"
        });

    }


    res.json({
        success: true
    });

});


/* =========================================================
   ADMIN GET TRADES
========================================================= */

app.get(
    "/api/admin/trades",
    requireAdmin,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM trades
                    ORDER BY created_at DESC
                    LIMIT 200
                    `
                );


            res.json({
                success: true,
                trades: result.rows
            });

        }

        catch (error) {

            console.error(
                "ADMIN TRADES ERROR:",
                error
            );

            res.status(500).json({
                success: false,
                error: "Unable to load trades"
            });

        }

    }
);


/* =========================================================
   ADMIN APPROVE
========================================================= */

app.post(
    "/api/admin/trades/:id/approve",
    requireAdmin,
    async (req, res) => {

        try {

            /*
             * IMPORTANT:
             *
             * The status and time condition are checked
             * by PostgreSQL itself.
             *
             * Therefore an expired trade cannot be
             * approved accidentally.
             */

            const result =
                await pool.query(
                    `
                    UPDATE trades

                    SET

                        status = 'ACTIVE',

                        approved_at = NOW(),

                        trade_expires_at =
                            NOW() + INTERVAL '60 seconds'

                    WHERE

                        id = $1

                    AND

                        status = 'PENDING_APPROVAL'

                    AND

                        approval_expires_at > NOW()

                    RETURNING *
                    `,
                    [req.params.id]
                );


            if (result.rows.length === 0) {

                return res.status(409).json({
                    success: false,
                    error:
                        "This trade is no longer waiting for approval."
                });

            }


            console.log(
                "Trade approved:",
                req.params.id
            );


            res.json({
                success: true,
                trade: result.rows[0]
            });

        }

        catch (error) {

            console.error(
                "APPROVE ERROR:",
                error
            );

            res.status(500).json({
                success: false,
                error: "Unable to approve trade"
            });

        }

    }
);


/* =========================================================
   ADMIN DECLINE
========================================================= */

app.post(
    "/api/admin/trades/:id/decline",
    requireAdmin,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    UPDATE trades

                    SET

                        status = 'DECLINED',

                        resolution_source = 'ADMIN',

                        resolved_at = NOW()

                    WHERE

                        id = $1

                    AND

                        status = 'PENDING_APPROVAL'

                    RETURNING *
                    `,
                    [req.params.id]
                );


            if (result.rows.length === 0) {

                return res.status(409).json({
                    success: false,
                    error:
                        "Trade is no longer waiting for approval."
                });

            }


            res.json({
                success: true,
                trade: result.rows[0]
            });

        }

        catch (error) {

            console.error(
                "DECLINE ERROR:",
                error
            );

            res.status(500).json({
                success: false,
                error: "Unable to decline trade"
            });

        }

    }
);


/* =========================================================
   ADMIN RESOLVE ACTIVE TRADE
========================================================= */

app.post(
    "/api/admin/trades/:id/resolve",
    requireAdmin,
    async (req, res) => {

        try {

            const resultValue =
                String(
                    req.body.result || ""
                ).toUpperCase();


            if (
                resultValue !== "WIN" &&
                resultValue !== "LOSS"
            ) {

                return res.status(400).json({
                    success: false,
                    error:
                        "Result must be WIN or LOSS"
                });

            }


            const existing =
                await pool.query(
                    `
                    SELECT *
                    FROM trades
                    WHERE id = $1
                    `,
                    [req.params.id]
                );


            if (existing.rows.length === 0) {

                return res.status(404).json({
                    success: false,
                    error: "Trade not found"
                });

            }


            const trade =
                existing.rows[0];


            if (trade.status !== "ACTIVE") {

                return res.status(409).json({
                    success: false,
                    error:
                        "Only ACTIVE trades can be resolved."
                });

            }


            const payout =
                calculatePayout(
                    trade.amount,
                    resultValue
                );


            const result =
                await pool.query(
                    `
                    UPDATE trades

                    SET

                        status = $1,

                        resolved_at = NOW(),

                        resolution_source = 'ADMIN',

                        demo_return = $2,

                        demo_profit = $3

                    WHERE

                        id = $4

                    AND

                        status = 'ACTIVE'

                    RETURNING *
                    `,
                    [
                        resultValue,
                        payout.totalReturn,
                        payout.profit,
                        req.params.id
                    ]
                );


            res.json({
                success: true,
                trade: result.rows[0]
            });

        }

        catch (error) {

            console.error(
                "RESOLVE ERROR:",
                error
            );

            res.status(500).json({
                success: false,
                error: "Unable to resolve trade"
            });

        }

    }
);


/* =========================================================
   AUTOMATIC APPROVAL TIMEOUT
========================================================= */

async function processApprovalTimeouts() {

    try {

        const result =
            await pool.query(
                `
                UPDATE trades

                SET

                    status = 'DECLINED',

                    resolution_source = 'AUTO',

                    resolved_at = NOW()

                WHERE

                    status = 'PENDING_APPROVAL'

                AND

                    approval_expires_at <= NOW()

                RETURNING id
                `
            );


        if (result.rows.length > 0) {

            console.log(
                "Automatically declined:",
                result.rows.length
            );

        }

    }

    catch (error) {

        console.error(
            "APPROVAL TIMEOUT ERROR:",
            error
        );

    }

}


/* =========================================================
   AUTOMATIC ACTIVE TRADE RESOLUTION
========================================================= */

async function processActiveTrades() {

    try {

        const result =
            await pool.query(
                `
                SELECT *
                FROM trades

                WHERE

                    status = 'ACTIVE'

                AND

                    trade_expires_at <= NOW()

                LIMIT 100
                `
            );


        for (
            const trade of result.rows
        ) {

            /*
             * Demo-only simulated outcome.
             */

            const resultStatus =
                Math.random() >= 0.5
                    ? "WIN"
                    : "LOSS";


            const payout =
                calculatePayout(
                    trade.amount,
                    resultStatus
                );


            await pool.query(
                `
                UPDATE trades

                SET

                    status = $1,

                    resolved_at = NOW(),

                    resolution_source = 'AUTO',

                    demo_return = $2,

                    demo_profit = $3

                WHERE

                    id = $4

                AND

                    status = 'ACTIVE'
                `,
                [
                    resultStatus,
                    payout.totalReturn,
                    payout.profit,
                    trade.id
                ]
            );


            console.log(
                "Auto resolved:",
                trade.id,
                resultStatus
            );

        }

    }

    catch (error) {

        console.error(
            "ACTIVE TRADE ERROR:",
            error
        );

    }

}


/* =========================================================
   HEALTH
========================================================= */

app.get("/api/health", async (req, res) => {

    try {

        await pool.query("SELECT 1");

        res.json({
            status: "ok",
            database: "connected",
            demo: true
        });

    }

    catch (error) {

        res.status(500).json({
            status: "error",
            database: "disconnected"
        });

    }

});


/* =========================================================
   PAGES
========================================================= */

app.get("/", (req, res) => {

    res.sendFile(
        path.join(
            __dirname,
            "public",
            "index.html"
        )
    );

});


app.get("/admin", (req, res) => {

    res.sendFile(
        path.join(
            __dirname,
            "public",
            "admin.html"
        )
    );

});


/* =========================================================
   START
========================================================= */

async function start() {

    try {

        await setupDatabase();


        /*
         * Check for expired trades every second.
         */

        setInterval(
            processApprovalTimeouts,
            1000
        );


        setInterval(
            processActiveTrades,
            1000
        );


        app.listen(
            PORT,
            "0.0.0.0",
            () => {

                console.log(
                    `NovaTrade running on port ${PORT}`
                );

            }
        );

    }

    catch (error) {

        console.error(
            "STARTUP ERROR:",
            error
        );

        process.exit(1);

    }

}

start();
