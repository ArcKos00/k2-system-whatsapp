import dotenv from 'dotenv';
import apm from 'elastic-apm-node';

// dotenv must run here too: this module is imported before config/env.ts, so
// the .env file used for local development isn't loaded yet. dotenv.config()
// is idempotent and won't override variables already set by the orchestrator
// (Aspire / Kubernetes), so it's safe to call again from config/env.ts.
dotenv.config();

// Only start the agent when an APM server is configured (or it was explicitly
// activated). Calling apm.start() without a server URL would make the agent
// repeatedly try to reach the default http://127.0.0.1:8200 and log errors,
// which is noise for local runs that don't have an APM server. This mirrors
// the ELASTIC_APM_ACTIVE flag set by the Aspire AppHost.
const explicitlyActive = (process.env.ELASTIC_APM_ACTIVE ?? '').toLowerCase() === 'true';
const hasServerUrl = !!(process.env.ELASTIC_APM_SERVER_URL ?? '').trim();

if ((explicitlyActive || hasServerUrl) && !apm.isStarted()) {
  // All other options (server URL, environment, capture settings, labels, …)
  // are read from ELASTIC_APM_* environment variables provided by the AppHost
  // (see ElasticServiceExtensions.AddElasticApmNodeConfig) or .env locally.
  apm.start({
    serviceName: process.env.ELASTIC_APM_SERVICE_NAME || 'whatsapp-api',
    environment: process.env.ELASTIC_APM_ENVIRONMENT || process.env.NODE_ENV || 'development',
  });
}

export default apm;
