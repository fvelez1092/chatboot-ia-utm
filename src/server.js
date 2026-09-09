import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import jwt from "jsonwebtoken";
import logger from "./logger.js";
import { getWAStatus, getLatestQR, initWA, markDisconnected } from "./wa.js";
import { errorHandler } from "./middlewares/error.js";

const {
    HOST = "0.0.0.0",
    PORT = 5005,
    FRONTEND_ORIGINS = "http://localhost:5173,http://localhost:3000",
    JWT_PUBLIC_KEY,
    JWT_PUBLIC_KEY_PATH,
    AUTO_START = "false",
} = process.env;

const allowedOrigins = FRONTEND_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const app = express();
app.disable("x-powered-by");
app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        const error = new Error("Origen no permitido por CORS");
        error.status = 403;
        return callback(error);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "100kb" }));

let wa = null;
let waStartPromise = null;

function readPublicKey() {
    if (JWT_PUBLIC_KEY) return JWT_PUBLIC_KEY.replace(/\\n/g, "\n");
    if (JWT_PUBLIC_KEY_PATH) return fs.readFileSync(JWT_PUBLIC_KEY_PATH, "utf8");
    throw new Error("Configure JWT_PUBLIC_KEY o JWT_PUBLIC_KEY_PATH");
}

function adminRequired(req, _res, next) {
    try {
        const header = req.get("Authorization") || "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!token) {
            const error = new Error("Token de acceso requerido");
            error.status = 401;
            throw error;
        }
        const claims = jwt.verify(token, readPublicKey(), { algorithms: ["RS256"] });
        if (claims.role !== "admin") {
            const error = new Error("Se requieren permisos de administrador");
            error.status = 403;
            throw error;
        }
        req.auth = claims;
        return next();
    } catch (error) {
        if (!error.status) error.status = 401;
        return next(error);
    }
}

function startWA() {
    if (wa) return Promise.resolve(wa);
    if (waStartPromise) return waStartPromise;

    waStartPromise = initWA(async () => {
        wa = null;
        waStartPromise = null;
        try {
            await startWA();
        } catch (error) {
            logger.error({ err: error.message }, "No se pudo reiniciar Open-WA");
        }
    })
        .then((instance) => {
            wa = instance;
            return instance;
        })
        .finally(() => {
            waStartPromise = null;
        });

    return waStartPromise;
}

function normalizeChatId(value) {
    const raw = String(value || "").trim();
    if (/^\d+@(c|g)\.us$/.test(raw)) return raw;

    const digits = raw.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return null;
    return `${digits}@c.us`;
}

app.get("/", (_req, res) => res.json({
    ok: true,
    service: "whatsapp-relay",
    api: "/api/whatsapp/status",
}));

app.get("/health", (_req, res) => {
    const whatsapp = getWAStatus();
    res.json({
        ok: true,
        service: "whatsapp-relay",
        waOnline: whatsapp.status === "connected",
        whatsapp,
        ts: new Date().toISOString(),
    });
});

app.use("/api", adminRequired);

app.get("/api/whatsapp/status", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, data: getWAStatus() });
});

app.get("/api/whatsapp/qr", (_req, res) => {
    res.set("Cache-Control", "no-store");
    const qr = getLatestQR();
    if (!qr) {
        return res.status(404).json({
            ok: false,
            error: "No hay un código QR disponible",
            data: getWAStatus(),
        });
    }
    return res.json({ ok: true, data: { qr } });
});

app.post("/api/whatsapp/connect", (_req, res) => {
    const status = getWAStatus();
    if (status.status === "connected") {
        return res.json({ ok: true, data: status });
    }

    void startWA().catch((error) => {
        logger.error({ err: error.message }, "No se pudo iniciar Open-WA");
    });

    return res.status(202).json({
        ok: true,
        message: "Conexión de WhatsApp iniciada",
        data: getWAStatus(),
    });
});

app.post("/api/whatsapp/disconnect", async (_req, res, next) => {
    try {
        if (wa?.client) {
            await wa.client.logout();
            await wa.client.kill();
        }
        wa = null;
        waStartPromise = null;
        markDisconnected();
        return res.json({ ok: true, data: getWAStatus() });
    } catch (error) {
        return next(error);
    }
});

app.post("/api/send-text", async (req, res, next) => {
    try {
        const { to, body } = req.body || {};
        const chatId = normalizeChatId(to);
        const message = typeof body === "string" ? body.trim() : "";

        if (!chatId || !message) {
            const error = new Error("Campos requeridos: to (teléfono válido) y body");
            error.status = 400;
            throw error;
        }
        if (message.length > 4096) {
            const error = new Error("El mensaje supera el máximo de 4096 caracteres");
            error.status = 400;
            throw error;
        }
        if (!wa) {
            const error = new Error("WhatsApp todavía no está conectado");
            error.status = 503;
            throw error;
        }

        await wa.sendText(chatId, message);
        return res.json({ ok: true, data: { to: chatId } });
    } catch (err) {
        return next(err);
    }
});

app.use((_req, res) => res.status(404).json({ ok: false, error: "Ruta no encontrada" }));
app.use(errorHandler);

app.listen(Number(PORT), HOST, () => {
    logger.info(`[WA Relay] HTTP ON: http://${HOST}:${PORT}`);
    if (AUTO_START === "true") {
        void startWA().catch((error) => {
            logger.error({ err: error.message }, "Failed to start Open-WA");
        });
    }
});

process.on("SIGINT", () => {
    logger.warn("Recibido SIGINT. Cerrando...");
    process.exit(0);
});
process.on("SIGTERM", () => {
    logger.warn("Recibido SIGTERM. Cerrando...");
    process.exit(0);
});
