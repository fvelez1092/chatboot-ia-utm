import { create } from "@open-wa/wa-automate";
import fs from "fs";
import path from "path";
import logger from "./logger.js";
import { askAgent } from "./agent.js";

const {
    SESSION_ID = "AGENTE_IA",
    SESSIONS_DIR = ".sessions",
    HEADLESS = "true",
    IGNORE_GROUPS = "true",
} = process.env;

export async function initWA(startCallback) {
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

    const options = {
        sessionId: SESSION_ID,
        sessionDataPath: path.resolve(SESSIONS_DIR),
        multiDevice: true,
        headless: HEADLESS === "true",
        useChrome: true,
        killProcessOnBrowserClose: false,
        authTimeout: 60,
        qrTimeout: 0,
        disableSpins: true,
        cacheEnabled: false,
        restartOnCrash: startCallback,
    };

    const client = await create(options);

    client.onStateChanged((state) => {
        logger.info({ state }, "WA state changed");
        if (["CONFLICT", "UNLAUNCHED"].includes(state)) client.forceRefocus();
    });

    client.onMessage(async (message) => {
        try {
            // 1) Ignorar mensajes propios y de grupos (si se configuró)
            if (message.fromMe) return;

            if (message.isGroupMsg && IGNORE_GROUPS === "true") {
                // opcional: sólo responde si te mencionan; si no, sal del handler
                return;
            }

            const chatId = message.from;
            const bodyRaw = (message.body || "").trim();
            const lower = bodyRaw.toLowerCase();

            // 2) Saludos rápidos
            const isGreeting = /^(hola|buenas|buenos dias|buenos días|buenas tardes|buenas noches|hi|hello)\b/.test(lower);
            if (isGreeting) {
                await client.sendText(chatId, "¡Hola! Soy tu asistente de IA 🤖. Estoy listo para ayudarte.");
                return;
            }

            // 3) Acuse de recibo INMEDIATO (importante por tiempos 4–10 min)
            await client.sendText(
                chatId,
                "✅ Recibí tu consulta. Estoy procesándolo con el motor de IA; esto puede tardar unos minutos…"
            );

            // 4) Llamada al agente (con reintentos y timeout 10 min)
            let answer = await askAgent(bodyRaw, { nContext: 4 });

            // 5) Fallback si llega “No lo sé”
            if (!answer || /^no lo sé\.?$/i.test(answer)) {
                answer = "No encontré esa información en la base de conocimiento. ¿Puedes darme más detalle o reformular la consulta?";
            }

            // 6) Entregar respuesta final
            await client.sendText(chatId, answer);

        } catch (e) {
            logger.error({ err: e?.response?.data || e.message }, "onMessage error");
            try {
                await client.sendText(
                    message.from,
                    "⚠️ Ocurrió un error consultando el servidor de IA. Intenta nuevamente más tarde."
                );
            } catch { }
        }
    });

    async function sendText(to, text) {
        return client.sendText(to, text);
    }

    return { client, sendText };
}