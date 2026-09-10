import whatsappWeb from "whatsapp-web.js";
import QRCode from "qrcode";
import path from "path";
import logger from "./logger.js";
import { askAgent } from "./agent.js";

const { Client, LocalAuth } = whatsappWeb;

const {
    SESSION_ID = "AGENTE_IA",
    SESSIONS_DIR = ".sessions",
    HEADLESS = "true",
    IGNORE_GROUPS = "true",
    CHROME_EXECUTABLE_PATH,
    PUPPETEER_NO_SANDBOX = "false",
} = process.env;

const runtime = {
    status: "idle",
    rawState: null,
    qr: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
};

let activeClient = null;

function updateRuntime(values) {
    Object.assign(runtime, values, { updatedAt: new Date().toISOString() });
}

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

export function markDisconnected() {
    updateRuntime({
        status: "idle",
        rawState: null,
        qr: null,
        lastError: null,
    });
}

function buildPuppeteerOptions() {
    const options = { headless: HEADLESS === "true" };
    if (CHROME_EXECUTABLE_PATH) options.executablePath = CHROME_EXECUTABLE_PATH;
    if (PUPPETEER_NO_SANDBOX === "true") {
        options.args = ["--no-sandbox", "--disable-setuid-sandbox"];
    }
    return options;
}

export async function initWA(onDisconnected) {
    if (activeClient) {
        const existingClient = activeClient;
        return {
            client: existingClient,
            sendText(to, text) {
                return existingClient.sendMessage(to, text);
            },
        };
    }

    updateRuntime({
        status: "initializing",
        rawState: "INITIALIZING",
        qr: null,
        lastError: null,
    });

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: SESSION_ID,
            dataPath: path.resolve(SESSIONS_DIR),
        }),
        puppeteer: buildPuppeteerOptions(),
    });
    activeClient = client;

    client.on("qr", async (qrCode) => {
        updateRuntime({
            status: "waiting_qr",
            rawState: "QR_RECEIVED",
            qr: null,
            lastError: null,
        });
        try {
            const dataUrl = await QRCode.toDataURL(qrCode, {
                errorCorrectionLevel: "M",
                margin: 2,
                width: 320,
            });
            if (activeClient === client) updateRuntime({ qr: dataUrl });
        } catch (error) {
            logger.error({ err: error.message }, "No se pudo generar la imagen QR");
            updateRuntime({ status: "error", lastError: error.message });
        }
    });

    client.on("authenticated", () => {
        updateRuntime({
            status: "authenticated",
            rawState: "AUTHENTICATED",
            qr: null,
            lastError: null,
        });
    });

    client.on("ready", () => {
        updateRuntime({
            status: "connected",
            rawState: "READY",
            qr: null,
            lastError: null,
        });
        logger.info("whatsapp-web.js conectado y listo");
    });

    client.on("loading_screen", (percent) => {
        if (runtime.status !== "connected") {
            updateRuntime({
                status: "initializing",
                rawState: `LOADING_${percent}`,
            });
        }
    });

    client.on("change_state", (state) => {
        logger.info({ state }, "WhatsApp state changed");
        if (state === "CONNECTED") {
            updateRuntime({ status: "connected", rawState: state, qr: null });
        } else {
            updateRuntime({ rawState: state });
        }
    });

    client.on("auth_failure", async (message) => {
        if (activeClient === client) activeClient = null;
        updateRuntime({
            status: "error",
            rawState: "AUTH_FAILURE",
            qr: null,
            lastError: String(message),
        });
        logger.error({ err: message }, "Falló la autenticación de WhatsApp");
        try {
            await client.destroy();
        } catch {
            // El navegador puede haberse cerrado durante el fallo.
        }
        if (typeof onDisconnected === "function") onDisconnected("AUTH_FAILURE");
    });

    client.on("disconnected", (reason) => {
        if (activeClient === client) activeClient = null;
        updateRuntime({
            status: "disconnected",
            rawState: "DISCONNECTED",
            qr: null,
            lastError: reason ? String(reason) : null,
        });
        logger.warn({ reason }, "WhatsApp desconectado");
        if (typeof onDisconnected === "function") onDisconnected(reason);
    });

    client.on("message", async (message) => {
        try {
            if (message.fromMe) return;
            if (message.from.endsWith("@g.us") && IGNORE_GROUPS === "true") return;

            const chatId = message.from;
            const bodyRaw = (message.body || "").trim();
            const lower = bodyRaw.toLowerCase();
            if (!bodyRaw) return;

            const isGreeting = /^(hola|buenas|buenos dias|buenos días|buenas tardes|buenas noches|hi|hello)\b/.test(lower);
            if (isGreeting) {
                await client.sendMessage(chatId, "¡Hola! Soy tu asistente de IA 🤖. Estoy listo para ayudarte.");
                return;
            }

            await client.sendMessage(
                chatId,
                "✅ Recibí tu consulta. Estoy procesándola con el motor de IA; esto puede tardar unos minutos…",
            );

            let answer = await askAgent(bodyRaw, { nContext: 4 });
            if (!answer || /^no lo sé\.?$/i.test(answer)) {
                answer = "No encontré esa información en la base de conocimiento. ¿Puedes darme más detalle o reformular la consulta?";
            }

            await client.sendMessage(chatId, answer);
        } catch (error) {
            logger.error({ err: error?.response?.data || error.message }, "message error");
            try {
                await client.sendMessage(
                    message.from,
                    "⚠️ Ocurrió un error consultando el servidor de IA. Intenta nuevamente más tarde.",
                );
            } catch {
                // El cliente también puede estar desconectado.
            }
        }
    });

    try {
        await client.initialize();
        return {
            client,
            sendText(to, text) {
                return client.sendMessage(to, text);
            },
        };
    } catch (error) {
        if (activeClient === client) activeClient = null;
        try {
            await client.destroy();
        } catch {
            // La inicialización pudo fallar antes de abrir el navegador.
        }
        updateRuntime({
            status: "error",
            rawState: "INITIALIZATION_ERROR",
            qr: null,
            lastError: error.message,
        });
        throw error;
    }
}

export async function disconnectWA({ logout = true } = {}) {
    const client = activeClient;
    activeClient = null;

    if (client) {
        if (logout) {
            try {
                await client.logout();
            } catch (error) {
                logger.warn({ err: error.message }, "No se pudo cerrar la sesión remota");
            }
        }
        try {
            await client.destroy();
        } catch (error) {
            logger.warn({ err: error.message }, "No se pudo destruir el cliente de WhatsApp");
        }
    }

    markDisconnected();
}
