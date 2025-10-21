import { ENABLE_EXPONENTIAL_BACKOFF } from "../env";

const baseTimeout = 60_000;

const maximumTimeout = 600_000;

const ratio = 2;
export const calculateForRateLimit = (attempt: number): number => {
    if (!ENABLE_EXPONENTIAL_BACKOFF) {
        return baseTimeout;
    }

    const timeout = ratio * attempt * baseTimeout + baseTimeout;

    return timeout > maximumTimeout
        ? maximumTimeout
        : timeout;
}
