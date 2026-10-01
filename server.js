const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 10000;

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD || "CHANGE_THIS_PASSWORD";

const DATABASE_URL =
    process.env.DATABASE_URL;


/*
=========================================================
DATABASE
=========================================================
*/

if (!DATABASE_URL) {
    console.error("DATABASE_URL environment variable is missing.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});


/*
=========================================================
EXPRESS
=========================================================
*/

app.use(express.json());

app.use(
    express.urlencoded({
        extended: true
    })
);

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);


/*
=========================================================
DATABASE INITIALIZATION
=========================================================
*/

async function initializeDatabase() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS trades (

            id UUID PRIMARY KEY,

            market VARCHAR(30) NOT NULL,

            direction VARCHAR(10) NOT NULL,

            amount NUMERIC(18,2) NOT NULL,

            status VARCHAR(20) NOT NULL DEFAULT 'PENDING',

            resolution_source VARCHAR(20),

            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

            expires_at TIMESTAMPTZ NOT NULL,

            resolved_at TIMESTAMPTZ,

            start_price NUMERIC(30,12),

            demo_return NUMERIC(18,2) DEFAULT 0,

            demo_profit NUMERIC(18,2) DEFAULT 0

        );
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        trades_status_idx
        ON trades(status);
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        trades_created_at_idx
        ON trades(created_at DESC);
    `);


    console.log(
        "Database initialized."
    );
}


/*
=========================================================
UTILITY
=========================================================
*/

function generateId() {

    return crypto.randomUUID();

}


function calculateReturn(
    amount,
    status
) {

    amount = Number(amount);

    if (status !== "WIN") {

        return {
            totalReturn: 0,
            profit: 0,
            multiplier: 0
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
        profit,
        multiplier
    };

}


/*
=========================================================
VALIDATION
=========================================================
*/

const ALLOWED_MARKETS = [
    "ETHUSDT",
    "SOLUSDT",
    "POLUSDT",
    "TRXUSDT"
];

const ALLOWED_DIRECTIONS = [
    "CALL",
    "PUT"
];


/*
=========================================================
CREATE DEMO TRADE
=========================================================
*/

app.post(
    "/api/trades",
    async (req, res) => {

        try {

            const {
                market,
                direction,
                amount,
                startPrice
            } = req.body;


            if (
                !ALLOWED_MARKETS.includes(
                    market
                )
            ) {

                return res.status(400).json({
                    error: "Invalid market."
                });

            }


            if (
                !ALLOWED_DIRECTIONS.includes(
                    direction
                )
            ) {

                return res.status(400).json({
                    error: "Invalid direction."
                });

            }


            const numericAmount =
                Number(amount);


            if (
                !Number.isFinite(
                    numericAmount
                ) ||
                numericAmount <= 0
            ) {

                return res.status(400).json({
                    error: "Invalid demo amount."
                });

            }


            /*
             * This is a demo system.
             * There is intentionally no payment
             * or wallet verification.
             */

            const id =
                generateId();


            const createdAt =
                new Date();


            const expiresAt =
                new Date(
                    createdAt.getTime() +
                    60 * 1000
                );


            const result =
                await pool.query(
                    `
                    INSERT INTO trades
                    (
                        id,
                        market,
                        direction,
                        amount,
                        status,
                        created_at,
                        expires_at,
                        start_price
                    )
                    VALUES
                    (
                        $1,
                        $2,
                        $3,
                        $4,
                        'PENDING',
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
                        expiresAt,
                        startPrice || null
                    ]
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
                error: "Unable to create demo trade."
            });

        }

    }
);


/*
=========================================================
GET TRADE
=========================================================
*/

app.get(
    "/api/trades/:id",
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM trades
                    WHERE id = $1
                    `,
                    [
                        req.params.id
                    ]
                );


            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({
                    error: "Trade not found."
                });

            }


            res.json({
                success: true,
                trade: result.rows[0]
            });

        }
        catch (error) {

            console.error(
                error
            );


            res.status(500).json({
                error: "Unable to retrieve trade."
            });

        }

    }
);


/*
=========================================================
ADMIN AUTHENTICATION
=========================================================
*/

function adminAuth(
    req,
    res,
    next
) {

    const password =
        req.headers["x-admin-password"];


    if (
        !password ||
        password !== ADMIN_PASSWORD
    ) {

        return res.status(401).json({
            error: "Unauthorized."
        });

    }


    next();

}


/*
=========================================================
ADMIN LOGIN CHECK
=========================================================
*/

app.post(
    "/api/admin/login",
    (req, res) => {

        const {
            password
        } = req.body;


        if (
            password !== ADMIN_PASSWORD
        ) {

            return res.status(401).json({
                success: false,
                error: "Invalid password."
            });

        }


        res.json({
            success: true
        });

    }
);


/*
=========================================================
ADMIN GET TRADES
=========================================================
*/

app.get(
    "/api/admin/trades",
    adminAuth,
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
                error
            );


            res.status(500).json({
                error: "Unable to retrieve trades."
            });

        }

    }
);


/*
=========================================================
ADMIN RESOLVE TRADE
=========================================================
*/

app.post(
    "/api/admin/trades/:id/resolve",
    adminAuth,
    async (req, res) => {

        try {

            const {
                result: requestedResult
            } = req.body;


            const status =
                String(
                    requestedResult || ""
                ).toUpperCase();


            if (
                !["WIN", "LOSS"].includes(
                    status
                )
            ) {

                return res.status(400).json({
                    error:
                        "Result must be WIN or LOSS."
                });

            }


            /*
             * Only pending trades can be
             * manually resolved.
             */

            const existing =
                await pool.query(
                    `
                    SELECT *
                    FROM trades
                    WHERE id = $1
                    `,
                    [
                        req.params.id
                    ]
                );


            if (
                existing.rows.length === 0
            ) {

                return res.status(404).json({
                    error: "Trade not found."
                });

            }


            const trade =
                existing.rows[0];


            if (
                trade.status !== "PENDING"
            ) {

                return res.status(409).json({
                    error:
                        "This trade has already been resolved."
                });

            }


            const payout =
                calculateReturn(
                    trade.amount,
                    status
                );


            const updated =
                await pool.query(
                    `
                    UPDATE trades
                    SET
                        status = $1,
                        resolution_source = 'ADMIN',
                        resolved_at = NOW(),
                        demo_return = $2,
                        demo_profit = $3
                    WHERE id = $4
                    AND status = 'PENDING'
                    RETURNING *
                    `,
                    [
                        status,
                        payout.totalReturn,
                        payout.profit,
                        req.params.id
                    ]
                );


            if (
                updated.rows.length === 0
            ) {

                return res.status(409).json({
                    error:
                        "Trade was already resolved."
                });

            }


            res.json({
                success: true,
                trade: updated.rows[0]
            });

        }
        catch (error) {

            console.error(
                "RESOLVE ERROR:",
                error
            );


            res.status(500).json({
                error:
                    "Unable to resolve trade."
            });

        }

    }
);


/*
=========================================================
AUTOMATIC DEMO RESOLUTION
=========================================================
*/

async function automaticallyResolveTrades() {

    try {

        /*
         * Find trades whose 60 seconds have expired.
         */

        const result =
            await pool.query(
                `
                SELECT *
                FROM trades
                WHERE status = 'PENDING'
                AND expires_at <= NOW()
                LIMIT 100
                `
            );


        for (
            const trade of result.rows
        ) {

            /*
             * Automatic demo result.
             */

            const status =
                Math.random() >= 0.5
                    ? "WIN"
                    : "LOSS";


            const payout =
                calculateReturn(
                    trade.amount,
                    status
                );


            await pool.query(
                `
                UPDATE trades
                SET
                    status = $1,
                    resolution_source = 'AUTO',
                    resolved_at = NOW(),
                    demo_return = $2,
                    demo_profit = $3
                WHERE id = $4
                AND status = 'PENDING'
                `,
                [
                    status,
                    payout.totalReturn,
                    payout.profit,
                    trade.id
                ]
            );


            console.log(
                `Automatically resolved ${trade.id}: ${status}`
            );

        }

    }
    catch (error) {

        console.error(
            "AUTO RESOLUTION ERROR:",
            error
        );

    }

}


/*
=========================================================
HEALTH CHECK
=========================================================
*/

app.get(
    "/api/health",
    (req, res) => {

        res.json({
            status: "ok",
            demo: true
        });

    }
);


/*
=========================================================
FRONTEND ROUTES
=========================================================
*/

app.get(
    "/",
    (req, res) => {

        res.sendFile(
            path.join(
                __dirname,
                "public",
                "index.html"
            )
        );

    }
);


app.get(
    "/admin",
    (req, res) => {

        res.sendFile(
            path.join(
                __dirname,
                "public",
                "admin.html"
            )
        );

    }
);


/*
=========================================================
START SERVER
=========================================================
*/

async function startServer() {

    try {

        await initializeDatabase();


        /*
         * Check expired demo trades
         * every second.
         */

        setInterval(
            automaticallyResolveTrades,
            1000
        );


        app.listen(
            PORT,
            "0.0.0.0",
            () => {

                console.log(
                    `NovaTrade demo running on port ${PORT}`
                );

            }
        );

    }
    catch (error) {

        console.error(
            "SERVER START ERROR:",
            error
        );

        process.exit(1);

    }

}


startServer();
