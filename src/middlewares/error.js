import logger from "../logger.js";

export function errorHandler(err, req, res, next) {
    logger.error({ err: err.message, stack: err.stack }, "Unhandled error");
    res.status(err.status || 500).json({ ok: false, error: err.message || "Internal error" });
}