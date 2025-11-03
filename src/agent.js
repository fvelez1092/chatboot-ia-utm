import axios from "axios";
import logger from "./logger.js";

const {
    AGENT_URL = "http://localhost:5000/rag/ask",
    AGENT_TIMEOUT_MS = 600000,
    RETRY_ATTEMPTS = 2,
    RETRY_BASE_MS = 5000,
} = process.env;

async function callOnce(question, nContext = 4) {
    const payload = { question, n_context: String(nContext) };
    const res = await axios.post(AGENT_URL, payload, { timeout: Number(AGENT_TIMEOUT_MS) });
    // Estructura que nos mostraste:
    // { status: "success", data: { answer: "...", sources: [...] } }
    const ok = res.data?.status === "success";
    const answer = res.data?.data?.answer;
    if (!ok || !answer) {
        const errMsg = `Respuesta inválida del agente: ${JSON.stringify(res.data).slice(0, 500)}`;
        throw new Error(errMsg);
    }
    return answer.toString().trim();
}

export async function askAgent(question, { nContext = 4 } = {}) {
    let attempt = 0;
    let lastErr = null;

    while (attempt <= Number(RETRY_ATTEMPTS)) {
        try {
            return await callOnce(question, nContext);
        } catch (err) {
            lastErr = err;
            const wait = (Number(RETRY_BASE_MS) * (attempt + 1));
            logger.error({ err: err?.response?.data || err.message, attempt, wait }, "Agent error");
            if (attempt === Number(RETRY_ATTEMPTS)) break;
            await new Promise(r => setTimeout(r, wait));
            attempt++;
        }
    }

    throw new Error(lastErr?.message || "Agent unreachable");
}