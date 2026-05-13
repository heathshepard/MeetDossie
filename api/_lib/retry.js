// Retry wrapper for external API calls with exponential backoff
// Usage: await retryFetch(url, options, { maxAttempts: 3, name: 'ElevenLabs' })

/**
 * Retry a fetch call with exponential backoff
 * @param {string} url - The URL to fetch
 * @param {object} options - Fetch options
 * @param {object} config - Retry configuration
 * @param {number} config.maxAttempts - Maximum number of attempts (default: 3)
 * @param {number} config.baseDelay - Base delay in ms (default: 1000)
 * @param {string} config.name - Name of the API for logging
 * @returns {Promise<Response>}
 */
async function retryFetch(url, options = {}, config = {}) {
  const {
    maxAttempts = 3,
    baseDelay = 1000,
    name = 'API',
  } = config;

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[retry] ${name} attempt ${attempt}/${maxAttempts}`);

      const response = await fetch(url, options);

      // If successful, return immediately
      if (response.ok) {
        if (attempt > 1) {
          console.log(`[retry] ${name} succeeded on attempt ${attempt}`);
        }
        return response;
      }

      // Capture error details for non-2xx responses (clone first to preserve body)
      const cloned = response.clone();
      const errorText = await cloned.text().catch(() => '<no body>');
      lastError = {
        status: response.status,
        statusText: response.statusText,
        body: errorText.slice(0, 500),
      };

      console.error(`[retry] ${name} attempt ${attempt} failed:`, response.status, errorText.slice(0, 200));

      // Don't retry on 4xx errors (client errors) except 429 (rate limit)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        console.log(`[retry] ${name} client error ${response.status}, not retrying`);
        return response;
      }

      // If this is the last attempt, return the error response
      if (attempt === maxAttempts) {
        return response;
      }

      // Wait before retrying (exponential backoff)
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`[retry] ${name} waiting ${delay}ms before retry`);
      await new Promise(resolve => setTimeout(resolve, delay));

    } catch (err) {
      // Network or fetch errors
      lastError = {
        error: err.message,
        type: 'network_error',
      };

      console.error(`[retry] ${name} attempt ${attempt} threw:`, err.message);

      if (attempt === maxAttempts) {
        throw new Error(`${name} failed after ${maxAttempts} attempts: ${err.message}`);
      }

      // Wait before retrying
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Should never reach here, but just in case
  throw new Error(`${name} failed after ${maxAttempts} attempts: ${JSON.stringify(lastError)}`);
}

module.exports = { retryFetch };
