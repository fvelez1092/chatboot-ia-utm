import { create, ev } from "@open-wa/wa-automate";
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

const runtime = {
    status: "idle",
    rawState: null,
    qr: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
};

function updateRuntime(values) {
    Object.assign(runtime, values, { updatedAt: new Date().toISOString() });
}

ev.on("qr.**", (qrCode, sessionId) => {
    if (sessionId && sessionId !== SESSION_ID) return;
    updateRuntime({
        status: "waiting_qr",
        qr: qrCode,
        lastError: null,
    });
});

export function getWAStatus() {
    return {
        status: runtime.status,
        rawState: runtime.rawState,
        qrAvailable: Boolean(runtime.qr),
        lastError: runtime.lastError,
        updatedAt: runtime.updatedAt,
    };
}

export function getLatestQR() {
    return runtime.qr;
}

export async function initWA(startCallback) {
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    updateRuntime({ status: "initializing", lastError: null });

    const options = {
        sessionId: SESSION_ID,
        sessionDataPath: path.resolve(SESSIONS_DIR),
        multiDevice: true,
        headless: HEADLESS === "true",
        useChrome: true,
        killProcessOnBrowserClose: false,
        authTimeout: 60,
        qrTimeout: 0,
        qrLogSkip: true,
        disableSpins: true,
        cacheEnabled: false,
        restartOnCrash: startCallback,
    };

    try {
        const client = await create(options);
        updateRuntime({
            status: "connected",
            rawState: "CONNECTED",
            qr: null,
            lastError: null,
        });

        client.onStateChanged((state) => {
            logger.info({ state }, "WA state changed");

            if (state === "CONNECTED") {
                updateRuntime({ status: "connected", rawState: state, qr: null, lastError: null });
                return;
            }
            if (["UNPAIRED", "UNPAIRED_IDLE"].includes(state)) {
                updateRuntime({ status: "waiting_qr", rawState: state });
                return;
            }
            if (["CONFLICT", "UNLAUNCHED"].includes(state)) {
                updateRuntime({ status: "reconnecting", rawState: state });
                client.forceRefocus();
                return;
            }
            updateRuntime({ status: "disconnected", rawState: state });
        });

        client.onMessage(async (message) => {
            try {
                if (message.fromMe) return;
                if (message.isGroupMsg && IGNORE_GROUPS === "true") return;

                const chatId = message.from;
                const bodyRaw = (message.body || "").trim();
                const lower = bodyRaw.toLowerCase();
                if (!bodyRaw) return;

                const isGreeting = /^(hola|buenas|buenos dias|buenos días|buenas tardes|buenas noches|hi|hello)\b/.test(lower);
                if (isGreeting) {
                    await client.sendText(chatId, "¡Hola! Soy tu asistente de IA 🤖. Estoy listo para ayudarte.");
                    return;
                }

                await client.sendText(
                    chatId,
                    "✅ Recibí tu consulta. Estoy procesándola con el motor de IA; esto puede tardar unos minutos…"
                );

                let answer = await askAgent(bodyRaw, { nContext: 4 });
                if (!answer || /^no lo sé\.?$/i.test(answer)) {
                    answer = "No encontré esa información en la base de conocimiento. ¿Puedes darme más detalle o reformular la consulta?";
                }

                await client.sendText(chatId, answer);
            } catch (error) {
                logger.error({ err: error?.response?.data || error.message }, "onMessage error");
                try {
                    await client.sendText(
                        message.from,
                        "⚠️ Ocurrió un error consultando el servidor de IA. Intenta nuevamente más tarde."
                    );
                } catch {
                    // El cliente también puede estar desconectado.
                }
            }
        });

        return {
            client,
            sendText(to, text) {
                return client.sendText(to, text);
            },
        };
    } catch (error) {
        updateRuntime({
            status: "error",
            qr: null,
            lastError: error.message,
        });
        throw error;
    }
}
