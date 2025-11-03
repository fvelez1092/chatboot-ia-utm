import "dotenv/config";
import express from "express";
import cors from "cors";
import logger from "./logger.js";
import { initWA } from "./wa.js";
import { errorHandler } from "./middlewares/error.js";

const { PORT = 5005 } = process.env;

const app = express();
app.use(cors());
app.use(express.json());

let wa = null;
async function start() {
    wa = await initWA(start);
}

app.get("/", (_req, res) => res.json({ ok: true, service: "whatsapp-relay" }));

// Health con info básica
app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        service: "whatsapp-relay",
        waOnline: Boolean(wa),
        ts: new Date().toISOString(),
    });
});

// Enviar mensaje manualmente via REST
app.post("/api/send-text", async (req, res, next) => {
    try {
        const { to, body } = req.body || {};
        if (!to || !body) throw new Error("Campos requeridos: to, body");
        if (!wa) throw new Error("WA no inicializado");

        await wa.sendText(to, body);
        return res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// Manejo de errores
app.use(errorHandler);

app.listen(PORT, async () => {
    logger.info(`[WA Relay] HTTP ON : http://localhost:${PORT}`);
    try {
        await start(); // inicia Open-WA y espera QR si no hay sesión
        logger.info("Open-WA listo. Si es la primera vez, mira la consola para escanear el QR.");
    } catch (e) {
        logger.error({ err: e.message }, "Failed to start Open-WA");
    }
});

// Apagado elegante
process.on("SIGINT", () => {
    logger.warn("Recibido SIGINT. Cerrando...");
    process.exit(0);
});
process.on("SIGTERM", () => {
    logger.warn("Recibido SIGTERM. Cerrando...");
    process.exit(0);
});