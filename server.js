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


/* =====================================================
   DATABASE
===================================================== */

if (!DATABASE_URL) {

    console.error(
        "DATABASE_URL environment variable is missing."
    );

    process.exit(1);
}


const pool = new Pool({

    connectionString: DATABASE_URL,

    ssl: {
        rejectUnauthorized: false
    }

});


/* =====================================================
   EXPRESS
===================================================== */

app.use(
    express.json()
);

app.use(
    express.urlencoded({
        extended: true
    })
);

app.use(
    express.static(
        path.join(
            __dirname,
            "public"
        )
    )
);


/* =====================================================
   ALLOWED MARKETS
===================================================== */

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


/* =====================================================
   DATABASE INITIALIZATION
===================================================== */

async function initializeDatabase() {

    // DEMO DATABASE RESET
    // This deletes old demo trades so the new schema
    // can be created cleanly.

    await pool.query(`
        DROP TABLE IF EXISTS trades;
    `);

    await pool.query(`
        CREATE TABLE trades (

            id UUID PRIMARY KEY,

            market VARCHAR(30) NOT NULL,

            direction VARCHAR(10) NOT NULL,

            amount NUMERIC(18,2) NOT NULL,

            status VARCHAR(30) NOT NULL
                DEFAULT 'PENDING_APPROVAL',

            resolution_source VARCHAR(20),

            created_at TIMESTAMPTZ NOT NULL
                DEFAULT NOW(),

            approval_expires_at TIMESTAMPTZ NOT NULL,

            approved_at TIMESTAMPTZ,

            trade_expires_at TIMESTAMPTZ,

            resolved_at TIMESTAMPTZ,

            start_price NUMERIC(30,12),

            demo_return NUMERIC(18,2)
                DEFAULT 0,

            demo_profit NUMERIC(18,2)
                DEFAULT 0

        );
    `);

    await pool.query(`
        CREATE INDEX trades_status_idx
        ON trades(status);
    `);

    await pool.query(`
        CREATE INDEX trades_created_at_idx
        ON trades(created_at DESC);
    `);

    console.log(
        "Fresh NovaTrade demo database initialized."
    );
}
    /*
     * If the table already existed from your
     * previous version, add the new columns.
     */

    await pool.query(`

        ALTER TABLE trades

        ADD COLUMN IF NOT EXISTS
        approval_expires_at
        TIMESTAMPTZ;

    `);


    await pool.query(`

        ALTER TABLE trades

        ADD COLUMN IF NOT EXISTS
        approved_at
        TIMESTAMPTZ;

    `);


    await pool.query(`

        ALTER TABLE trades

        ADD COLUMN IF NOT EXISTS
        trade_expires_at
        TIMESTAMPTZ;

    `);


    await pool.query(`

        ALTER TABLE trades

        ADD COLUMN IF NOT EXISTS
        resolution_source
        VARCHAR(20);

    `);


    await pool.query(`

        ALTER TABLE trades

        ADD COLUMN IF NOT EXISTS
        demo_return
        NUMERIC(18,2)
        DEFAULT 0;

    `);


    await pool.query(`

        ALTER TABLE trades

        ADD COLUMN IF NOT EXISTS
        demo_profit
        NUMERIC(18,2)
        DEFAULT 0;

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


/* =====================================================
   PAYOUT CALCULATION
===================================================== */

function calculatePayout(
    amount,
    status
) {

    amount =
        Number(amount);


    if (
        status !== "WIN"
    ) {

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


/* =====================================================
   ADMIN AUTH
===================================================== */

function adminAuth(
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

                error:
                    "Unauthorized."

            });

    }


    next();

}


/* =====================================================
   CREATE DEMO TRADE
===================================================== */

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


            /*
             * Validate market.
             */

            if (
                !ALLOWED_MARKETS.includes(
                    market
                )
            ) {

                return res
                    .status(400)
                    .json({

                        error:
                            "Invalid market."

                    });

            }


            /*
             * Validate direction.
             */

            if (
                !ALLOWED_DIRECTIONS.includes(
                    direction
                )
            ) {

                return res
                    .status(400)
                    .json({

                        error:
                            "Invalid direction."

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

                return res
                    .status(400)
                    .json({

                        error:
                            "Invalid demo amount."

                    });

            }


            /*
             * Create a new trade.
             */

            const id =
                crypto.randomUUID();


            const createdAt =
                new Date();


            /*
             * ADMIN APPROVAL WINDOW
             *
             * The admin has 60 seconds
             * to approve the request.
             */

            const approvalExpiresAt =
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

                        approval_expires_at,

                        start_price

                    )

                    VALUES

                    (

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

                    error:
                        "Unable to create demo trade."

                });

        }

    }
);


/* =====================================================
   GET SINGLE TRADE
===================================================== */

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

                        error:
                            "Trade not found."

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
                error
            );


            res
                .status(500)
                .json({

                    error:
                        "Unable to retrieve trade."

                });

        }

    }
);


/* =====================================================
   ADMIN LOGIN
===================================================== */

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

                    success:
                        false,

                    error:
                        "Invalid password."

                });

        }


        res.json({

            success:
                true

        });

    }
);


/* =====================================================
   ADMIN GET ALL TRADES
===================================================== */

app.get(
    "/api/admin/trades",
    adminAuth,
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

                success:
                    true,

                trades:
                    result.rows

            });

        }

        catch (error) {

            console.error(
                error
            );


            res
                .status(500)
                .json({

                    error:
                        "Unable to retrieve trades."

                });

        }

    }
);


/* =====================================================
   ADMIN APPROVE TRADE
===================================================== */

app.post(
    "/api/admin/trades/:id/approve",
    adminAuth,
    async (
        req,
        res
    ) => {

        try {

            /*
             * We only approve trades that are
             * currently waiting for approval.
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

                        error:
                            "Trade is no longer awaiting approval or the approval window has expired."

                    });

            }


            res.json({

                success:
                    true,

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

                    error:
                        "Unable to approve trade."

                });

        }

    }
);


/* =====================================================
   ADMIN MANUAL DECLINE
===================================================== */

app.post(
    "/api/admin/trades/:id/decline",
    adminAuth,
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

                        error:
                            "Trade is no longer awaiting approval."

                    });

            }


            res.json({

                success:
                    true,

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

                    error:
                        "Unable to decline trade."

                });

        }

    }
);


/* =====================================================
   ADMIN RESOLVE ACTIVE TRADE
===================================================== */

app.post(
    "/api/admin/trades/:id/resolve",
    adminAuth,
    async (
        req,
        res
    ) => {

        try {

            const requestedResult =
                String(
                    req.body.result || ""
                ).toUpperCase();


            if (
                ![
                    "WIN",
                    "LOSS"
                ].includes(
                    requestedResult
                )
            ) {

                return res
                    .status(400)
                    .json({

                        error:
                            "Result must be WIN or LOSS."

                    });

            }


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

                return res
                    .status(404)
                    .json({

                        error:
                            "Trade not found."

                    });

            }


            const trade =
                existing.rows[0];


            /*
             * Only ACTIVE trades can
             * receive a manual WIN/LOSS.
             */

            if (
                trade.status !==
                "ACTIVE"
            ) {

                return res
                    .status(409)
                    .json({

                        error:
                            "Only active trades can be resolved."

                    });

            }


            const payout =
                calculatePayout(

                    trade.amount,

                    requestedResult

                );


            const result =
                await pool.query(

                    `

                    UPDATE trades

                    SET

                        status = $1,

                        resolution_source =
                            'ADMIN',

                        resolved_at =
                            NOW(),

                        demo_return =
                            $2,

                        demo_profit =
                            $3

                    WHERE

                        id = $4

                    AND

                        status =
                            'ACTIVE'

                    RETURNING *

                    `,

                    [

                        requestedResult,

                        payout.totalReturn,

                        payout.profit,

                        req.params.id

                    ]

                );


            if (
                result.rows.length === 0
            ) {

                return res
                    .status(409)
                    .json({

                        error:
                            "Trade was already resolved."

                    });

            }


            res.json({

                success:
                    true,

                trade:
                    result.rows[0]

            });

        }

        catch (error) {

            console.error(
                "RESOLVE ERROR:",
                error
            );


            res
                .status(500)
                .json({

                    error:
                        "Unable to resolve trade."

                });

        }

    }
);


/* =====================================================
   AUTO DECLINE UNAPPROVED TRADES
===================================================== */

async function automaticallyDeclineTrades() {

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

                `Automatically declined ${result.rows.length} trade(s).`

            );

        }

    }

    catch (error) {

        console.error(
            "AUTO DECLINE ERROR:",
            error
        );

    }

}


/* =====================================================
   AUTO RESOLVE ACTIVE TRADES
===================================================== */

async function automaticallyResolveTrades() {

    try {

        /*
         * Only ACTIVE trades are resolved here.
         *
         * PENDING_APPROVAL trades are handled
         * separately above.
         */

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
             * Demo-only automatic result.
             */

            const status =
                Math.random() >= 0.5
                    ? "WIN"
                    : "LOSS";


            const payout =
                calculatePayout(

                    trade.amount,

                    status

                );


            await pool.query(

                `

                UPDATE trades

                SET

                    status = $1,

                    resolution_source =
                        'AUTO',

                    resolved_at =
                        NOW(),

                    demo_return =
                        $2,

                    demo_profit =
                        $3

                WHERE

                    id = $4

                AND

                    status =
                        'ACTIVE'

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


/* =====================================================
   HEALTH CHECK
===================================================== */

app.get(
    "/api/health",
    (
        req,
        res
    ) => {

        res.json({

            status:
                "ok",

            demo:
                true

        });

    }
);


/* =====================================================
   FRONTEND ROUTES
===================================================== */

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


/* =====================================================
   START SERVER
===================================================== */

async function startServer() {

    try {

        await initializeDatabase();


        /*
         * Check every second.
         */

        setInterval(

            automaticallyDeclineTrades,

            1000

        );


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
