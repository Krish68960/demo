const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;


/* =========================================================
   ENVIRONMENT CHECK
========================================================= */

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


/* =========================================================
   ALLOWED MARKETS
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

    console.log("Setting up NovaTrade database...");

    /*
     * Create the table if it does not exist.
     */
    await pool.query(`
        CREATE TABLE IF NOT EXISTS trades (

            id UUID PRIMARY KEY,

            market VARCHAR(20) NOT NULL,

            direction VARCHAR(10) NOT NULL,

            amount NUMERIC(18,2) NOT NULL,

            status VARCHAR(30) NOT NULL DEFAULT 'PENDING_APPROVAL',

            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

            approval_expires_at TIMESTAMPTZ,

            approved_at TIMESTAMPTZ,

            trade_expires_at TIMESTAMPTZ,

            resolved_at TIMESTAMPTZ,

            start_price NUMERIC(30,12),

            demo_return NUMERIC(18,2) DEFAULT 0,

            demo_profit NUMERIC(18,2) DEFAULT 0,

            resolution_source VARCHAR(20),

            pending_result VARCHAR(10),

            pending_result_source VARCHAR(20)

        );
    `);


    /*
     * IMPORTANT:
     *
     * These ALTER statements automatically add
     * columns to an existing trades table.
     *
     * Therefore you do NOT need to manually
     * enter SQL in Render.
     */

    await pool.query(`
        ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS
        approval_expires_at TIMESTAMPTZ;
    `);


    await pool.query(`
        ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS
        approved_at TIMESTAMPTZ;
    `);


    await pool.query(`
        ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS
        trade_expires_at TIMESTAMPTZ;
    `);


    await pool.query(`
        ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS
        resolved_at TIMESTAMPTZ;
    `);


    await pool.query(`
        ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS
        start_price NUMERIC(30,12);
    `);


    await pool.query(`
        ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS
        demo_return NUMERIC(18,2)
        DEFAULT 0;
    `);


    await pool.query(`
        ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS
        demo_profit NUMERIC(18,2)
        DEFAULT 0;
    `);


    await pool.query(`
        ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS
        resolution_source VARCHAR(20);
    `);


    await pool.query(`
        ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS
        pending_result VARCHAR(10);
    `);


    await pool.query(`
        ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS
        pending_result_source VARCHAR(20);
    `);


    /*
     * Give old rows sensible defaults where possible.
     */

    await pool.query(`
        UPDATE trades

        SET
            demo_return = 0

        WHERE
            demo_return IS NULL;
    `);


    await pool.query(`
        UPDATE trades

        SET
            demo_profit = 0

        WHERE
            demo_profit IS NULL;
    `);


    /*
     * Create indexes.
     */

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


    console.log(
        "NovaTrade database ready."
    );

}

/* =========================================================
   PAYOUT CALCULATION
========================================================= */

function calculatePayout(
    amount,
    status
) {

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
   ADMIN AUTHENTICATION
========================================================= */

function requireAdmin(
    req,
    res,
    next
) {

    const password =
        req.headers[
            "x-admin-password"
        ];


    if (
        !password ||
        password !== ADMIN_PASSWORD
    ) {

        return res
            .status(401)
            .json({

                success: false,

                error:
                    "Unauthorized"

            });

    }


    next();

}


/* =========================================================
   CREATE DEMO TRADE
========================================================= */

app.post(
    "/api/trades",
    async (
        req,
        res
    ) => {

        try {

            const {

                market,

                direction,

                amount,

                startPrice

            } = req.body;


            /* -----------------------------
               MARKET VALIDATION
            ----------------------------- */

            if (
                !MARKETS.includes(
                    market
                )
            ) {

                return res
                    .status(400)
                    .json({

                        success: false,

                        error:
                            "Invalid market"

                    });

            }


            /* -----------------------------
               DIRECTION VALIDATION
            ----------------------------- */

            if (
                !DIRECTIONS.includes(
                    direction
                )
            ) {

                return res
                    .status(400)
                    .json({

                        success: false,

                        error:
                            "Invalid direction"

                    });

            }


            /* -----------------------------
               AMOUNT VALIDATION
            ----------------------------- */

            const numericAmount =
                Number(amount);


            if (
                !Number.isFinite(
                    numericAmount
                ) ||
                numericAmount <= 0
            ) {

                return res
                    .status(400)
                    .json({

                        success: false,

                        error:
                            "Invalid demo amount"

                    });

            }


            /* -----------------------------
               CREATE TRADE ID
            ----------------------------- */

            const id =
                crypto.randomUUID();


            const createdAt =
                new Date();


            /*
             * Admin has exactly 60 seconds
             * to approve.
             */

            const approvalExpiresAt =
                new Date(
                    createdAt.getTime() +
                    60 * 1000
                );


            /* -----------------------------
               INSERT
            ----------------------------- */

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

                trade:
                    result.rows[0]

            });

        }

        catch (error) {

            console.error(
                "CREATE TRADE ERROR:",
                error
            );


            res
                .status(500)
                .json({

                    success: false,

                    error:
                        "Unable to create demo trade",

                    details:
                        error.message

                });

        }

    }
);


/* =========================================================
   GET SINGLE TRADE
========================================================= */

app.get(
    "/api/trades/:id",
    async (
        req,
        res
    ) => {

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

                return res
                    .status(404)
                    .json({

                        success: false,

                        error:
                            "Trade not found"

                    });

            }


            res.json({

                success: true,

                trade:
                    result.rows[0]

            });

        }

        catch (error) {

            console.error(
                "GET TRADE ERROR:",
                error
            );


            res
                .status(500)
                .json({

                    success: false,

                    error:
                        "Unable to get trade"

                });

        }

    }
);


/* =========================================================
   ADMIN LOGIN
========================================================= */

app.post(
    "/api/admin/login",
    (
        req,
        res
    ) => {

        const {
            password
        } = req.body;


        if (
            password !==
            ADMIN_PASSWORD
        ) {

            return res
                .status(401)
                .json({

                    success: false,

                    error:
                        "Invalid password"

                });

        }


        res.json({

            success: true

        });

    }
);


/* =========================================================
   ADMIN GET TRADES
========================================================= */

app.get(
    "/api/admin/trades",
    requireAdmin,
    async (
        req,
        res
    ) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *

                    FROM trades

                    ORDER BY
                    created_at DESC

                    LIMIT 200
                    `
                );


            res.json({

                success: true,

                trades:
                    result.rows

            });

        }

        catch (error) {

            console.error(
                "ADMIN TRADES ERROR:",
                error
            );


            res
                .status(500)
                .json({

                    success: false,

                    error:
                        "Unable to load trades"

                });

        }

    }
);


/* =========================================================
   ADMIN APPROVE TRADE
========================================================= */

app.post(
    "/api/admin/trades/:id/approve",
    requireAdmin,
    async (
        req,
        res
    ) => {

        try {

            /*
             * IMPORTANT:
             *
             * Approval is allowed only while
             * the 60-second approval window
             * is still open.
             */

            const result =
                await pool.query(
                    `
                    UPDATE trades

                    SET

                        status =
                            'ACTIVE',

                        approved_at =
                            NOW(),

                        trade_expires_at =
                            NOW() +
                            INTERVAL '60 seconds'

                    WHERE

                        id = $1

                    AND

                        status =
                            'PENDING_APPROVAL'

                    AND

                        approval_expires_at >
                            NOW()

                    RETURNING *
                    `,
                    [
                        req.params.id
                    ]
                );


            if (
                result.rows.length === 0
            ) {

                return res
                    .status(409)
                    .json({

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

                trade:
                    result.rows[0]

            });

        }

        catch (error) {

            console.error(
                "APPROVE ERROR:",
                error
            );


            res
                .status(500)
                .json({

                    success: false,

                    error:
                        "Unable to approve trade"

                });

        }

    }
);


/* =========================================================
   ADMIN DECLINE TRADE
========================================================= */

app.post(
    "/api/admin/trades/:id/decline",
    requireAdmin,
    async (
        req,
        res
    ) => {

        try {

            const result =
                await pool.query(
                    `
                    UPDATE trades

                    SET

                        status =
                            'DECLINED',

                        resolution_source =
                            'ADMIN',

                        resolved_at =
                            NOW()

                    WHERE

                        id = $1

                    AND

                        status =
                            'PENDING_APPROVAL'

                    RETURNING *
                    `,
                    [
                        req.params.id
                    ]
                );


            if (
                result.rows.length === 0
            ) {

                return res
                    .status(409)
                    .json({

                        success: false,

                        error:
                            "Trade is no longer waiting for approval."

                    });

            }


            res.json({

                success: true,

                trade:
                    result.rows[0]

            });

        }

        catch (error) {

            console.error(
                "DECLINE ERROR:",
                error
            );


            res
                .status(500)
                .json({

                    success: false,

                    error:
                        "Unable to decline trade"

                });

        }

    }
);


/* =========================================================
   ADMIN SELECT WIN / LOSS
========================================================= */

app.post(
    "/api/admin/trades/:id/resolve",
    requireAdmin,
    async (req, res) => {

        try {

            const selectedResult =
                String(
                    req.body.result || ""
                ).trim().toUpperCase();


            console.log(
                "Admin selecting result:",
                req.params.id,
                selectedResult
            );


            if (
                selectedResult !== "WIN" &&
                selectedResult !== "LOSS"
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Result must be WIN or LOSS"

                });

            }


            /*
             * Check that the trade exists.
             */

            const existing =
                await pool.query(
                    `
                    SELECT
                        id,
                        status,
                        pending_result
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

                    success: false,

                    error:
                        "Trade not found"

                });

            }


            const trade =
                existing.rows[0];


            console.log(
                "Current trade status:",
                trade.status
            );


            /*
             * Result can only be selected
             * after administrator approved
             * the trade.
             */

            if (
                trade.status !== "ACTIVE"
            ) {

                return res.status(409).json({

                    success: false,

                    error:
                        `Trade is currently ${trade.status}. ` +
                        `Only ACTIVE trades can receive a result.`

                });

            }


            /*
             * Do NOT change status to WIN/LOSS.
             *
             * We only store the selected result.
             */

            const result =
                await pool.query(
                    `
                    UPDATE trades

                    SET

                        pending_result = $1,

                        pending_result_source =
                            'ADMIN'

                    WHERE

                        id = $2

                    AND

                        status = 'ACTIVE'

                    RETURNING *
                    `,
                    [
                        selectedResult,
                        req.params.id
                    ]
                );


            if (
                result.rows.length === 0
            ) {

                return res.status(409).json({

                    success: false,

                    error:
                        "Trade is no longer active."

                });

            }


            console.log(
                "Result successfully stored:",
                selectedResult
            );


            return res.json({

                success: true,

                waitingForExpiry: true,

                message:
                    `Result ${selectedResult} selected. ` +
                    `It will be revealed when the timer expires.`,

                trade:
                    result.rows[0]

            });

        }

        catch (error) {

            console.error(
                "================================"
            );

            console.error(
                "SELECT RESULT DATABASE ERROR"
            );

            console.error(
                error
            );

            console.error(
                "================================"
            );


            return res.status(500).json({

                success: false,

                error:
                    "Unable to select result",

                details:
                    error.message

            });

        }

    }
);
/* =========================================================
   AUTO DECLINE PENDING APPROVALS
========================================================= */

async function processApprovalTimeouts() {

    try {

        const result =
            await pool.query(
                `
                UPDATE trades

                SET

                    status =
                        'DECLINED',

                    resolution_source =
                        'AUTO',

                    resolved_at =
                        NOW()

                WHERE

                    status =
                        'PENDING_APPROVAL'

                AND

                    approval_expires_at <=
                        NOW()

                RETURNING id
                `
            );


        if (
            result.rows.length > 0
        ) {

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
   RESOLVE ACTIVE TRADES ONLY AFTER TIMER
========================================================= */

async function processActiveTrades() {

    try {

        const result =
            await pool.query(
                `
                SELECT *

                FROM trades

                WHERE

                    status =
                        'ACTIVE'

                AND

                    trade_expires_at <=
                        NOW()

                LIMIT 100
                `
            );


        for (
            const trade
            of result.rows
        ) {

            /*
             * If admin selected WIN or LOSS,
             * use that result.
             *
             * Otherwise create a demo-only
             * automatic result.
             */

            let finalResult;

            let source;


            if (
                trade.pending_result ===
                "WIN" ||
                trade.pending_result ===
                "LOSS"
            ) {

                finalResult =
                    trade.pending_result;

                source =
                    "ADMIN";

            }

            else {

                finalResult =
                    Math.random() >= 0.5
                        ? "WIN"
                        : "LOSS";

                source =
                    "AUTO";

            }


            const payout =
                calculatePayout(
                    trade.amount,
                    finalResult
                );


            /*
             * ONLY NOW does the trade
             * change from ACTIVE to WIN/LOSS.
             */

            await pool.query(
                `
                UPDATE trades

                SET

                    status =
                        $1,

                    resolved_at =
                        NOW(),

                    resolution_source =
                        $2,

                    demo_return =
                        $3,

                    demo_profit =
                        $4

                WHERE

                    id = $5

                AND

                    status =
                        'ACTIVE'
                `,
                [

                    finalResult,

                    source,

                    payout.totalReturn,

                    payout.profit,

                    trade.id

                ]
            );


            console.log(
                "Trade timer finished:",
                trade.id,
                finalResult
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
   HEALTH CHECK
========================================================= */

app.get(
    "/api/health",
    async (
        req,
        res
    ) => {

        try {

            await pool.query(
                "SELECT 1"
            );


            res.json({

                status:
                    "ok",

                database:
                    "connected",

                demo:
                    true

            });

        }

        catch (error) {

            res
                .status(500)
                .json({

                    status:
                        "error",

                    database:
                        "disconnected"

                });

        }

    }
);


/* =========================================================
   FRONTEND ROUTES
========================================================= */

app.get(
    "/",
    (
        req,
        res
    ) => {

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
    (
        req,
        res
    ) => {

        res.sendFile(
            path.join(
                __dirname,
                "public",
                "admin.html"
            )
        );

    }
);


/* =========================================================
   START SERVER
========================================================= */

async function start() {

    try {

        await setupDatabase();


        /*
         * Check expired approval requests
         * every second.
         */

        setInterval(
            processApprovalTimeouts,
            1000
        );


        /*
         * Check expired active trades
         * every second.
         */

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
