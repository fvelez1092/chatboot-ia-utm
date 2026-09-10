import axios from "axios";
import logger from "./logger.js";

const {
    AGENT_URL = "http://localhost:5000/rag/ask",
    AGENT_LOGIN_URL = "http://localhost:5000/auth/login",
    AGENT_USERNAME,
    AGENT_PASSWORD,
    AGENT_AUTH_ENABLED = "false",
    AGENT_TIMEOUT_MS = 600000,
    RETRY_ATTEMPTS = 2,
    RETRY_BASE_MS = 5000,
} = process.env;

const authEnabled = AGENT_AUTH_ENABLED.toLowerCase() === "true";
let accessToken = null;

async function authenticate() {
    if (!AGENT_USERNAME || !AGENT_PASSWORD) {
        throw new Error("Configure AGENT_USERNAME y AGENT_PASSWORD para consultar el RAG");
    }
    const response = await axios.post(
        AGENT_LOGIN_URL,
        { username: AGENT_USERNAME, password: AGENT_PASSWORD },
        { timeout: 30_000 },
    );
    const token = response.data?.data?.auth?.access_token;
    if (!token) throw new Error("El backend no devolvió un token de acceso");
    accessToken = token;
    return token;
}

function postQuestion(payload, token = null) {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    return axios.post(AGENT_URL, payload, {
        timeout: Number(AGENT_TIMEOUT_MS),
        ...(headers ? { headers } : {}),
    });
}

async function callOnce(question, nContext = 4) {
    const payload = { question, n_context: String(nContext) };
    let res;

    if (!authEnabled) {
        res = await postQuestion(payload);
    } else {
        const token = accessToken || await authenticate();
        try {
            res = await postQuestion(payload, token);
        } catch (error) {
            if (error.response?.status !== 401) throw error;
            accessToken = null;
            res = await postQuestion(payload, await authenticate());
        }
    }

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
            const wait = Number(RETRY_BASE_MS) * (attempt + 1);
            logger.error(
                { err: err?.response?.data || err.message, attempt, wait },
                "Agent error",
            );
            if (attempt === Number(RETRY_ATTEMPTS)) break;
            await new Promise((resolve) => setTimeout(resolve, wait));
            attempt++;
        }
    }

    throw new Error(lastErr?.message || "Agent unreachable");
}
